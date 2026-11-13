import { Inject, Injectable } from "@nestjs/common";
import type {
  CatalogLanguage,
  GarageReminder,
  GarageReminderCar,
  GarageReminderDoneBody,
  GarageRemindersResponse,
  MaintenanceCatalog,
} from "@adclub/contracts";
import { nextAlmatyDay } from "@adclub/domain";
import { eq, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { accountCar, GarageService } from "../garage";
import { account, type AuthenticatedSession } from "../identity";
import { MaintenanceAnswers } from "../maintenance";
import { AppSettings } from "../settings";
import { ShowcaseService, type Viewer } from "../showcase";
import { ReminderFacts, type CarReminderFacts } from "./reminder-facts";
import { maintenanceReminder } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;

function carNotFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "No such car in this account's garage");
}

function elementNotFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "No such element in the plan of this car");
}

/**
 * What the app and the admin panel are told of reminders (TASK-069;
 * ARCHITECTURE 4.87): the facts and the state of `ReminderFacts`, with, for
 * what is due, «Подобрать» — the answer of the maintenance plan for its rule
 * (`MaintenanceAnswers.catalogsOf`, counted by the client list) in the
 * person's city.
 */
@Injectable()
export class GarageReminders {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(ReminderFacts) private readonly facts: ReminderFacts,
    @Inject(MaintenanceAnswers) private readonly maintenance: MaintenanceAnswers,
    @Inject(ShowcaseService) private readonly showcase: ShowcaseService,
    @Inject(GarageService) private readonly garage: GarageService,
  ) {}

  async list(
    session: AuthenticatedSession,
    lang: CatalogLanguage,
  ): Promise<GarageRemindersResponse> {
    const person = await this.person(session.accountId);
    if (!person.remindersEnabled) return { enabled: false, cars: [] };
    const viewer = await this.showcase.viewer(session);
    const facts = await this.facts.forAccount(session.accountId);
    return {
      enabled: true,
      cars: await Promise.all(
        facts.map((entry) => this.view(entry, { viewer, cityId: person.cityId, lang })),
      ),
    };
  }

  /** «Уже поменял» (D-038): at the current mileage — the corrected one written to the journal first. */
  async done(
    session: AuthenticatedSession,
    carId: string,
    planItemId: string,
    body: GarageReminderDoneBody,
    lang: CatalogLanguage,
  ): Promise<GarageReminderCar> {
    await this.element(session.accountId, carId, planItemId);
    if (body.mileageKm !== undefined) {
      // The way of TASK-058: lower than the last only with `confirmLower` (409 otherwise).
      await this.garage.recordMileage(session.accountId, carId, {
        valueKm: body.mileageKm,
        source: "text",
        ...(body.confirmLower === undefined ? {} : { confirmLower: body.confirmLower }),
      });
    }
    const now = new Date();
    const [entry] = await this.facts.forAccount(session.accountId, { carId, now });
    const km = entry?.state.currentKm ?? null;
    await this.database.db.transaction(async (tx) => {
      const [kept] = await tx
        .select()
        .from(maintenanceReminder)
        .where(
          sql`${maintenanceReminder.carId} = ${carId} AND ${maintenanceReminder.planItemId} = ${planItemId}`,
        )
        .for("update");
      // Pressed twice in a row: one replacement — the same mileage within a day is the same mark.
      if (kept?.doneAt && kept.doneKm === km && now.getTime() - kept.doneAt.getTime() < DAY_MS) {
        return;
      }
      await this.upsert(tx, session.accountId, carId, planItemId, {
        doneKm: km,
        doneAt: now,
        snoozedUntil: null,
        notifiedCycle: null,
      });
    });
    return this.one(session, carId, lang);
  }

  /** «Напомнить позже»: put off for `reminder_snooze_days`; after it — a push again. */
  async snooze(
    session: AuthenticatedSession,
    carId: string,
    planItemId: string,
    lang: CatalogLanguage,
  ): Promise<GarageReminderCar> {
    await this.element(session.accountId, carId, planItemId);
    const days = await this.settings.get("reminder_snooze_days");
    await this.upsert(this.database.db, session.accountId, carId, planItemId, {
      snoozedUntil: new Date(Date.now() + days * DAY_MS),
      notifiedCycle: null,
    });
    return this.one(session, carId, lang);
  }

  /** «Не сейчас» on the mileage question: until the next day in Almaty. */
  async dismissMileageQuestion(
    session: AuthenticatedSession,
    carId: string,
    lang: CatalogLanguage,
  ): Promise<GarageReminderCar> {
    const updated = await this.database.db
      .update(accountCar)
      .set({ mileageQuestionDismissedUntil: nextAlmatyDay(new Date()) })
      .where(sql`${accountCar.id} = ${carId} AND ${accountCar.accountId} = ${session.accountId}`)
      .returning({ id: accountCar.id });
    if (updated.length === 0) throw carNotFound();
    return this.one(session, carId, lang);
  }

  /** The admin panel's view of a user's garage (A-USR-02): to look at, without «Подобрать». */
  async adminView(accountId: string): Promise<GarageReminderCar[]> {
    const facts = await this.facts.forAccount(accountId);
    return Promise.all(facts.map((entry) => this.view(entry, null)));
  }

  private async one(
    session: AuthenticatedSession,
    carId: string,
    lang: CatalogLanguage,
  ): Promise<GarageReminderCar> {
    const person = await this.person(session.accountId);
    const [entry] = await this.facts.forAccount(session.accountId, { carId });
    if (!entry) throw carNotFound();
    const viewer = await this.showcase.viewer(session);
    return this.view(entry, { viewer, cityId: person.cityId, lang });
  }

  private async person(accountId: string) {
    const [row] = await this.database.db
      .select({ remindersEnabled: account.remindersEnabled, cityId: account.cityId })
      .from(account)
      .where(eq(account.id, accountId));
    if (!row) throw new Error("Account of an authenticated session vanished");
    return row;
  }

  /** The car is the caller's and the element is of its active plan — otherwise 404, alike. */
  private async element(accountId: string, carId: string, planItemId: string): Promise<void> {
    const [entry] = await this.facts.forAccount(accountId, { carId });
    if (!entry) throw carNotFound();
    if (!entry.planRows.some((row) => row.id === planItemId)) throw elementNotFound();
  }

  private async upsert(
    executor: DbExecutor,
    accountId: string,
    carId: string,
    planItemId: string,
    values: Partial<typeof maintenanceReminder.$inferInsert>,
  ): Promise<void> {
    await executor
      .insert(maintenanceReminder)
      .values({ accountId, carId, planItemId, ...values })
      .onConflictDoUpdate({
        target: [maintenanceReminder.carId, maintenanceReminder.planItemId],
        set: { ...values, updatedAt: new Date() },
      });
  }

  private async view(
    entry: CarReminderFacts,
    client: { viewer: Viewer; cityId: string | null; lang: CatalogLanguage } | null,
  ): Promise<GarageReminderCar> {
    const lang = client?.lang ?? "ru";
    const { state, planRows, rows, orderNumbers } = entry;
    const titles = await this.maintenance.titlesOf(
      this.database.db,
      planRows.map((row) => row.id),
      lang,
    );
    // «Подобрать» is counted for what is due only: the client list per element costs a query.
    const shown = client
      ? planRows.filter((row) =>
          state.items.some(
            (item) => item.id === row.id && (item.state === "due" || item.state === "snoozed"),
          ),
        )
      : [];
    const sold =
      client && entry.vehicle && shown.length > 0
        ? await this.maintenance.catalogsOf(
            this.database.db,
            shown,
            entry.vehicle,
            client.cityId ?? undefined,
            client.viewer,
            lang,
          )
        : null;
    const catalogOf = new Map<string, MaintenanceCatalog>(
      shown.map((row, index) => [row.id, sold!.catalogs[index]!]),
    );
    const reminders: GarageReminder[] = state.items.map((item) => {
      const row = planRows.find((candidate) => candidate.id === item.id)!;
      return {
        planItemId: item.id,
        title: titles.get(item.id) ?? { text: "", isFallback: true },
        kind: row.kind,
        state: item.state,
        reason: item.reason,
        intervalKm: row.intervalKm,
        intervalMonths: row.intervalMonths,
        elapsedKm: item.elapsedKm,
        elapsedMonths: item.elapsedMonths,
        dueKm: item.dueKm,
        dueAt: item.dueDate?.toISOString() ?? null,
        basis: {
          source: item.basis.source,
          atKm: item.basis.atKm,
          at: item.basis.at?.toISOString() ?? null,
          orderId: item.basis.orderId,
          orderNumber: item.basis.orderId ? (orderNumbers.get(item.basis.orderId) ?? null) : null,
        },
        snoozedUntil: rows.get(item.id)?.snoozedUntil?.toISOString() ?? null,
        catalog: catalogOf.get(item.id) ?? null,
      };
    });
    return {
      carId: entry.car.id,
      hasPlan: entry.hasPlan,
      askMileage: state.askMileage,
      lastMileageKm: state.lastKm,
      lastMileageAt: state.lastReadingAt?.toISOString() ?? null,
      currentKm: state.currentKm,
      estimated: state.estimated,
      reminders,
      topPlanItemId: state.top?.id ?? null,
    };
  }
}

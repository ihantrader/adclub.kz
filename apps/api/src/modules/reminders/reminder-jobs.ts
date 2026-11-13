import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  dailyAt,
  definePeriodicJob,
  type JobRunContext,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { accountCar } from "../garage";
import { account } from "../identity";
import { MaintenanceAnswers } from "../maintenance";
import { Notifications } from "../notifications";
import { AppSettings, type SettingValues } from "../settings";
import { carLabelOf, cycleOf, ReminderFacts, type CarReminderFacts } from "./reminder-facts";
import { maintenanceReminder } from "./schema";

/**
 * `garage.remind` (TASK-069; ARCHITECTURE 13.2, 4.87) — **daily at
 * `reminder_hour`** (Almaty): for every car of every account with reminders
 * on, the state of the one rule (`ReminderFacts`), then at most one push of
 * each kind — P-REM-01 about the most overdue element not yet pushed for its
 * current replacement (and not sooner than `reminder_push_interval_days` per
 * car), or else P-REM-02 when the mileage is to be asked (not sooner than
 * `mileage_ask_days` per car). Neither has a WhatsApp copy (they are not
 * critical). Idempotent: a car is handled in its own transaction under its
 * row lock, a push's key is its replacement (or its day), and what was
 * pushed is written in the same transaction as the push.
 */
export const remindJob = definePeriodicJob({
  name: "garage.remind",
  timeoutSeconds: 1800,
  // Tomorrow's run is the retry; `jobs:run garage.remind` — at once.
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: async (setting) => dailyAt(await setting("reminder_hour")),
});

export const reminderJobCatalog = [remindJob];

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

function almatyDay(at: Date): string {
  return new Date(at.getTime() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

@Injectable()
export class GarageRemind implements PeriodicJobHandler {
  private readonly logger = new Logger("GarageRemind");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(ReminderFacts) private readonly facts: ReminderFacts,
    @Inject(MaintenanceAnswers) private readonly maintenance: MaintenanceAnswers,
    @Inject(Notifications) private readonly notifications: Notifications,
  ) {}

  async run(context: JobRunContext): Promise<JobRunOutcome> {
    // Read once, outside every transaction of the run: a read inside one would
    // wait for a second connection while holding the first and a car's lock.
    const settings = await this.settings.values();
    let after = "00000000-0000-0000-0000-000000000000";
    let reminders = 0;
    let questions = 0;
    for (;;) {
      if (context.signal.aborted) break;
      const accounts = await this.database.db
        .selectDistinct({ id: accountCar.accountId })
        .from(accountCar)
        .innerJoin(account, eq(account.id, accountCar.accountId))
        .where(and(eq(account.remindersEnabled, true), gt(accountCar.accountId, after)))
        .orderBy(asc(accountCar.accountId))
        .limit(BATCH);
      if (accounts.length === 0) break;
      for (const { id } of accounts) {
        if (context.signal.aborted) break;
        try {
          const sent = await this.remindAccount(id, settings);
          reminders += sent.reminders;
          questions += sent.questions;
        } catch (error) {
          // One account's trouble does not hold the others; tomorrow's run tries it again.
          this.logger.error(
            `Reminders of an account failed account=${id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      after = accounts.at(-1)!.id;
    }
    this.logger.log(`Reminders queued maintenance=${reminders} mileage=${questions}`);
    return { worked: reminders + questions > 0 };
  }

  private async remindAccount(
    accountId: string,
    settings: Readonly<SettingValues>,
  ): Promise<{ reminders: number; questions: number }> {
    const sent = { reminders: 0, questions: 0 };
    const now = new Date();
    // The facts are read without a transaction: the count takes queries per car
    // (the plan, compatibility of the orders), and nothing is locked meanwhile.
    const facts = await this.facts.forAccount(accountId, { now, settings });
    for (const entry of facts) {
      if (!entry.hasPlan) continue;
      const kind = await this.database.db.transaction((tx) =>
        this.remindCar(tx, accountId, entry, settings, now),
      );
      if (kind === "reminder") sent.reminders += 1;
      if (kind === "question") sent.questions += 1;
    }
    return sent;
  }

  private async remindCar(
    tx: DbExecutor,
    accountId: string,
    entry: CarReminderFacts,
    settings: Readonly<SettingValues>,
    now: Date,
  ): Promise<"reminder" | "question" | null> {
    const carId = entry.car.id;
    // The car's row lock, briefly: a car removed meanwhile is simply gone, the
    // switch is read again, and two runs write what was pushed in turn.
    const [locked] = await tx
      .select({ id: accountCar.id, mileagePushedAt: accountCar.mileagePushedAt })
      .from(accountCar)
      .where(eq(accountCar.id, carId))
      .for("update");
    if (!locked) return null;
    const [person] = await tx
      .select({ enabled: account.remindersEnabled })
      .from(account)
      .where(eq(account.id, accountId));
    if (!person?.enabled) return null;
    await this.keepCounted(tx, accountId, entry);
    // What was pushed — read again under the lock, not from the facts read before it.
    const pushed = await tx
      .select({
        planItemId: maintenanceReminder.planItemId,
        cycle: maintenanceReminder.notifiedCycle,
        snoozedUntil: maintenanceReminder.snoozedUntil,
      })
      .from(maintenanceReminder)
      .where(eq(maintenanceReminder.carId, carId));
    const cycleOfItem = new Map(pushed.map((row) => [row.planItemId, row.cycle]));
    const snoozeOfItem = new Map(pushed.map((row) => [row.planItemId, row.snoozedUntil]));

    const lang = await this.notifications.languageOf(tx, accountId);
    const car = carLabelOf(entry.car);
    const lastPush = await tx
      .select({ at: sql<Date | null>`max(${maintenanceReminder.notifiedAt})` })
      .from(maintenanceReminder)
      .where(and(eq(maintenanceReminder.carId, carId), isNotNull(maintenanceReminder.notifiedAt)));
    const lastAt = lastPush[0]?.at ? new Date(lastPush[0].at) : null;
    const intervalOver =
      lastAt === null ||
      now.getTime() - lastAt.getTime() >= settings.reminder_push_interval_days * DAY_MS;
    if (intervalOver) {
      const fresh = entry.state.items
        .filter((item) => item.state === "due")
        .filter((item) => cycleOfItem.get(item.id) !== cycleOf(item))
        .sort((a, b) => b.overdue - a.overdue)[0];
      if (fresh) {
        const titles = await this.maintenance.titlesOf(tx, [fresh.id], lang);
        const what = titles.get(fresh.id)?.text ?? "";
        const cycle = cycleOf(fresh);
        // «Напомнить позже» promises a push again after the snooze: the same
        // replacement then needs a key of its own, or the outbox swallows it.
        const snoozed = snoozeOfItem.get(fresh.id);
        const pushKey = snoozed ? `${cycle}:snoozed:${snoozed.toISOString()}` : cycle;
        // A part — «Пора менять масло на …»; a service is named by its own work.
        const service = entry.planRows.find((row) => row.id === fresh.id)?.kind === "service";
        await this.notifications.enqueue(tx, {
          kind: "maintenance_reminder",
          template: service ? "maintenance_reminder_service" : "maintenance_reminder",
          recipientAccountId: accountId,
          lang,
          variables: { what: service ? what : what.toLocaleLowerCase(lang), car },
          target: { screen: "catalog", params: { carId } },
          subject: { type: "account_car", id: carId },
          dedupeKey: `maintenance_reminder:${carId}:${fresh.id}:${pushKey}`,
        });
        await tx
          .update(maintenanceReminder)
          .set({ notifiedAt: now, notifiedCycle: cycle, updatedAt: now })
          .where(
            and(eq(maintenanceReminder.carId, carId), eq(maintenanceReminder.planItemId, fresh.id)),
          );
        return "reminder";
      }
    }
    const askedLongAgo =
      locked.mileagePushedAt === null ||
      now.getTime() - locked.mileagePushedAt.getTime() >= settings.mileage_ask_days * DAY_MS;
    if (entry.state.askMileage && askedLongAgo) {
      await this.notifications.enqueue(tx, {
        kind: "mileage_request",
        template: "mileage_request",
        recipientAccountId: accountId,
        lang,
        variables: { car },
        target: { screen: "catalog", params: { carId } },
        subject: { type: "account_car", id: carId },
        dedupeKey: `mileage_request:${carId}:${almatyDay(now)}`,
      });
      await tx.update(accountCar).set({ mileagePushedAt: now }).where(eq(accountCar.id, carId));
      return "question";
    }
    return null;
  }

  /** What the count was made from — kept for the admin panel's view and the push's cycle. */
  private async keepCounted(
    tx: DbExecutor,
    accountId: string,
    entry: CarReminderFacts,
  ): Promise<void> {
    const values = entry.state.items.map((item) => ({
      accountId,
      carId: entry.car.id,
      planItemId: item.id,
      lastSource: item.basis.source,
      lastKm: item.basis.atKm,
      lastAt: item.basis.at,
      lastOrderId: item.basis.orderId,
      dueKm: item.dueKm,
      dueAt: item.dueDate,
    }));
    if (values.length === 0) return;
    await tx
      .insert(maintenanceReminder)
      .values(values)
      .onConflictDoUpdate({
        target: [maintenanceReminder.carId, maintenanceReminder.planItemId],
        set: {
          lastSource: sql`excluded.last_source`,
          lastKm: sql`excluded.last_km`,
          lastAt: sql`excluded.last_at`,
          lastOrderId: sql`excluded.last_order_id`,
          dueKm: sql`excluded.due_km`,
          dueAt: sql`excluded.due_at`,
          updatedAt: new Date(),
        },
      });
  }
}

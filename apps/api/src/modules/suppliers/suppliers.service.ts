import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminSupplierCard,
  type AdminSupplierListItem,
  type AdminSupplierPage,
  type ClosedDate,
  type DayHours,
  type SetSupplierBlockBody,
  type SetSupplierPauseBody,
  type SetSupplierScheduleBody,
  type SetSupplierVerificationBody,
  type SupplierCard,
  type SupplierListQuery,
  type SupplierType,
  type UpdateSupplierBody,
} from "@adclub/contracts";
import { maskBin, maskPhone, supplierState, supplierVisibleOnShowcase } from "@adclub/domain";
import { and, asc, eq, gte, ilike, or, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog, type AuditActorRecord } from "../audit";
import { decodeCursor, encodeCursor, escapeLike, normalizeText } from "../catalog";
import {
  account,
  AccountStore,
  AdminUserStore,
  supplier,
  supplierMember,
  SupplierMembershipStore,
  type SupplierStatus,
} from "../identity";
import { CitiesService, cityRef } from "./cities.service";
import { city, supplierClosedDate, supplierLocation, type CityRow } from "./schema";
import {
  binLock,
  binTaken,
  Changes,
  kzBin,
  kzPhone,
  notFound,
  supplierStateConflict,
  supplierVersionConflict,
  timeZoneOf,
  todayIn,
  validationError,
  yearsLater,
  type SupplierAdminActor,
  type SupplierSelfActor,
} from "./supplier-common";
import { describeInvitation, SupplierInvitations } from "./supplier-invitations";

type SupplierRow = typeof supplier.$inferSelect;
type LocationRow = typeof supplierLocation.$inferSelect;

/** What creating a supplier needs, already checked (the БИН and phones normalized). */
export interface NewSupplier {
  name: string;
  bin: string;
  cityId: string;
  type: SupplierType;
  contactName: string | null;
  contactPhone: string | null;
  address: string | null;
  district: string | null;
  firstMember: { name: string; phone: string };
  leadId: string | null;
}

export interface CreatedSupplier {
  supplierId: string;
  firstMember: {
    memberId: string;
    accountId: string;
    accountCreated: boolean;
    memberOfOtherSuppliers: number;
    isAdministrator: boolean;
  };
  invitation: ReturnType<typeof describeInvitation>;
}

function stateFacts(row: SupplierRow) {
  return { pauseReason: row.pauseReason ?? null, blocked: row.blockedAt !== null };
}

/** What the pause and the blocking make `status` (the database checks the same). */
function statusOf(row: Pick<SupplierRow, "pauseReason" | "blockedAt">): SupplierStatus {
  return supplierState({ pauseReason: row.pauseReason ?? null, blocked: row.blockedAt !== null });
}

/**
 * Suppliers (TASK-016 requirements 4–7; ARCHITECTURE 4.26): creating one
 * with its pickup point and first employee, the card, the profile and the
 * schedule with versions and the action journal, the verified-partner
 * mark, pause and blocking, the list. Pause and blocking never close the
 * cabinet (the access rule doesn't read them) and never touch orders; the
 * showcase reads `visibleOnShowcase` (`status = 'active'`).
 */
@Injectable()
export class SuppliersService {
  private readonly logger = new Logger("Suppliers");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(CitiesService) private readonly cities: CitiesService,
    @Inject(AccountStore) private readonly accounts: AccountStore,
    @Inject(AdminUserStore) private readonly admins: AdminUserStore,
    @Inject(SupplierMembershipStore) private readonly memberships: SupplierMembershipStore,
    @Inject(SupplierInvitations) private readonly invitations: SupplierInvitations,
  ) {}

  // ---------------------------------------------------------------- create

  /**
   * Creates the supplier, its pickup point and its first employee (the
   * account of the number is created if there is none) and puts the
   * invitation on the queue — in the caller's transaction, so a failure of
   * any step leaves nothing. One БИН — one supplier.
   */
  async create(
    tx: DbExecutor,
    input: NewSupplier,
    actor: SupplierAdminActor,
  ): Promise<CreatedSupplier> {
    await tx.execute(binLock(input.bin));
    const [existing] = await tx
      .select({ id: supplier.id })
      .from(supplier)
      .where(eq(supplier.bin, input.bin));
    if (existing) {
      throw binTaken(existing.id);
    }
    const cityRow = await this.cities.choose(tx, input.cityId, "cityId");
    const [created] = await tx
      .insert(supplier)
      .values({
        name: input.name,
        bin: input.bin,
        cityId: cityRow.id,
        type: input.type,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        timeZone: cityRow.timeZone,
        leadId: input.leadId,
      })
      .returning();
    const supplierId = created!.id;
    await tx.insert(supplierLocation).values({
      supplierId,
      cityId: cityRow.id,
      address: input.address,
      district: input.district,
    });
    const found = await this.accounts.findOrCreateByPhone(input.firstMember.phone, tx);
    const others = await this.memberships.listActive(found.id, tx);
    const admin = await this.admins.findActiveByAccount(found.id, tx);
    const member = await this.memberships.addMember(
      {
        supplierId,
        accountId: found.id,
        displayName: input.firstMember.name,
        addedBy: "admin",
      },
      tx,
    );
    await this.audit.record(
      {
        action: auditActions.supplierCreated,
        actor,
        entityType: auditEntities.supplier,
        entityId: supplierId,
        after: {
          companyName: created!.name,
          cityId: cityRow.id,
          type: created!.type,
          binMasked: maskBin(input.bin),
          leadId: input.leadId,
        },
      },
      tx,
    );
    await this.audit.record(
      {
        action: auditActions.supplierMemberAdded,
        actor,
        entityType: auditEntities.supplierMember,
        entityId: member.memberId,
        after: {
          supplierId,
          accountId: found.id,
          phoneMasked: maskPhone(input.firstMember.phone),
          restored: false,
        },
      },
      tx,
    );
    const invitation = await this.invitations.enqueue(tx, {
      supplierId,
      memberId: member.memberId,
      actor,
      again: false,
    });
    if (found.created) {
      this.logger.log(`Account created account=${found.id} by=supplier_onboarding`);
    }
    this.logger.log(
      `Supplier created supplier=${supplierId} bin=${maskBin(input.bin)} member=${member.memberId} phone=${maskPhone(input.firstMember.phone)} lead=${input.leadId ?? "none"}`,
    );
    return {
      supplierId,
      firstMember: {
        memberId: member.memberId,
        accountId: found.id,
        accountCreated: found.created,
        memberOfOtherSuppliers: others.length,
        isAdministrator: admin !== undefined,
      },
      invitation: describeInvitation(invitation),
    };
  }

  // ------------------------------------------------------------------ read

  async adminCard(
    supplierId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<AdminSupplierCard> {
    const [row] = await executor.select().from(supplier).where(eq(supplier.id, supplierId));
    if (!row) {
      throw notFound("supplier");
    }
    const card = await this.card(executor, row);
    const members = await executor
      .select({
        id: supplierMember.id,
        displayName: supplierMember.displayName,
        phone: account.phone,
        status: supplierMember.status,
        createdAt: supplierMember.createdAt,
      })
      .from(supplierMember)
      .innerJoin(account, eq(account.id, supplierMember.accountId))
      .where(eq(supplierMember.supplierId, supplierId))
      .orderBy(asc(supplierMember.createdAt), asc(supplierMember.id));
    const latest = await this.invitations.latestOf(
      executor,
      members.map((member) => member.id),
    );
    return {
      ...card,
      leadId: row.leadId,
      members: members.map((member) => {
        const invitation = latest.get(member.id);
        return {
          id: member.id,
          displayName: member.displayName,
          phone: member.phone,
          status: member.status,
          lastInvitation: invitation ? describeInvitation(invitation) : null,
          createdAt: member.createdAt.toISOString(),
        };
      }),
    };
  }

  /** The card of the cabinet's own company (`GET /supplier/company`). */
  async ownCard(
    supplierId: string,
  ): Promise<{ row: SupplierRow; card: SupplierCard; cityName: string }> {
    const db = this.database.db;
    const [row] = await db.select().from(supplier).where(eq(supplier.id, supplierId));
    if (!row) {
      throw notFound("company");
    }
    const card = await this.card(db, row);
    return { row, card, cityName: card.city.names.ru };
  }

  async list(query: SupplierListQuery): Promise<AdminSupplierPage> {
    const conditions: (SQL | undefined)[] = [
      query.cityId ? eq(supplier.cityId, query.cityId) : undefined,
      query.type ? eq(supplier.type, query.type) : undefined,
      query.state === "verified"
        ? sql`${supplier.verifiedAt} IS NOT NULL`
        : query.state
          ? eq(supplier.status, query.state)
          : undefined,
      query.q ? this.search(query.q) : undefined,
    ];
    const filters = and(...conditions);
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const page = await this.database.db
      .select()
      .from(supplier)
      .where(
        and(
          filters,
          after
            ? sql`(lower(${supplier.name}), ${supplier.id}) > (${after.position}, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(sql`lower(${supplier.name})`, asc(supplier.id))
      .limit(query.limit + 1);
    const [counted] = await this.database.db
      .select({ total: sql<number>`count(*)::int` })
      .from(supplier)
      .where(filters);
    const shown = page.slice(0, query.limit);
    const cityRows = await this.citiesById(shown.map((row) => row.cityId));
    const last = shown.at(-1);
    return {
      suppliers: shown.map((row) => this.listItem(row, cityRows.get(row.cityId)!)),
      total: counted?.total ?? 0,
      nextCursor:
        page.length > query.limit && last ? encodeCursor(last.name.toLowerCase(), last.id) : null,
    };
  }

  // ---------------------------------------------------------------- change

  async update(
    supplierId: string,
    input: UpdateSupplierBody,
    actor: SupplierAdminActor,
  ): Promise<AdminSupplierCard> {
    await this.database.db.transaction(async (tx) => {
      const row = await this.lock(tx, supplierId, input.expectedVersion);
      const location = await this.location(tx, supplierId);
      const changes = new Changes();
      const next: Partial<SupplierRow> = {};
      if (input.name !== undefined) {
        next.name = normalizeText(input.name);
        changes.note("name", row.name, next.name);
      }
      if (input.bin !== undefined) {
        const bin = kzBin("bin", input.bin);
        if (bin !== row.bin) {
          await tx.execute(binLock(bin));
          const [other] = await tx
            .select({ id: supplier.id })
            .from(supplier)
            .where(eq(supplier.bin, bin));
          if (other) {
            throw binTaken(other.id);
          }
        }
        next.bin = bin;
        changes.note("binMasked", row.bin && maskBin(row.bin), maskBin(bin));
      }
      if (input.type !== undefined) {
        next.type = input.type;
        changes.note("type", row.type, input.type);
      }
      if (input.contactName !== undefined) {
        next.contactName = input.contactName === null ? null : normalizeText(input.contactName);
        changes.note("contactName", row.contactName, next.contactName);
      }
      if (input.contactPhone !== undefined) {
        next.contactPhone =
          input.contactPhone === null ? null : kzPhone("contactPhone", input.contactPhone);
        changes.note(
          "contactPhoneMasked",
          row.contactPhone && maskPhone(row.contactPhone),
          next.contactPhone && maskPhone(next.contactPhone),
        );
      }
      let cityRow: CityRow | undefined;
      if (input.cityId !== undefined && input.cityId !== row.cityId) {
        cityRow = await this.cities.choose(tx, input.cityId, "cityId", row.cityId);
        next.cityId = cityRow.id;
        changes.note("cityId", row.cityId, cityRow.id);
        // The time zone follows the new city unless given.
        if (input.timeZone === undefined) {
          next.timeZone = cityRow.timeZone;
        }
      }
      if (input.timeZone !== undefined) {
        next.timeZone = timeZoneOf("timeZone", input.timeZone);
      }
      if (next.timeZone !== undefined) {
        changes.note("timeZone", row.timeZone, next.timeZone);
      }
      const place: Partial<LocationRow> = {};
      if (input.address !== undefined) {
        place.address = input.address === null ? null : normalizeText(input.address);
        changes.note("address", location.address, place.address);
      }
      if (input.district !== undefined) {
        place.district = input.district === null ? null : normalizeText(input.district);
        changes.note("district", location.district, place.district);
      }
      if (cityRow) {
        place.cityId = cityRow.id;
      }
      if (changes.empty) {
        return;
      }
      const now = new Date();
      await tx
        .update(supplier)
        .set({ ...next, version: row.version + 1, updatedAt: now })
        .where(eq(supplier.id, supplierId));
      if (Object.keys(place).length > 0) {
        await tx
          .update(supplierLocation)
          .set({ ...place, updatedAt: now })
          .where(eq(supplierLocation.id, location.id));
      }
      await this.audit.record(
        {
          action: auditActions.supplierChanged,
          actor,
          entityType: auditEntities.supplier,
          entityId: supplierId,
          before: changes.before,
          after: { ...changes.after, version: row.version + 1 },
        },
        tx,
      );
    });
    return this.adminCard(supplierId);
  }

  /**
   * Replaces the hours and the days off from today on (an administrator,
   * or the supplier itself — its own company only, the route decides).
   * Days off before today are kept as history and never touched.
   */
  async setSchedule(
    supplierId: string,
    input: SetSupplierScheduleBody,
    actor: SupplierAdminActor | SupplierSelfActor,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const row = await this.lock(tx, supplierId, input.expectedVersion);
      const location = await this.location(tx, supplierId);
      const today = todayIn(row.timeZone);
      const horizon = yearsLater(today, 2);
      const seen = new Set<string>();
      for (const [index, day] of input.closedDates.entries()) {
        const path = `closedDates.${index}.date`;
        if (seen.has(day.date)) {
          throw validationError(path, "The date is listed twice");
        }
        seen.add(day.date);
        if (day.date < today) {
          throw validationError(
            path,
            `The date is in the past (today is ${today} for the supplier)`,
          );
        }
        if (day.date > horizon) {
          throw validationError(path, "The date is more than two years ahead");
        }
      }
      const before = await this.upcomingClosedDates(tx, location.id, today);
      const wanted: ClosedDate[] = [...input.closedDates]
        .map((day) => ({
          date: day.date,
          note: day.note === null ? null : normalizeText(day.note),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const changes = new Changes();
      changes.note("weeklyHours", location.weeklyHours, input.weeklyHours);
      changes.note("closedDates", before, wanted);
      if (changes.empty) {
        return;
      }
      const now = new Date();
      await tx
        .update(supplierLocation)
        .set({ weeklyHours: input.weeklyHours as DayHours[], updatedAt: now })
        .where(eq(supplierLocation.id, location.id));
      await tx
        .delete(supplierClosedDate)
        .where(
          and(
            eq(supplierClosedDate.locationId, location.id),
            gte(supplierClosedDate.closedOn, today),
          ),
        );
      if (wanted.length > 0) {
        await tx
          .insert(supplierClosedDate)
          .values(
            wanted.map((day) => ({ locationId: location.id, closedOn: day.date, note: day.note })),
          );
      }
      await tx
        .update(supplier)
        .set({ version: row.version + 1, updatedAt: now })
        .where(eq(supplier.id, supplierId));
      await this.audit.record(
        {
          action: auditActions.supplierScheduleChanged,
          actor,
          entityType: auditEntities.supplier,
          entityId: supplierId,
          before: changes.before,
          after: { ...changes.after, version: row.version + 1 },
        },
        tx,
      );
    });
  }

  async setVerification(
    supplierId: string,
    input: SetSupplierVerificationBody,
    actor: SupplierAdminActor,
  ): Promise<AdminSupplierCard> {
    await this.database.db.transaction(async (tx) => {
      const row = await this.lock(tx, supplierId, input.expectedVersion);
      if (input.verified) {
        if (!input.contractSignedOn) {
          throw validationError("contractSignedOn", "The date the contract was signed is required");
        }
        if (input.contractSignedOn > todayIn(row.timeZone)) {
          throw validationError("contractSignedOn", "The contract can't be signed in the future");
        }
      } else {
        if (row.verifiedAt === null) {
          throw supplierStateConflict("not_verified");
        }
        if (!input.reason) {
          throw validationError("reason", "Say why the mark is lifted");
        }
      }
      const now = new Date();
      const next = input.verified
        ? { contractSignedOn: input.contractSignedOn!, verifiedAt: row.verifiedAt ?? now }
        : { contractSignedOn: null, verifiedAt: null };
      await this.writeState(tx, row, next, now, {
        action: auditActions.supplierVerificationChanged,
        actor,
        before: { verified: row.verifiedAt !== null, contractSignedOn: row.contractSignedOn },
        after: { verified: input.verified, contractSignedOn: next.contractSignedOn },
        reason: input.reason ?? null,
      });
    });
    this.logger.log(
      `Supplier verification changed supplier=${supplierId} verified=${input.verified}`,
    );
    return this.adminCard(supplierId);
  }

  async setPause(
    supplierId: string,
    input: SetSupplierPauseBody,
    actor: SupplierAdminActor,
  ): Promise<AdminSupplierCard> {
    await this.database.db.transaction(async (tx) => {
      const row = await this.lock(tx, supplierId, input.expectedVersion);
      if (input.paused && !input.reason) {
        throw validationError("reason", "Say what the pause is for: billing or admin");
      }
      if (!input.paused && row.pausedAt === null) {
        throw supplierStateConflict("not_paused");
      }
      const now = new Date();
      const note = normalizeText(input.note);
      const next = input.paused
        ? { pauseReason: input.reason!, pauseNote: note, pausedAt: row.pausedAt ?? now }
        : { pauseReason: null, pauseNote: null, pausedAt: null };
      await this.writeState(tx, row, next, now, {
        action: auditActions.supplierPauseChanged,
        actor,
        before: { paused: row.pausedAt !== null, reason: row.pauseReason },
        after: { paused: input.paused, reason: next.pauseReason },
        reason: note,
      });
    });
    this.logger.log(`Supplier pause changed supplier=${supplierId} paused=${input.paused}`);
    return this.adminCard(supplierId);
  }

  async setBlock(
    supplierId: string,
    input: SetSupplierBlockBody,
    actor: SupplierAdminActor,
  ): Promise<AdminSupplierCard> {
    await this.database.db.transaction(async (tx) => {
      const row = await this.lock(tx, supplierId, input.expectedVersion);
      if (input.blocked && row.blockedAt !== null) {
        throw supplierStateConflict("already_blocked");
      }
      if (!input.blocked && row.blockedAt === null) {
        throw supplierStateConflict("not_blocked");
      }
      const now = new Date();
      const reason = normalizeText(input.reason);
      const next = input.blocked
        ? { blockReason: reason, blockedAt: now }
        : { blockReason: null, blockedAt: null };
      await this.writeState(tx, row, next, now, {
        action: auditActions.supplierBlockChanged,
        actor,
        before: { blocked: row.blockedAt !== null },
        after: { blocked: input.blocked },
        reason,
      });
    });
    this.logger.log(`Supplier block changed supplier=${supplierId} blocked=${input.blocked}`);
    return this.adminCard(supplierId);
  }

  // --------------------------------------------------------------- helpers

  /** A state change: the new columns, `status` that follows them, the version, the journal. */
  private async writeState(
    tx: DbExecutor,
    row: SupplierRow,
    next: Partial<SupplierRow>,
    now: Date,
    entry: {
      action: string;
      actor: AuditActorRecord;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      reason: string | null;
    },
  ): Promise<void> {
    const merged = { ...row, ...next };
    const status = statusOf(merged);
    await tx
      .update(supplier)
      .set({ ...next, status, version: row.version + 1, updatedAt: now })
      .where(eq(supplier.id, row.id));
    await this.audit.record(
      {
        action: entry.action,
        actor: entry.actor,
        entityType: auditEntities.supplier,
        entityId: row.id,
        before: { ...entry.before, state: row.status },
        after: {
          ...entry.after,
          state: status,
          visibleOnShowcase: supplierVisibleOnShowcase(stateFacts(merged)),
          version: row.version + 1,
        },
        reason: entry.reason,
      },
      tx,
    );
  }

  private async lock(
    tx: DbExecutor,
    supplierId: string,
    expectedVersion: number,
  ): Promise<SupplierRow> {
    const [row] = await tx.select().from(supplier).where(eq(supplier.id, supplierId)).for("update");
    if (!row) {
      throw notFound("supplier");
    }
    if (row.version !== expectedVersion) {
      throw supplierVersionConflict(row.version);
    }
    return row;
  }

  private async location(executor: DbExecutor, supplierId: string): Promise<LocationRow> {
    const [row] = await executor
      .select()
      .from(supplierLocation)
      .where(
        and(eq(supplierLocation.supplierId, supplierId), eq(supplierLocation.isDefault, true)),
      );
    if (!row) {
      throw new Error(`Supplier ${supplierId} has no pickup point`);
    }
    return row;
  }

  private async upcomingClosedDates(
    executor: DbExecutor,
    locationId: string,
    today: string,
  ): Promise<ClosedDate[]> {
    const rows = await executor
      .select({ date: supplierClosedDate.closedOn, note: supplierClosedDate.note })
      .from(supplierClosedDate)
      .where(
        and(eq(supplierClosedDate.locationId, locationId), gte(supplierClosedDate.closedOn, today)),
      )
      .orderBy(asc(supplierClosedDate.closedOn));
    return rows;
  }

  private async card(executor: DbExecutor, row: SupplierRow): Promise<SupplierCard> {
    const location = await this.location(executor, row.id);
    const cityRows = await this.citiesById([row.cityId, location.cityId]);
    const closedDates = await this.upcomingClosedDates(
      executor,
      location.id,
      todayIn(row.timeZone),
    );
    const facts = stateFacts(row);
    return {
      id: row.id,
      name: row.name,
      bin: row.bin,
      type: row.type,
      city: cityRef(cityRows.get(row.cityId)!),
      timeZone: row.timeZone,
      contactName: row.contactName,
      contactPhone: row.contactPhone,
      location: {
        id: location.id,
        city: cityRef(cityRows.get(location.cityId)!),
        address: location.address,
        district: location.district,
      },
      schedule: { weeklyHours: location.weeklyHours, closedDates },
      state: supplierState(facts),
      visibleOnShowcase: supplierVisibleOnShowcase(facts),
      verification:
        row.verifiedAt && row.contractSignedOn
          ? { contractSignedOn: row.contractSignedOn, verifiedAt: row.verifiedAt.toISOString() }
          : null,
      pause:
        row.pauseReason && row.pausedAt
          ? { reason: row.pauseReason, note: row.pauseNote, since: row.pausedAt.toISOString() }
          : null,
      block:
        row.blockReason && row.blockedAt
          ? { reason: row.blockReason, since: row.blockedAt.toISOString() }
          : null,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private listItem(row: SupplierRow, cityRow: CityRow): AdminSupplierListItem {
    const facts = stateFacts(row);
    return {
      id: row.id,
      name: row.name,
      bin: row.bin,
      type: row.type,
      city: cityRef(cityRow),
      state: supplierState(facts),
      verified: row.verifiedAt !== null,
      visibleOnShowcase: supplierVisibleOnShowcase(facts),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async citiesById(ids: readonly string[]): Promise<Map<string, CityRow>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await this.database.db
      .select()
      .from(city)
      .where(sql`${city.id} = ANY(${`{${unique.join(",")}}`}::uuid[])`);
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** A part of the name (case ignored), or digits of the БИН. */
  private search(q: string): SQL {
    const text = `%${escapeLike(normalizeText(q))}%`;
    const digits = q.replace(/[\s-]/g, "");
    return /^\d+$/.test(digits)
      ? or(ilike(supplier.name, text), ilike(supplier.bin, `%${digits}%`))!
      : ilike(supplier.name, text);
  }
}

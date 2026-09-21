import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  supplierLeadStatusSchema,
  type AdminSupplierLead,
  type AdminSupplierLeadCard,
  type AdminSupplierLeadPage,
  type CreateSupplierBody,
  type CreateSupplierLeadBody,
  type OnboardSupplierLeadBody,
  type SetSupplierLeadStatusBody,
  type SupplierLeadListQuery,
  type SupplierLeadStatusValue,
  type SupplierOnboardedResponse,
  type UpdateSupplierLeadBody,
} from "@adclub/contracts";
import { canOnboardLead, maskBin, maskPhone, supplierLeadTransition } from "@adclub/domain";
import { and, desc, eq, gte, ilike, lte, ne, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { decodeCursor, encodeCursor, escapeLike, normalizeText, TIME_POSITION } from "../catalog";
import { CitiesService, cityRef } from "./cities.service";
import { city, supplierLead, supplierLeadNote, type CityRow, type SupplierLeadRow } from "./schema";
import {
  adminIdOf,
  Changes,
  kzBin,
  kzPhone,
  leadState,
  notFound,
  supplierVersionConflict,
  validationError,
  type SupplierAdminActor,
} from "./supplier-common";
import { SuppliersService, type NewSupplier } from "./suppliers.service";

/*
 * Computed columns of a request. The outer table is named in full
 * (`supplier_lead.…`): drizzle writes a column of a one-table select
 * without its table, and inside a subquery that would mean the inner row.
 */
/** The position of a request in the list: its time to the microsecond. */
const positionColumn = sql<string>`to_char(supplier_lead.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const sameBinColumn = sql<number>`(SELECT count(*)::int FROM supplier_lead other WHERE other.bin = supplier_lead.bin AND other.id <> supplier_lead.id)`;
const existingSupplierColumn = sql<
  string | null
>`(SELECT s.id FROM supplier s WHERE s.bin = supplier_lead.bin)`;

interface LeadListRow {
  lead: SupplierLeadRow;
  position: string;
  sameBinLeads: number;
  existingSupplierId: string | null;
}

/**
 * Connection requests in the admin panel (TASK-016 requirements 3–4;
 * PRODUCT 12.1; SCREENS A-SUP-01, A-SUP-04; ARCHITECTURE 4.26): the list
 * with the counts of the funnel, requests added by hand, corrections,
 * notes, moves along the funnel — its transitions are kept on the server
 * (`supplierLeadTransition`) — and creating the supplier from a request.
 * The public form is `SupplierLeadForm`.
 */
@Injectable()
export class SupplierLeadsService {
  private readonly logger = new Logger("SupplierLead");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(CitiesService) private readonly cities: CitiesService,
    @Inject(SuppliersService) private readonly suppliers: SuppliersService,
  ) {}

  async list(query: SupplierLeadListQuery): Promise<AdminSupplierLeadPage> {
    const bin = query.bin?.replace(/[\s-]/g, "");
    const base: (SQL | undefined)[] = [
      query.cityId ? eq(supplierLead.cityId, query.cityId) : undefined,
      query.type ? eq(supplierLead.type, query.type) : undefined,
      query.source ? eq(supplierLead.source, query.source) : undefined,
      query.from ? gte(supplierLead.createdAt, new Date(query.from)) : undefined,
      query.to ? lte(supplierLead.createdAt, new Date(query.to)) : undefined,
      bin ? eq(supplierLead.bin, bin) : undefined,
      query.q
        ? ilike(supplierLead.companyName, `%${escapeLike(normalizeText(query.q))}%`)
        : undefined,
    ];
    const filters = and(...base, query.status ? eq(supplierLead.status, query.status) : undefined);
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (after && !TIME_POSITION.test(after.position)) {
      throw validationError("cursor", "Use the nextCursor of the previous page");
    }
    const rows = await this.database.db
      .select({
        lead: supplierLead,
        position: positionColumn,
        sameBinLeads: sameBinColumn,
        existingSupplierId: existingSupplierColumn,
      })
      .from(supplierLead)
      .where(
        and(
          filters,
          after
            ? sql`(${supplierLead.createdAt}, ${supplierLead.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(supplierLead.createdAt), desc(supplierLead.id))
      .limit(query.limit + 1);
    const [counted] = await this.database.db
      .select({ total: sql<number>`count(*)::int` })
      .from(supplierLead)
      .where(filters);
    const perStatus = await this.database.db
      .select({ status: supplierLead.status, count: sql<number>`count(*)::int` })
      .from(supplierLead)
      .where(and(...base))
      .groupBy(supplierLead.status);
    const counts = Object.fromEntries(
      supplierLeadStatusSchema.options.map((status) => [status, 0]),
    );
    for (const row of perStatus) {
      counts[row.status] = row.count;
    }
    const shown = rows.slice(0, query.limit);
    const cities = await this.citiesOf(shown.map((row) => row.lead.cityId));
    const last = shown.at(-1);
    return {
      leads: shown.map((row) => this.describe(row, cities.get(row.lead.cityId)!)),
      total: counted?.total ?? 0,
      counts: counts as Record<SupplierLeadStatusValue, number>,
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.position, last.lead.id) : null,
    };
  }

  async card(
    leadId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<AdminSupplierLeadCard> {
    const row = await this.read(executor, leadId);
    const cityRow = (await this.citiesOf([row.lead.cityId], executor)).get(row.lead.cityId)!;
    const notes = await executor
      .select()
      .from(supplierLeadNote)
      .where(eq(supplierLeadNote.leadId, leadId))
      .orderBy(desc(supplierLeadNote.createdAt), desc(supplierLeadNote.id));
    const related = await executor
      .select()
      .from(supplierLead)
      .where(and(eq(supplierLead.bin, row.lead.bin), ne(supplierLead.id, leadId)))
      .orderBy(desc(supplierLead.createdAt), desc(supplierLead.id));
    return {
      lead: this.describe(row, cityRow),
      notes: notes.map((note) => ({
        id: note.id,
        text: note.text,
        authorAdminId: note.authorAdminId,
        createdAt: note.createdAt.toISOString(),
      })),
      related: related.map((other) => ({
        id: other.id,
        companyName: other.companyName,
        status: other.status,
        source: other.source,
        createdAt: other.createdAt.toISOString(),
      })),
    };
  }

  /** A request added by hand after a call: source `admin`, status `new`. */
  async create(
    input: CreateSupplierLeadBody,
    actor: SupplierAdminActor,
  ): Promise<AdminSupplierLeadCard> {
    const bin = kzBin("bin", input.bin);
    const phone = kzPhone("phone", input.phone);
    const adminId = adminIdOf(actor);
    const id = await this.database.db.transaction(async (tx) => {
      const cityRow = await this.cities.choose(tx, input.cityId, "cityId");
      const [row] = await tx
        .insert(supplierLead)
        .values({
          companyName: normalizeText(input.companyName),
          bin,
          cityId: cityRow.id,
          type: input.type,
          contactName: normalizeText(input.contactName),
          phone,
          source: "admin",
          createdByAdminId: adminId,
        })
        .returning();
      await this.audit.record(
        {
          action: auditActions.supplierLeadCreated,
          actor,
          entityType: auditEntities.supplierLead,
          entityId: row!.id,
          after: { source: "admin", cityId: row!.cityId, type: row!.type },
        },
        tx,
      );
      if (input.note) {
        await this.writeNote(tx, row!.id, input.note, actor);
      }
      return row!.id;
    });
    this.logger.log(
      `Supplier lead added by hand lead=${id} bin=${maskBin(bin)} phone=${maskPhone(phone)}`,
    );
    return this.card(id);
  }

  async update(
    leadId: string,
    input: UpdateSupplierLeadBody,
    actor: SupplierAdminActor,
  ): Promise<AdminSupplierLeadCard> {
    await this.database.db.transaction(async (tx) => {
      const lead = await this.lock(tx, leadId, input.expectedVersion);
      if (lead.status === "onboarded") {
        throw leadState({ status: lead.status, refusal: "final" });
      }
      const next: Partial<SupplierLeadRow> = {};
      const changes = new Changes();
      if (input.companyName !== undefined) {
        next.companyName = normalizeText(input.companyName);
        changes.note("companyName", lead.companyName, next.companyName);
      }
      if (input.bin !== undefined) {
        next.bin = kzBin("bin", input.bin);
        changes.note("binMasked", maskBin(lead.bin), maskBin(next.bin));
        if (next.bin === lead.bin) {
          delete changes.before.binMasked;
          delete changes.after.binMasked;
        }
      }
      if (input.cityId !== undefined) {
        next.cityId = (await this.cities.choose(tx, input.cityId, "cityId", lead.cityId)).id;
        changes.note("cityId", lead.cityId, next.cityId);
      }
      if (input.type !== undefined) {
        next.type = input.type;
        changes.note("type", lead.type, input.type);
      }
      if (input.contactName !== undefined) {
        next.contactName = normalizeText(input.contactName);
        changes.note("contactName", lead.contactName, next.contactName);
      }
      if (input.phone !== undefined) {
        next.phone = kzPhone("phone", input.phone);
        if (next.phone !== lead.phone) {
          changes.note("phoneMasked", maskPhone(lead.phone), maskPhone(next.phone));
        }
      }
      const changed = Object.entries(next).some(
        ([key, value]) => lead[key as keyof SupplierLeadRow] !== value,
      );
      if (!changed) {
        return;
      }
      await tx
        .update(supplierLead)
        .set({ ...next, version: lead.version + 1, updatedAt: new Date() })
        .where(eq(supplierLead.id, leadId));
      await this.audit.record(
        {
          action: auditActions.supplierLeadChanged,
          actor,
          entityType: auditEntities.supplierLead,
          entityId: leadId,
          before: changes.before,
          after: { ...changes.after, version: lead.version + 1 },
        },
        tx,
      );
    });
    return this.card(leadId);
  }

  async setStatus(
    leadId: string,
    input: SetSupplierLeadStatusBody,
    actor: SupplierAdminActor,
  ): Promise<AdminSupplierLeadCard> {
    await this.database.db.transaction(async (tx) => {
      const lead = await this.lock(tx, leadId, input.expectedVersion);
      const transition = supplierLeadTransition(lead.status, input.status);
      if (!transition.allowed) {
        throw leadState({ status: lead.status, refusal: transition.refusal });
      }
      const reason = input.reason ? normalizeText(input.reason) : null;
      if (transition.reasonRequired && !reason) {
        throw validationError(
          "reason",
          input.status === "rejected"
            ? "Say why the request is rejected"
            : "Say why the rejected request goes back to work",
        );
      }
      const now = new Date();
      await tx
        .update(supplierLead)
        .set({
          status: input.status,
          rejectReason: input.status === "rejected" ? reason : null,
          statusChangedAt: now,
          version: lead.version + 1,
          updatedAt: now,
        })
        .where(eq(supplierLead.id, leadId));
      await this.audit.record(
        {
          action: auditActions.supplierLeadStatusChanged,
          actor,
          entityType: auditEntities.supplierLead,
          entityId: leadId,
          before: { status: lead.status },
          after: { status: input.status, version: lead.version + 1 },
          reason,
        },
        tx,
      );
    });
    this.logger.log(`Supplier lead moved lead=${leadId} to=${input.status}`);
    return this.card(leadId);
  }

  async addNote(
    leadId: string,
    text: string,
    actor: SupplierAdminActor,
  ): Promise<AdminSupplierLeadCard> {
    await this.database.db.transaction(async (tx) => {
      const [lead] = await tx
        .select({ id: supplierLead.id })
        .from(supplierLead)
        .where(eq(supplierLead.id, leadId));
      if (!lead) {
        throw notFound("request");
      }
      await this.writeNote(tx, leadId, text, actor);
    });
    return this.card(leadId);
  }

  /**
   * A supplier from a request with a signed contract (A-SUP-04): the
   * supplier, its pickup point, its first employee and the invitation, and
   * the request `onboarded` pointing at it — one transaction.
   */
  async onboard(
    leadId: string,
    input: OnboardSupplierLeadBody,
    actor: SupplierAdminActor,
  ): Promise<SupplierOnboardedResponse> {
    const created = await this.database.db.transaction(async (tx) => {
      const lead = await this.lock(tx, leadId, input.expectedVersion);
      if (lead.status === "onboarded") {
        throw leadState({ status: lead.status, refusal: "final" });
      }
      if (!canOnboardLead(lead.status)) {
        throw leadState({ status: lead.status, refusal: "contract_not_signed" });
      }
      const contactPhone =
        input.contactPhone === undefined ? lead.phone : kzPhone("contactPhone", input.contactPhone);
      const newSupplier: NewSupplier = {
        name: normalizeText(input.name ?? lead.companyName),
        bin: input.bin === undefined ? lead.bin : kzBin("bin", input.bin),
        cityId: input.cityId ?? lead.cityId,
        type: input.type ?? lead.type,
        contactName: normalizeText(input.contactName ?? lead.contactName),
        contactPhone,
        address: input.address === undefined ? null : normalizeText(input.address),
        district: input.district === undefined ? null : normalizeText(input.district),
        firstMember: {
          name: normalizeText(input.firstMember?.name ?? lead.contactName),
          phone:
            input.firstMember?.phone === undefined
              ? lead.phone
              : kzPhone("firstMember.phone", input.firstMember.phone),
        },
        leadId,
      };
      const result = await this.suppliers.create(tx, newSupplier, actor);
      const now = new Date();
      await tx
        .update(supplierLead)
        .set({
          status: "onboarded",
          supplierId: result.supplierId,
          rejectReason: null,
          statusChangedAt: now,
          version: lead.version + 1,
          updatedAt: now,
        })
        .where(eq(supplierLead.id, leadId));
      await this.audit.record(
        {
          action: auditActions.supplierLeadStatusChanged,
          actor,
          entityType: auditEntities.supplierLead,
          entityId: leadId,
          before: { status: lead.status },
          after: { status: "onboarded", supplierId: result.supplierId, version: lead.version + 1 },
        },
        tx,
      );
      return result;
    });
    const [supplier, card] = await Promise.all([
      this.suppliers.adminCard(created.supplierId),
      this.card(leadId),
    ]);
    return {
      supplier,
      lead: card.lead,
      firstMember: created.firstMember,
      invitation: created.invitation,
    };
  }

  /** A supplier without a request (A-SUP-04 by hand). */
  async createSupplier(
    input: CreateSupplierBody,
    actor: SupplierAdminActor,
  ): Promise<SupplierOnboardedResponse> {
    const newSupplier: NewSupplier = {
      name: normalizeText(input.name),
      bin: kzBin("bin", input.bin),
      cityId: input.cityId,
      type: input.type,
      contactName: input.contactName === undefined ? null : normalizeText(input.contactName),
      contactPhone:
        input.contactPhone === undefined ? null : kzPhone("contactPhone", input.contactPhone),
      address: input.address === undefined ? null : normalizeText(input.address),
      district: input.district === undefined ? null : normalizeText(input.district),
      firstMember: {
        name: normalizeText(input.firstMember.name),
        phone: kzPhone("firstMember.phone", input.firstMember.phone),
      },
      leadId: null,
    };
    const created = await this.database.db.transaction((tx) =>
      this.suppliers.create(tx, newSupplier, actor),
    );
    return {
      supplier: await this.suppliers.adminCard(created.supplierId),
      lead: null,
      firstMember: created.firstMember,
      invitation: created.invitation,
    };
  }

  // --------------------------------------------------------------- helpers

  private async writeNote(
    tx: DbExecutor,
    leadId: string,
    text: string,
    actor: SupplierAdminActor,
  ): Promise<void> {
    const [note] = await tx
      .insert(supplierLeadNote)
      .values({ leadId, text: normalizeText(text), authorAdminId: adminIdOf(actor) })
      .returning({ id: supplierLeadNote.id });
    await this.audit.record(
      {
        action: auditActions.supplierLeadNoteAdded,
        actor,
        entityType: auditEntities.supplierLead,
        entityId: leadId,
        after: { noteId: note!.id },
      },
      tx,
    );
  }

  private async lock(
    tx: DbExecutor,
    leadId: string,
    expectedVersion: number,
  ): Promise<SupplierLeadRow> {
    const [lead] = await tx
      .select()
      .from(supplierLead)
      .where(eq(supplierLead.id, leadId))
      .for("update");
    if (!lead) {
      throw notFound("request");
    }
    if (lead.version !== expectedVersion) {
      throw supplierVersionConflict(lead.version);
    }
    return lead;
  }

  private async read(executor: DbExecutor, leadId: string): Promise<LeadListRow> {
    const [row] = await executor
      .select({
        lead: supplierLead,
        position: positionColumn,
        sameBinLeads: sameBinColumn,
        existingSupplierId: existingSupplierColumn,
      })
      .from(supplierLead)
      .where(eq(supplierLead.id, leadId));
    if (!row) {
      throw notFound("request");
    }
    return row;
  }

  private async citiesOf(
    ids: readonly string[],
    executor: DbExecutor = this.database.db,
  ): Promise<Map<string, CityRow>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await executor
      .select()
      .from(city)
      .where(sql`${city.id} = ANY(${`{${unique.join(",")}}`}::uuid[])`);
    return new Map(rows.map((row) => [row.id, row]));
  }

  private describe(row: LeadListRow, cityRow: CityRow): AdminSupplierLead {
    const { lead } = row;
    return {
      id: lead.id,
      companyName: lead.companyName,
      bin: lead.bin,
      city: cityRef(cityRow),
      type: lead.type,
      contactName: lead.contactName,
      phone: lead.phone,
      source: lead.source,
      status: lead.status,
      rejectReason: lead.rejectReason,
      language: lead.language,
      consentAt: lead.consentAt ? lead.consentAt.toISOString() : null,
      consentVersion: lead.consentVersion,
      supplierId: lead.supplierId,
      sameBinLeads: Number(row.sameBinLeads),
      existingSupplierId: row.existingSupplierId,
      version: lead.version,
      statusChangedAt: lead.statusChangedAt.toISOString(),
      createdAt: lead.createdAt.toISOString(),
      updatedAt: lead.updatedAt.toISOString(),
    };
  }
}

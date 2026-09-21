import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type CatalogLanguage,
  type SubmitSupplierLeadBody,
} from "@adclub/contracts";
import { maskBin, maskPhone } from "@adclub/domain";
import { and, eq, gte, sql } from "drizzle-orm";
import { rateLimitedException, serviceUnavailableException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { Metrics } from "../../observability";
import { RateLimiterService, RateLimiterUnavailableError } from "../../redis";
import { AuditLog } from "../audit";
import { normalizeText } from "../catalog";
import { AppSettings } from "../settings";
import { city, supplierLead } from "./schema";
import { kzBin, kzPhone, validationError } from "./supplier-common";

const RECEIVED = { status: "received" } as const;

/**
 * The public connection request form (TASK-016 requirement 2; PRODUCT
 * 12.1; SCREENS S-PUB-01; ARCHITECTURE 4.26). Every accepted request gets
 * the same answer — suppliers and earlier requests with its БИН are never
 * looked at before the answer is decided — and the number and the БИН
 * never reach the application log in full. The limit per client address
 * is the route's (`PublicRateLimitGuard`); the limit per number, the trap
 * field and the repeat of the same request are here. Served by the API
 * process only (it needs Redis).
 */
@Injectable()
export class SupplierLeadForm {
  private readonly logger = new Logger("SupplierLead");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(RateLimiterService) private readonly limiter: RateLimiterService,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  /**
   * `POST /supplier-leads`. The address limit was counted by the route's
   * guard; here — the trap field, the checks of the БИН, the number and
   * the city, the limit per number, and a repeat of the same request
   * within minutes (a double click) is not a second request.
   */
  async submit(
    input: SubmitSupplierLeadBody,
    fallbackLanguage: CatalogLanguage,
  ): Promise<typeof RECEIVED> {
    if (input.website !== undefined && input.website.trim() !== "") {
      // Answered as usual: the sender must not learn it was caught.
      this.logger.warn("Supplier lead dropped: the trap field was filled");
      return RECEIVED;
    }
    const bin = kzBin("bin", input.bin);
    const phone = kzPhone("phone", input.phone);
    const [cityRow] = await this.database.db.select().from(city).where(eq(city.id, input.cityId));
    if (cityRow?.status !== "active") {
      // An archived city is as unknown as a missing one to the public form.
      throw validationError("cityId", "No such city");
    }
    await this.limitPerPhone(phone);
    const [consentVersion, duplicateMinutes] = await Promise.all([
      this.settings.get("supplier_lead_consent_version"),
      this.settings.get("supplier_lead_duplicate_window_minutes"),
    ]);
    const outcome = await this.database.db.transaction(async (tx) => {
      // Two presses of the same form at once: one request.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`supplier_lead:${bin}:${phone}`}))`,
      );
      if (duplicateMinutes > 0) {
        const [recent] = await tx
          .select({ id: supplierLead.id })
          .from(supplierLead)
          .where(
            and(
              eq(supplierLead.bin, bin),
              eq(supplierLead.phone, phone),
              eq(supplierLead.source, "public_form"),
              gte(supplierLead.createdAt, new Date(Date.now() - duplicateMinutes * 60_000)),
            ),
          )
          .limit(1);
        if (recent) {
          return { kind: "duplicate" as const, id: recent.id };
        }
      }
      const [row] = await tx
        .insert(supplierLead)
        .values({
          companyName: normalizeText(input.companyName),
          bin,
          cityId: cityRow.id,
          type: input.type,
          contactName: normalizeText(input.contactName),
          phone,
          source: "public_form",
          language: input.language ?? fallbackLanguage,
          consentAt: new Date(),
          consentVersion,
        })
        .returning();
      await this.audit.record(
        {
          action: auditActions.supplierLeadCreated,
          actor: { role: "system" },
          entityType: auditEntities.supplierLead,
          entityId: row!.id,
          after: { source: "public_form", cityId: row!.cityId, type: row!.type, consentVersion },
        },
        tx,
      );
      return { kind: "created" as const, id: row!.id };
    });
    this.logger.log(
      outcome.kind === "created"
        ? `Supplier lead received lead=${outcome.id} bin=${maskBin(bin)} phone=${maskPhone(phone)} city=${cityRow.id} source=public_form`
        : `Supplier lead repeated within the window lead=${outcome.id} bin=${maskBin(bin)} phone=${maskPhone(phone)}`,
    );
    return RECEIVED;
  }

  private async limitPerPhone(phone: string): Promise<void> {
    const [max, windowSeconds] = await Promise.all([
      this.settings.get("supplier_lead_per_phone"),
      this.settings.get("supplier_lead_per_phone_window_seconds"),
    ]);
    let hit;
    try {
      hit = await this.limiter.hit(`public:supplier_lead_per_phone:${phone}`, {
        max,
        windowSeconds,
      });
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) {
        this.logger.warn(`Supplier lead refused without the limit: ${error.message}`);
        throw serviceUnavailableException();
      }
      throw error;
    }
    if (!hit.allowed) {
      this.metrics.countRateLimitHit("supplier_lead_per_phone");
      this.logger.warn(`Rate limit hit limit=supplier_lead_per_phone phone=${maskPhone(phone)}`);
      throw rateLimitedException("supplier_lead_per_phone", hit.retryAfterSeconds);
    }
  }
}

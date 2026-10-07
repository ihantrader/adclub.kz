import { Inject, Injectable } from "@nestjs/common";
import {
  catalogItemListQuerySchema,
  supplierLeadListQuerySchema,
  translationQueueQuerySchema,
  type AdminHome,
} from "@adclub/contracts";
import { AiService } from "../ai";
import { CatalogItemsService, TranslationAdminService } from "../catalog";
import { CompatibilityRecordsService } from "../compatibility";
import { AdminSignals } from "../signals";
import { SupplierLeadsService } from "../suppliers";

/**
 * The administrator's queue of attention (TASK-034 requirement 3; SCREENS
 * A-HOME; ARCHITECTURE 4.52 I549): every counter of the home screen in one
 * answer. A counter is the very rule of the list it leads to, asked of the
 * module that owns the data — the signals of `AdminSignals`, the funnel of
 * `SupplierLeadsService.list` (`counts.new`), the incomplete items of the
 * items list (`completeness=incomplete`), the translation queue — so the
 * number and the list never disagree. The counters without a list of their
 * own yet (no photo, no compatibility) are counted by their owners too.
 */
@Injectable()
export class AdminHomeService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AdminSignals) private readonly signals: AdminSignals,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(CatalogItemsService) private readonly items: CatalogItemsService,
    @Inject(TranslationAdminService) private readonly translations: TranslationAdminService,
    @Inject(CompatibilityRecordsService)
    private readonly compatibility: CompatibilityRecordsService,
    @Inject(SupplierLeadsService) private readonly leads: SupplierLeadsService,
  ) {}

  async summary(): Promise<AdminHome> {
    const [outage, signals, budget, leads, withoutPhoto, incomplete, compatibility, queue] =
      await Promise.all([
        this.signals.currentOfKind("whatsapp_outage"),
        this.signals.currentCounts(),
        this.ai.budget(),
        this.leads.list(supplierLeadListQuerySchema.parse({ status: "new", limit: 1 })),
        this.items.countActiveWithoutPhoto(),
        this.items.page(
          catalogItemListQuerySchema.parse({
            completeness: "incomplete",
            status: "active",
            limit: 1,
          }),
        ),
        this.compatibility.countActiveGoodsWithoutRecord(),
        this.translations.queueList(translationQueueQuerySchema.parse({ limit: 1 })),
      ]);
    return {
      channelOutage: outage
        ? {
            signalId: outage.id,
            status: outage.status,
            since: outage.payload.since ?? null,
            affectedOrders: outage.payload.affectedOrders ?? 0,
            failedMessages: outage.payload.failedMessages ?? 0,
          }
        : null,
      signals,
      aiBudget: {
        exhausted: budget.exhausted,
        spentUsd: budget.spentUsd,
        budgetUsd: budget.budgetUsd,
      },
      newSupplierLeads: leads.counts.new,
      catalog: {
        withoutPhoto,
        incomplete: incomplete.total,
        withoutCompatibility: compatibility,
        withoutTranslation: queue.counts.missing + queue.counts.failed,
      },
      at: new Date().toISOString(),
    };
  }
}

import { Inject, Injectable } from "@nestjs/common";
import {
  adminHomeCatalogFilters,
  catalogItemListQuerySchema,
  supplierLeadListQuerySchema,
  translationQueueQuerySchema,
  type AdminHome,
} from "@adclub/contracts";
import { AiService } from "../ai";
import { CatalogItemsService, TranslationAdminService, UNTRANSLATED_STATES } from "../catalog";
import { AdminSignals } from "../signals";
import { SupplierLeadsService } from "../suppliers";

/** The catalog cards, in the order their totals are read. */
const CATALOG_CARDS = [
  "withoutPhoto",
  "incomplete",
  "withoutCompatibility",
  "itemsWithoutTranslation",
] as const satisfies readonly (keyof typeof adminHomeCatalogFilters)[];

/**
 * The administrator's queue of attention (TASK-034 requirement 3; SCREENS
 * A-HOME; ARCHITECTURE 4.52 I549): every counter of the home screen in one
 * answer. A counter is the very rule of the list it leads to, asked of the
 * module that owns the data — the signals of `AdminSignals`, the funnel of
 * `SupplierLeadsService.list` (`counts.new`), the incomplete items of the
 * items list (`completeness=incomplete`), the translation queue — so the
 * number and the list never disagree. The quality of the catalog is the
 * `total` of the items list with the filter the card leads to (TASK-035):
 * no photo, incomplete, no compatibility, no translation of the name.
 */
@Injectable()
export class AdminHomeService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AdminSignals) private readonly signals: AdminSignals,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(CatalogItemsService) private readonly items: CatalogItemsService,
    @Inject(TranslationAdminService) private readonly translations: TranslationAdminService,
    @Inject(SupplierLeadsService) private readonly leads: SupplierLeadsService,
  ) {}

  async summary(): Promise<AdminHome> {
    const [outage, signals, budget, leads, quality, queue] = await Promise.all([
      this.signals.currentOfKind("whatsapp_outage"),
      this.signals.currentCounts(),
      this.ai.budget(),
      this.leads.list(supplierLeadListQuerySchema.parse({ status: "new", limit: 1 })),
      Promise.all(
        CATALOG_CARDS.map((card) =>
          this.items
            .page(catalogItemListQuerySchema.parse({ ...adminHomeCatalogFilters[card], limit: 1 }))
            .then((page) => page.total),
        ),
      ),
      this.translations.queueList(translationQueueQuerySchema.parse({ limit: 1 })),
    ]);
    const [withoutPhoto, incomplete, withoutCompatibility, itemsWithoutTranslation] = quality;
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
        withoutPhoto: withoutPhoto!,
        incomplete: incomplete!,
        withoutCompatibility: withoutCompatibility!,
        withoutTranslation: UNTRANSLATED_STATES.reduce(
          (sum, state) => sum + queue.counts[state],
          0,
        ),
        itemsWithoutTranslation: itemsWithoutTranslation!,
      },
      at: new Date().toISOString(),
    };
  }
}

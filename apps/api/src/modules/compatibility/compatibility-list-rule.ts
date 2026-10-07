import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { CatalogItemListRules } from "../catalog";

/**
 * «Без совместимости» (A-HOME, A-CAT-04; TASK-034, TASK-035): a part or a
 * product of a subcategory where compatibility is required (D-029), with no
 * approved record — the client catalog doesn't list it for any car.
 */
export function withoutApprovedCompatibility(item: SQL): SQL {
  return sql`(EXISTS (
      SELECT 1 FROM catalog_item ci JOIN category c ON c.id = ci.category_id
      WHERE ci.id = ${item} AND ci.item_type <> 'service' AND c.compatibility_required
    ) AND NOT EXISTS (
      SELECT 1 FROM item_compatibility r WHERE r.item_id = ${item} AND r.status = 'approved'
    ))`;
}

/** Gives the catalog's items list this module's rule (ARCHITECTURE 4.53). */
@Injectable()
export class CompatibilityListRule implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(CatalogItemListRules) private readonly rules: CatalogItemListRules) {}

  onModuleInit(): void {
    this.rules.registerWithoutCompatibility(withoutApprovedCompatibility);
  }
}

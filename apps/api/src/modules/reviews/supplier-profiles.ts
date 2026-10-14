import { Inject, Injectable } from "@nestjs/common";
import type { SupplierProfileResponse } from "@adclub/contracts";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { supplier } from "../identity";
import { offer, shownOffers } from "../offers";
import { customerOrder } from "../orders";
import { publicRatingFor } from "../ratings";
import { describeViewer, supplierShownTo, type Viewer } from "../showcase";

/**
 * M-CAT-09 «Поставщик: рейтинг и отзывы» without the reviews (TASK-050;
 * ARCHITECTURE 4.71): the rating, «Проверенный партнёр» and the two shares —
 * what the offer already shows to anyone, so every viewer gets them — and the
 * supplier itself by the rule of the showcase (`supplierShownTo`): its name
 * and id only with club access. The page is reached by an offer of the
 * catalog (a guest has no id of a supplier — I746) or by the user's own
 * order; neither answer names the supplier to a viewer who may not know it.
 * The reviews themselves — `GET /suppliers/{id}/reviews`, by the same rule.
 */
@Injectable()
export class SupplierProfiles {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** By an offer users see now; any other id — the same 404. */
  async ofOffer(offerId: string, viewer: Viewer): Promise<SupplierProfileResponse> {
    const [row] = await this.database.db
      .select({ supplierId: offer.supplierId })
      .from(offer)
      .where(and(eq(offer.id, offerId), shownOffers(new Date())));
    if (!row) {
      throw new ApiException(404, "NOT_FOUND", "No such offer");
    }
    return this.profile(row.supplierId, viewer);
  }

  /** By the user's own order; another user's — the same 404 as a missing one. */
  async ofOrder(
    orderId: string,
    viewer: Viewer & { accountId: string },
  ): Promise<SupplierProfileResponse> {
    const [row] = await this.database.db
      .select({ supplierId: customerOrder.supplierId })
      .from(customerOrder)
      .where(and(eq(customerOrder.id, orderId), eq(customerOrder.userAccountId, viewer.accountId)));
    if (!row) {
      throw new ApiException(404, "NOT_FOUND", "No such order");
    }
    return this.profile(row.supplierId, viewer);
  }

  private async profile(supplierId: string, viewer: Viewer): Promise<SupplierProfileResponse> {
    const db = this.database.db;
    const shown = supplierShownTo(viewer);
    const [[company], rating] = await Promise.all([
      db
        .select({
          id: supplier.id,
          name: supplier.name,
          verified: sql<boolean>`${isNotNull(supplier.verifiedAt)}`,
        })
        .from(supplier)
        .where(eq(supplier.id, supplierId)),
      publicRatingFor(db, supplierId),
    ]);
    if (!company) {
      throw new ApiException(404, "NOT_FOUND", "No such supplier");
    }
    return {
      viewer: describeViewer(viewer),
      supplier:
        shown.kind === "hidden" ? shown : { kind: "visible", id: company.id, name: company.name },
      verifiedPartner: company.verified,
      ...rating,
    };
  }
}

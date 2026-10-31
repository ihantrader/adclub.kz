import { Inject, Injectable } from "@nestjs/common";
import { ApiException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { eq } from "drizzle-orm";
import { supplier } from "../identity";
import { PaymentMethods } from "./payment-methods";
import { testBoundCard } from "./test-payment-provider";

/**
 * The card of a company for development and tests (D-041; ARCHITECTURE 4.72,
 * 4.77): `operator dev:supplier:card <supplierId> --linked|--unlinked` and the
 * integration tests of the showcase, the offers and the cabinet. Since
 * TASK-042 it is **not a second path** to `supplier.card_linked_at`: it links
 * a test card (or takes the card off) through `PaymentMethods`, the one
 * writer, so the column and the card table agree and the journal says the
 * same as for a card linked on the provider's page. The operator command
 * runs only in development and tests; there is no card here that was paid
 * for — it makes no charge and starts no subscription.
 */
@Injectable()
export class SupplierCards {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PaymentMethods) private readonly methods: PaymentMethods,
  ) {}

  async mark(
    supplierId: string,
    linked: boolean,
  ): Promise<{ supplierId: string; cardLinked: boolean; changed: boolean }> {
    return this.database.db.transaction(async (tx) => {
      const [company] = await tx
        .select({ id: supplier.id })
        .from(supplier)
        .where(eq(supplier.id, supplierId))
        .for("update");
      if (!company) {
        throw new ApiException(404, "NOT_FOUND", "No such supplier");
      }
      const active = await this.methods.active(tx, supplierId);
      if (linked) {
        if (active) {
          return { supplierId, cardLinked: true, changed: false };
        }
        const card = testBoundCard("ok");
        await this.methods.link(tx, {
          supplierId,
          provider: "test",
          token: card.token,
          mask: card.mask,
          brand: card.brand,
          expMonth: card.expMonth,
          expYear: card.expYear,
          bindingId: null,
          memberId: null,
          actor: { role: "operator" },
        });
        return { supplierId, cardLinked: true, changed: true };
      }
      const removed = await this.methods.remove(tx, supplierId, { role: "operator" });
      return { supplierId, cardLinked: false, changed: removed };
    });
  }
}

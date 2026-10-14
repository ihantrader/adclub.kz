import { Inject, Injectable } from "@nestjs/common";
import type { JobHandler, JobRunContext, JobRunOutcome, PeriodicJobHandler } from "../../jobs";
import { SupplierRatings } from "./supplier-ratings.service";

/** `ratings.recompute-supplier`: the rating of one supplier after an event. */
@Injectable()
export class SupplierRatingRecompute implements JobHandler<{ supplierId: string }> {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SupplierRatings) private readonly ratings: SupplierRatings) {}

  async run({ supplierId }: { supplierId: string }, _context: JobRunContext): Promise<void> {
    await this.ratings.recompute(supplierId, "event");
  }
}

/** `ratings.reconcile`: every supplier, by the same function, at night. */
@Injectable()
export class SupplierRatingReconcile implements PeriodicJobHandler {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SupplierRatings) private readonly ratings: SupplierRatings) {}

  async run(context: JobRunContext): Promise<JobRunOutcome> {
    const { corrected } = await this.ratings.reconcile(context.signal);
    return { worked: corrected > 0 };
  }
}

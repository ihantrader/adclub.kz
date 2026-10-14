import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { customerOrder, OrderFeedback, type UserOrderFeedback } from "../orders";
import { AppSettings } from "../settings";
import { ComplaintsService } from "./complaints.service";
import {
  adminComplaintViews,
  adminReviewViews,
  userComplaintView,
  userReviewView,
} from "./review-views";
import { ReviewsService } from "./reviews.service";
import { complaint } from "./schema";

/**
 * Gives the views of an order (`order-views`) this module's part (TASK-049):
 * the review and the complaints of an order, «Оценить» without the orders
 * already reviewed, A-ORD-01 «Есть жалоба». Registered when the module
 * starts; what each side sees of a review stays `review-views`.
 */
@Injectable()
export class ReviewFeedback implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(OrderFeedback) private readonly registry: OrderFeedback,
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
    @Inject(ComplaintsService) private readonly complaints: ComplaintsService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      forUser: (executor, orderIds) => this.forUser(executor, orderIds),
      reviewedOrderIds: async (executor, orderIds) =>
        new Set((await this.reviews.ofOrders(executor, orderIds)).map((row) => row.orderId)),
      forAdmin: async (executor, orderId) => {
        const [reviews, complaints] = await Promise.all([
          this.reviews.ofOrders(executor, [orderId]),
          this.complaints.ofOrders(executor, [orderId]),
        ]);
        const [review] = await adminReviewViews(executor, reviews);
        return {
          review: review ?? null,
          complaints: await adminComplaintViews(executor, complaints),
        };
      },
      hasComplaint: () =>
        sql`EXISTS (SELECT 1 FROM ${complaint} WHERE ${complaint.orderId} = ${customerOrder.id})`,
      // TASK-049.B: the counters of M-ORD-05 and M-ORD-06 count to what is refused.
      textLimits: async () => ({
        reviewText: await this.settings.get("review_text_max_length"),
        complaintText: await this.settings.get("complaint_text_max_length"),
      }),
    });
  }

  private async forUser(
    executor: DbExecutor,
    orderIds: readonly string[],
  ): Promise<Map<string, UserOrderFeedback>> {
    const [reviews, complaints] = await Promise.all([
      this.reviews.ofOrders(executor, orderIds),
      this.complaints.ofOrders(executor, orderIds),
    ]);
    const found = new Map<string, UserOrderFeedback>();
    for (const orderId of orderIds) {
      const review = reviews.find((row) => row.orderId === orderId);
      // Newest first: the first one is the latest.
      const latest = complaints.find((row) => row.orderId === orderId);
      found.set(orderId, {
        review: review ? userReviewView(review) : null,
        complaint: latest ? userComplaintView(latest) : null,
        complaintOpen: complaints.some(
          (row) => row.orderId === orderId && row.status !== "resolved",
        ),
      });
    }
    return found;
  }
}

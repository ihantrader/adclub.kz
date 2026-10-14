import { Injectable } from "@nestjs/common";
import {
  COMPLAINT_TEXT_LIMIT,
  REVIEW_TEXT_LIMIT,
  type AdminComplaint,
  type AdminReview,
  type UserOrderComplaint,
  type UserOrderReview,
} from "@adclub/contracts";
import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";

/** What the reviews module tells the card of a user's order (TASK-049). */
export interface UserOrderFeedback {
  review: UserOrderReview | null;
  /** The latest complaint about the order. */
  complaint: UserOrderComplaint | null;
  /** A complaint is open (new or in work): no other one now. */
  complaintOpen: boolean;
}

/** The review and the complaints of one order, for the administrator. */
export interface AdminOrderFeedback {
  review: AdminReview | null;
  complaints: AdminComplaint[];
}

/**
 * The reviews module's part of the views of an order (TASK-049; ARCHITECTURE
 * 4.69): the reviews module depends on this one (it reads the orders it is
 * about), so it registers its views here when it starts — as the offers
 * module does for the catalog's list (ARCHITECTURE 4.53 I556). What a side
 * sees of a review stays its rule; what it sees of an order — `order-views`.
 */
export interface OrderFeedbackSource {
  forUser(
    executor: DbExecutor,
    orderIds: readonly string[],
  ): Promise<Map<string, UserOrderFeedback>>;
  /** The orders that have a review (they are no longer «Оценить»). */
  reviewedOrderIds(executor: DbExecutor, orderIds: readonly string[]): Promise<Set<string>>;
  forAdmin(executor: DbExecutor, orderId: string): Promise<AdminOrderFeedback>;
  /** A-ORD-01 «Есть жалоба»: the condition on `customer_order`. */
  hasComplaint(): SQL;
  /** The longest texts of a review and a complaint the server takes now (TASK-049.B). */
  textLimits(): Promise<FeedbackTextLimits>;
}

/** `UserOrder.feedbackLimits`: what the counters of M-ORD-05 and M-ORD-06 count to. */
export interface FeedbackTextLimits {
  reviewText: number;
  complaintText: number;
}

const NONE: UserOrderFeedback = { review: null, complaint: null, complaintOpen: false };
/** Without the reviews module nothing is taken; the contract's own limits are said. */
const CONTRACT_LIMITS: FeedbackTextLimits = {
  reviewText: REVIEW_TEXT_LIMIT,
  complaintText: COMPLAINT_TEXT_LIMIT,
};

/**
 * The registry the reviews module registers its source in. Without it (the
 * operator command, a process without the reviews module) an order has no
 * review and no complaint.
 */
@Injectable()
export class OrderFeedback {
  private source: OrderFeedbackSource | null = null;

  register(source: OrderFeedbackSource): void {
    this.source = source;
  }

  async forUser(
    executor: DbExecutor,
    orderIds: readonly string[],
  ): Promise<Map<string, UserOrderFeedback>> {
    const found =
      this.source && orderIds.length > 0
        ? await this.source.forUser(executor, orderIds)
        : new Map();
    return new Map(orderIds.map((id) => [id, found.get(id) ?? NONE]));
  }

  reviewedOrderIds(executor: DbExecutor, orderIds: readonly string[]): Promise<Set<string>> {
    return this.source && orderIds.length > 0
      ? this.source.reviewedOrderIds(executor, orderIds)
      : Promise.resolve(new Set());
  }

  textLimits(): Promise<FeedbackTextLimits> {
    return this.source ? this.source.textLimits() : Promise.resolve(CONTRACT_LIMITS);
  }

  forAdmin(executor: DbExecutor, orderId: string): Promise<AdminOrderFeedback> {
    return this.source
      ? this.source.forAdmin(executor, orderId)
      : Promise.resolve({ review: null, complaints: [] });
  }

  /** Orders with a complaint (`true`) or without one (`false`). */
  complaintCondition(has: boolean): SQL {
    if (!this.source) {
      return has ? sql`false` : sql`true`;
    }
    const condition = this.source.hasComplaint();
    return has ? condition : sql`NOT (${condition})`;
  }
}

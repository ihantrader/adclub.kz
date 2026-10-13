import type {
  AdminComplaint,
  AdminReview,
  ComplaintConflictDetails,
  ReviewConflictDetails,
} from "@adclub/contracts";
import { ApiException } from "../../common/errors";

/**
 * Contract errors of reviews and complaints (TASK-049; ARCHITECTURE 4.69).
 * None of them carries the text of a review or a complaint, nor a phone.
 */

export function orderNotFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "No such order");
}

export function reviewNotFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "No such review");
}

export function complaintNotFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "No such complaint");
}

export function textTooLong(path: string, max: number): ApiException {
  const message = `At most ${String(max)} characters`;
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

export function reviewNotAllowed(reason: "not_completed" | "test_order"): ApiException {
  return new ApiException(
    409,
    "REVIEW_NOT_ALLOWED",
    reason === "test_order"
      ? "No review: this is a test order"
      : "An order is reviewed once it was given out (a visit once it was done)",
    { details: { reason } },
  );
}

export function reviewExists(reviewId: string): ApiException {
  return new ApiException(409, "REVIEW_EXISTS", "The order has a review already", {
    details: { reviewId },
  });
}

export function reviewState(reason: "edit_used" | "not_rejected"): ApiException {
  return new ApiException(
    409,
    "REVIEW_STATE",
    reason === "edit_used"
      ? "The text was corrected once already: publish the score alone"
      : "The text of the review is not refused",
    { details: { reason } },
  );
}

export function reviewConflict(review: AdminReview): ApiException {
  const details: ReviewConflictDetails = { review };
  return new ApiException(
    409,
    "REVIEW_CONFLICT",
    "The review was changed meanwhile; nothing was written",
    { details },
  );
}

export function complaintNotAllowed(
  reason: "order_not_accepted" | "not_received_requires_completed",
): ApiException {
  return new ApiException(
    409,
    "COMPLAINT_NOT_ALLOWED",
    reason === "order_not_accepted"
      ? "A complaint is about an order the supplier accepted or one that is over"
      : "«Не получил товар» is about an order that was given out",
    { details: { reason } },
  );
}

export function complaintExists(complaintId: string): ApiException {
  return new ApiException(409, "COMPLAINT_EXISTS", "The order has an open complaint", {
    details: { complaintId },
  });
}

export function complaintConflict(complaint: AdminComplaint): ApiException {
  const details: ComplaintConflictDetails = { complaint };
  return new ApiException(
    409,
    "COMPLAINT_CONFLICT",
    "The complaint was changed meanwhile; nothing was written",
    { details },
  );
}

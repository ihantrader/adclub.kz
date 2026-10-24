import type { AdminComplaint, AdminOrder, AdminReview } from "@adclub/contracts";
import { EmptyState, StatusBadge } from "@adclub/ui";
import { formatMoment } from "../format";
import { AppLink } from "../layout/layout";
import { complaintPath, routePaths, withQuery } from "../router";
import { ReviewCard } from "../reviews/ReviewList";
import { COMPLAINT_REASON_TEXT, COMPLAINT_STATUS_TEXT } from "../reviews/review-words";
import "../reviews/reviews.css";

/**
 * The review and the complaints of an order on its card (A-ORD-02; TASK-049,
 * TASK-080): the review is the card of «Отзывы» itself — the score, the text,
 * the reasons of a hold and the decisions it allows now; the complaints as
 * cards that open their own card. «Отзыва нет», «Жалоб нет» — compact empty
 * states (X18).
 */
export function OrderFeedback({
  order,
  onReviewChanged,
}: {
  order: AdminOrder;
  onReviewChanged: (review: AdminReview) => void;
}) {
  return (
    <div className="order-feedback">
      <section className="section" aria-labelledby="order-review-title">
        <div className="section__head">
          <h2 className="section__title" id="order-review-title">
            Отзыв
          </h2>
        </div>
        {order.review ? (
          <ReviewCard review={order.review} onChanged={onReviewChanged} />
        ) : (
          <EmptyState compact icon="star" title="Отзыва нет" />
        )}
      </section>
      <section className="section" aria-labelledby="order-complaints-title">
        <div className="section__head">
          <h2 className="section__title" id="order-complaints-title">
            Жалобы
          </h2>
          {order.complaints.length > 0 && (
            <AppLink href={withQuery(routePaths.orders, { hasComplaint: "true" })}>
              Все заявки с жалобами
            </AppLink>
          )}
        </div>
        {order.complaints.length === 0 ? (
          <EmptyState compact icon="circleCheck" title="Жалоб нет" />
        ) : (
          order.complaints.map((complaint) => (
            <ComplaintCard key={complaint.id} complaint={complaint} />
          ))
        )}
      </section>
    </div>
  );
}

function ComplaintCard({ complaint }: { complaint: AdminComplaint }) {
  return (
    <article className="card order-feedback__card">
      <div className="order-feedback__head">
        <AppLink href={complaintPath(complaint.id)} className="ac-text-body-strong">
          {COMPLAINT_REASON_TEXT[complaint.reason]}
        </AppLink>
        <StatusBadge kind="complaint" status={complaint.status}>
          {COMPLAINT_STATUS_TEXT[complaint.status]}
        </StatusBadge>
      </div>
      {complaint.text && <p className="ac-text-body-s order-feedback__text">{complaint.text}</p>}
      <span className="ac-text-caption ac-muted">Подана {formatMoment(complaint.createdAt)}</span>
    </article>
  );
}

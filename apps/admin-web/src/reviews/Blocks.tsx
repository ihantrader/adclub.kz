import type { AdminOrder, AdminReview } from "@adclub/contracts";
import { EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { AppLink } from "../catalog/shared";
import { routePaths, withQuery } from "../router";
import { LoadError, MoreButton } from "../vehicles/shared";
import { ComplaintRows, useComplaintList } from "./Complaints";
import { ReviewRows } from "./ReviewList";
import { useReviewList } from "./Reviews";

/**
 * The places reviews and complaints show up besides their section (TASK-049):
 * a supplier's «Отзывы» (A-SUP-03; every state — the rating is TASK-050), a
 * user's «Жалобы» (A-USR-02) and the order's card (A-ORD-02).
 */

export function SupplierReviews({ supplierId }: { supplierId: string }) {
  const { list, rows, changed, counts } = useReviewList({ supplierId });
  return (
    <>
      <p className="ac-text-body-s ac-muted">
        Всего: {list.total.toLocaleString("ru-RU")}
        {counts
          ? ` · опубликовано ${counts.published.toLocaleString("ru-RU")}, на проверке ${counts.held.toLocaleString("ru-RU")}, скрыто ${counts.hidden.toLocaleString("ru-RU")}`
          : ""}
        . Рейтинг поставщика появится отдельно.
      </p>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        {rows.length === 0 ? (
          <EmptyState
            icon="star"
            title="Отзывов пока нет"
            text="Отзывы оставляют по выданным заявкам"
          />
        ) : (
          <ReviewRows reviews={rows} onChanged={changed} hide={["supplier"]} />
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </>
  );
}

export function UserComplaints({ accountId }: { accountId: string }) {
  const list = useComplaintList({ accountId });
  return (
    <>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted">Всего: {list.total.toLocaleString("ru-RU")}</p>
        {list.items.length === 0 ? (
          <EmptyState icon="circleCheck" title="Жалоб нет" text="Пользователь не жаловался" />
        ) : (
          <ComplaintRows complaints={list.items} hide={["user"]} />
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </>
  );
}

/** The review and the complaints of an order (A-ORD-02). */
export function OrderFeedbackBlock({
  order,
  onReviewChanged,
}: {
  order: AdminOrder;
  onReviewChanged: (review: AdminReview) => void;
}) {
  return (
    <>
      <section className="card-section">
        <h2 className="ac-text-heading">Отзыв</h2>
        {order.review ? (
          <ReviewRows
            reviews={[order.review]}
            onChanged={onReviewChanged}
            hide={["order", "supplier"]}
          />
        ) : (
          <p className="ac-text-body-s ac-muted">Отзыва нет</p>
        )}
      </section>
      <section className="card-section">
        <h2 className="ac-text-heading">Жалобы</h2>
        {order.complaints.length > 0 ? (
          <ComplaintRows complaints={order.complaints} hide={["order", "supplier", "user"]} />
        ) : (
          <p className="ac-text-body-s ac-muted">Жалоб нет</p>
        )}
        {order.complaints.length > 0 && (
          <p className="ac-text-caption">
            <AppLink href={withQuery(routePaths.orders, { hasComplaint: "true" })}>
              Все заявки с жалобами
            </AppLink>
          </p>
        )}
      </section>
    </>
  );
}

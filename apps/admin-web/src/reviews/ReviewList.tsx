import {
  reviewRejectReasonSchema,
  type AdminReview,
  type ReviewRejectReason,
} from "@adclub/contracts";
import { Button, Dialog, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import { formatMoment } from "../format";
import { orderPath, supplierPath, userPath } from "../router";
import { ReasonDialog, WasNow } from "../suppliers/shared";
import {
  conflictReview,
  holdReasonText,
  REJECT_REASON_TEXT,
  REVIEW_STATUS_TEXT,
  reviewActions,
  reviewErrorText,
  reviewTone,
  scoreText,
  suggestedRejectReason,
} from "./review-words";

type Decision = "hide";

/**
 * The rows of reviews (A-REV-01; TASK-049) — the queue of «Отзывы», the tab
 * of a supplier's card and the block of an order's card: the score, the text,
 * the reasons of a hold with [AI] at what the model found, the order, the
 * supplier, the author, when; and the decisions the review allows now —
 * «Опубликовать» and «Отклонить текст…» (a reason from the list, the user
 * sees it) for a held one, «Скрыть…» with a reason for a published one,
 * «Вернуть» for a hidden one. Each goes with the version shown; a colleague's
 * earlier decision comes back in words and the row shows the review as it is
 * now.
 */
export function ReviewRows({
  reviews,
  onChanged,
  hide = [],
}: {
  reviews: readonly AdminReview[];
  onChanged: (review: AdminReview) => void;
  hide?: readonly ("supplier" | "order")[];
}) {
  const toast = useToast();
  const online = useOnline();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [rejecting, setRejecting] = useState<AdminReview | null>(null);
  const [deciding, setDeciding] = useState<{ review: AdminReview; decision: Decision } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const act = async (
    review: AdminReview,
    send: () => Promise<{ review: AdminReview }>,
    done: string,
  ): Promise<boolean> => {
    setBusy(review.id);
    setNotice(null);
    setError(null);
    try {
      const answer = await send();
      onChanged(answer.review);
      toast.show(done);
      return true;
    } catch (thrown) {
      const text = reviewErrorText(thrown);
      // A colleague decided first: the row shows the review as it is now.
      const current = conflictReview(thrown);
      if (current) onChanged(current);
      setNotice({ id: review.id, text });
      setError(text);
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">Оценка и текст</th>
              <th scope="col">Заявка и автор</th>
              <th scope="col">Статус</th>
              <th scope="col" className="admin-table__actions">
                Действия
              </th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((review) => {
              const actions = reviewActions(review.status);
              return (
                <tr key={review.id}>
                  <td>
                    <div className="cell-stack">
                      <span
                        className="ac-text-body-strong review-score"
                        aria-label={`Оценка ${review.score}`}
                      >
                        {scoreText(review.score)}
                      </span>
                      {review.text ? (
                        <span className="ac-text-body-s long-text review-text">{review.text}</span>
                      ) : (
                        <span className="ac-text-caption ac-muted">Только оценка</span>
                      )}
                      {review.holdReasons.length > 0 && (
                        <span className="ac-text-caption review-reasons">
                          Причины: {review.holdReasons.map(holdReasonText).join("; ")}
                        </span>
                      )}
                      {notice?.id === review.id && (
                        <span className="ac-text-caption dialog-error" role="alert">
                          {notice.text}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="cell-stack">
                      {!hide.includes("order") && (
                        <span className="ac-text-body-s">
                          <AppLink href={orderPath(review.order.id)}>
                            Заявка № {review.order.number}
                          </AppLink>
                        </span>
                      )}
                      {!hide.includes("supplier") && (
                        <span className="ac-text-body-s long-text">
                          <AppLink href={supplierPath(review.supplier.id)}>
                            {review.supplier.name}
                          </AppLink>
                        </span>
                      )}
                      <span className="ac-text-caption">
                        <AppLink href={userPath(review.author.accountId)}>
                          {review.author.name ?? "Без имени"}
                        </AppLink>{" "}
                        <span className="ac-muted num">{review.author.phone}</span>
                      </span>
                      <span className="ac-text-caption ac-muted">
                        {formatMoment(review.createdAt)}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span className={`status ${reviewTone(review.status)}`}>
                        {REVIEW_STATUS_TEXT[review.status]}
                      </span>
                      {review.rejection && review.status === "text_rejected" && (
                        <span className="ac-text-caption ac-muted">
                          {REJECT_REASON_TEXT[review.rejection.reason]} ·{" "}
                          {review.rejection.by.name ?? "администратор"},{" "}
                          {formatMoment(review.rejection.at)}
                        </span>
                      )}
                      {review.edited && (
                        <span className="ac-text-caption ac-muted">текст исправлен автором</span>
                      )}
                      {review.hidden && (
                        <span className="ac-text-caption ac-muted">
                          {review.hidden.reason} · {review.hidden.by.name ?? "администратор"},{" "}
                          {formatMoment(review.hidden.at)}
                        </span>
                      )}
                      {review.checkingSince && (
                        <span className="ac-text-caption ac-muted">
                          ждёт проверки с {formatMoment(review.checkingSince)}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="admin-table__actions">
                    <div className="button-row button-row--end">
                      {actions.publish && (
                        <Button
                          size="s"
                          disabled={!online}
                          loading={busy === review.id}
                          onClick={() =>
                            act(
                              review,
                              () =>
                                apiClient.publishAdminReview(
                                  { reviewId: review.id },
                                  { expectedVersion: review.version },
                                ),
                              "Отзыв опубликован",
                            )
                          }
                        >
                          Опубликовать
                        </Button>
                      )}
                      {actions.rejectText && (
                        <Button
                          variant="secondary"
                          size="s"
                          disabled={!online}
                          onClick={() => {
                            setError(null);
                            setRejecting(review);
                          }}
                        >
                          Отклонить текст…
                        </Button>
                      )}
                      {actions.hide && (
                        <Button
                          variant="secondary"
                          size="s"
                          disabled={!online}
                          onClick={() => {
                            setError(null);
                            setDeciding({ review, decision: "hide" });
                          }}
                        >
                          Скрыть…
                        </Button>
                      )}
                      {actions.restore && (
                        <Button
                          variant="secondary"
                          size="s"
                          disabled={!online}
                          loading={busy === review.id}
                          onClick={() =>
                            act(
                              review,
                              () =>
                                apiClient.restoreAdminReview(
                                  { reviewId: review.id },
                                  { expectedVersion: review.version },
                                ),
                              "Отзыв возвращён",
                            )
                          }
                        >
                          Вернуть
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <RejectDialog
        review={rejecting}
        busy={rejecting !== null && busy === rejecting.id}
        error={error}
        onClose={() => setRejecting(null)}
        onConfirm={async (reason) => {
          if (!rejecting) return;
          const done = await act(
            rejecting,
            () =>
              apiClient.rejectAdminReviewText(
                { reviewId: rejecting.id },
                { expectedVersion: rejecting.version, reason },
              ),
            "Текст отклонён — автор увидит причину",
          );
          if (done) setRejecting(null);
        }}
      />
      {deciding && (
        <ReasonDialog
          open
          title="Скрыть отзыв"
          confirm="Скрыть"
          busy={busy === deciding.review.id}
          error={error && <p className="dialog-error">{error}</p>}
          onClose={() => setDeciding(null)}
          onConfirm={async (reason) => {
            const done = await act(
              deciding.review,
              () =>
                apiClient.hideAdminReview(
                  { reviewId: deciding.review.id },
                  { expectedVersion: deciding.review.version, reason },
                ),
              "Отзыв скрыт",
            );
            if (done) setDeciding(null);
          }}
        >
          <WasNow was="Опубликован" now="Скрыт" />
          <p className="ac-text-body-s">
            Отзыв пропадёт со страницы поставщика. Автору об этом не сообщается — у него отзыв
            по-прежнему «опубликован». Причину видят только администраторы.
          </p>
        </ReasonDialog>
      )}
    </>
  );
}

const REASONS = reviewRejectReasonSchema.options;

/** «Отклонить текст» with a reason from the list — the user sees it (T-REV-02). */
function RejectDialog({
  review,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  review: AdminReview | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: ReviewRejectReason) => void;
}) {
  const [reason, setReason] = useState<ReviewRejectReason>("personal_data");
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (review && shownFor !== review.id) {
    setShownFor(review.id);
    setReason(suggestedRejectReason(review));
  }
  return (
    <Dialog
      open={review !== null}
      onClose={onClose}
      title="Отклонить текст отзыва"
      actions={
        <>
          <Button onClick={() => onConfirm(reason)} loading={busy}>
            Отклонить текст
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
        </>
      }
    >
      {review && (
        <div className="dialog-stack">
          <WasNow was="На проверке" now="Текст отклонён" />
          <label className="select">
            <span className="ac-text-caption ac-muted">Причина (её увидит автор)</span>
            <select
              value={reason}
              onChange={(event) => setReason(event.target.value as ReviewRejectReason)}
            >
              {REASONS.map((value) => (
                <option key={value} value={value}>
                  {REJECT_REASON_TEXT[value]}
                </option>
              ))}
            </select>
          </label>
          <p className="ac-text-body-s">
            Автор увидит: «Отзыв не опубликован: {REJECT_REASON_TEXT[reason]}. Исправьте текст или
            опубликуйте только оценку».{" "}
            {review.edited
              ? "Текст уже исправлялся — автору останется только опубликовать оценку."
              : "Исправить текст можно один раз."}
          </p>
          {error && <p className="dialog-error">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}

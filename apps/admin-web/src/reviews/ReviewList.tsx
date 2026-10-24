import {
  reviewRejectReasonSchema,
  type AdminReview,
  type ReviewRejectReason,
} from "@adclub/contracts";
import {
  AiBadge,
  Button,
  cx,
  Dialog,
  Icon,
  MenuButton,
  Select,
  StatusBadge,
  useToast,
  type MenuAction,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { AppLink, Table, type Column } from "../layout/layout";
import { orderPath, userPath } from "../router";
import { WasNow } from "../suppliers/shared";
import { ReasonDialog } from "../layout/ReasonDialog";
import {
  conflictReview,
  holdReasonWords,
  REJECT_REASON_TEXT,
  REVIEW_STATUS_TEXT,
  reviewActions,
  reviewErrorText,
  suggestedRejectReason,
} from "./review-words";

/** «Имя, 14 окт., 18:41» of an administrator's decision. */
function byAt(name: string | null | undefined, at: string | null | undefined): string {
  return `${name ?? "администратор"}, ${formatMoment(at)}`;
}

/** The score in stars `accent` and its number (DESIGN 7.7: the star of a rating is `accent` everywhere). */
export function ReviewStars({ score }: { score: number }) {
  return (
    <span className="review-stars" role="img" aria-label={`Оценка ${score} из 5`}>
      {[1, 2, 3, 4, 5].map((place) => (
        <Icon
          key={place}
          name="star"
          size={16}
          filled={place <= score}
          className={place <= score ? undefined : "review-stars__off"}
        />
      ))}
      <span className="review-stars__value" aria-hidden="true">
        {score}
      </span>
    </span>
  );
}

/** A text over three lines this long folds without measuring (a page without `ResizeObserver`). */
const LONG_TEXT = 240;

/**
 * A review's text in three lines with «Показать полностью» (a Kazakh review
 * of ten lines does not stretch the row); whether it overflows is measured
 * on the text itself, whatever the width of its column.
 */
function ReviewText({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [measured, setMeasured] = useState<{ text: string; long: boolean } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || open || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setMeasured({ text, long: element.scrollHeight > element.clientHeight + 1 });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);
  const long =
    measured?.text === text
      ? measured.long
      : text.length > LONG_TEXT || text.split("\n").length > 3;
  return (
    <>
      <p ref={ref} className={cx("review-body", !open && "review-body--folded")}>
        {text}
      </p>
      {(long || open) && (
        <Button variant="text" size="s" onClick={() => setOpen(!open)}>
          {open ? "Свернуть" : "Показать полностью"}
        </Button>
      )}
    </>
  );
}

/** The reasons of a hold: muted, what the model found marked [AI] in the AI color (X26). */
function HoldReasons({ review }: { review: AdminReview }) {
  if (review.holdReasons.length === 0) return null;
  return (
    <span className="review-why">
      <span>Причины:</span>
      {review.holdReasons.map((reason, index) => (
        <span key={`${reason.kind}-${String(index)}`} className="review-why__reason">
          {reason.source === "ai" && <AiBadge>AI</AiBadge>}
          <span>
            {holdReasonWords(reason)}
            {index < review.holdReasons.length - 1 ? ";" : ""}
          </span>
        </span>
      ))}
    </span>
  );
}

/** The score, the text (or «Только оценка»), the reasons of a hold. */
function ReviewContent({ review, notice }: { review: AdminReview; notice?: string }) {
  return (
    <div className="review-cell">
      <ReviewStars score={review.score} />
      {review.text ? (
        <ReviewText text={review.text} />
      ) : (
        <span className="ac-text-caption ac-muted">Только оценка</span>
      )}
      <HoldReasons review={review} />
      {notice && (
        <span className="review-alert" role="alert">
          {notice}
        </span>
      )}
    </div>
  );
}

/** The status and what happened to it: who refused or hid, since when it waits. */
function ReviewStatus({ review }: { review: AdminReview }) {
  return (
    <div className="review-cell">
      <StatusBadge kind="review" status={review.status}>
        {REVIEW_STATUS_TEXT[review.status]}
      </StatusBadge>
      {review.rejection && review.status === "text_rejected" && (
        <>
          <span className="review-line review-line--caption">
            {REJECT_REASON_TEXT[review.rejection.reason]}
          </span>
          <span
            className="review-line review-line--caption"
            title={byAt(review.rejection.by.name, review.rejection.at)}
          >
            {byAt(review.rejection.by.name, review.rejection.at)}
          </span>
        </>
      )}
      {review.edited && (
        <span className="review-line review-line--caption">текст исправлен автором</span>
      )}
      {review.hidden && (
        <>
          <span className="ac-text-caption ac-muted clamp" title={review.hidden.reason}>
            {review.hidden.reason}
          </span>
          <span
            className="review-line review-line--caption"
            title={byAt(review.hidden.by.name, review.hidden.at)}
          >
            {byAt(review.hidden.by.name, review.hidden.at)}
          </span>
        </>
      )}
      {review.checkingSince && (
        <span className="review-line review-line--caption">
          ждёт проверки с {formatMoment(review.checkingSince)}
        </span>
      )}
    </div>
  );
}

/** The author: the name (or «Имя не указано»), the hidden number, when the review was left. */
function ReviewAuthor({ review }: { review: AdminReview }) {
  return (
    <div className="review-cell">
      <span className="review-line ac-text-body-s" title={review.author.name ?? undefined}>
        <AppLink className="review-link" href={userPath(review.author.accountId)}>
          {review.author.name ?? <span className="ac-muted">Имя не указано</span>}
        </AppLink>
      </span>
      <span className="review-line review-line--caption">{review.author.phone}</span>
      <span className="review-line review-line--caption">{formatMoment(review.createdAt)}</span>
    </div>
  );
}

/**
 * The decisions on reviews (A-REV-01; TASK-049): «Опубликовать» and
 * «Отклонить текст…» (a reason from the list, the author sees it) for a held
 * one, «Скрыть…» with a reason for a published one, «Вернуть» for a hidden
 * one. Each goes with the version shown; a colleague's earlier decision comes
 * back in words and the review is shown as it is now.
 */
function useReviewDecisions(onChanged: (review: AdminReview) => void) {
  const toast = useToast();
  const online = useOnline();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [rejecting, setRejecting] = useState<AdminReview | null>(null);
  const [hiding, setHiding] = useState<AdminReview | null>(null);
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
      // A colleague decided first: the review is shown as it is now.
      const current = conflictReview(thrown);
      if (current) onChanged(current);
      setNotice({ id: review.id, text });
      setError(text);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const publish = (review: AdminReview) =>
    act(
      review,
      () =>
        apiClient.publishAdminReview({ reviewId: review.id }, { expectedVersion: review.version }),
      "Отзыв опубликован",
    );

  const restore = (review: AdminReview) =>
    act(
      review,
      () =>
        apiClient.restoreAdminReview({ reviewId: review.id }, { expectedVersion: review.version }),
      "Отзыв возвращён",
    );

  /**
   * What a review allows now: at most one small button — the primary
   * «Опубликовать» only in the queue «На проверке» — and the rarer
   * decisions in «⋯» (X6, X27).
   */
  const actionsOf = (
    review: AdminReview,
    queue: boolean,
  ): { button: ReactNode; menu: MenuAction[] } => {
    const allowed = reviewActions(review.status);
    const menu: MenuAction[] = [];
    let button: ReactNode = null;
    if (allowed.publish) {
      button = (
        <Button
          size="s"
          variant={queue ? "primary" : "secondary"}
          disabled={!online}
          loading={busy === review.id}
          onClick={() => publish(review)}
        >
          Опубликовать
        </Button>
      );
    }
    if (allowed.restore) {
      button = (
        <Button
          size="s"
          variant="secondary"
          disabled={!online}
          loading={busy === review.id}
          onClick={() => restore(review)}
        >
          Вернуть
        </Button>
      );
    }
    if (allowed.rejectText) {
      menu.push({
        key: "reject",
        label: "Отклонить текст…",
        icon: "circleX",
        destructive: true,
        disabled: !online,
        onSelect: () => {
          setError(null);
          setRejecting(review);
        },
      });
    }
    if (allowed.hide) {
      menu.push({
        key: "hide",
        label: "Скрыть…",
        icon: "prohibit",
        destructive: true,
        disabled: !online,
        onSelect: () => {
          setError(null);
          setHiding(review);
        },
      });
    }
    return { button, menu };
  };

  const dialogs = (
    <>
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
      {hiding && (
        <ReasonDialog
          open
          title="Скрыть отзыв"
          confirm="Скрыть"
          busy={busy === hiding.id}
          error={error && <p className="dialog-error">{error}</p>}
          onClose={() => setHiding(null)}
          onConfirm={async (reason) => {
            const done = await act(
              hiding,
              () =>
                apiClient.hideAdminReview(
                  { reviewId: hiding.id },
                  { expectedVersion: hiding.version, reason },
                ),
              "Отзыв скрыт",
            );
            if (done) setHiding(null);
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

  return { notice, actionsOf, dialogs };
}

/** The actions of one review: the button and «⋯», right-aligned. */
function ReviewRowActions({ button, menu }: { button: ReactNode; menu: readonly MenuAction[] }) {
  return (
    <div className="row-actions">
      {button}
      {menu.length > 0 && <MenuButton size="s" label="Ещё действия с отзывом" actions={menu} />}
    </div>
  );
}

/**
 * The rows of reviews (A-REV-01; TASK-049, TASK-080) — the list of «Отзывы»
 * and the tab of a supplier's card: the review (score, text in three lines,
 * the reasons of a hold), the order with its supplier, the author, the
 * status. The columns keep their widths on every status; the column of
 * actions is there only while a row has one.
 */
export function ReviewRows({
  reviews,
  onChanged,
  hide = [],
  queue = false,
}: {
  reviews: readonly AdminReview[];
  onChanged: (review: AdminReview) => void;
  hide?: readonly ("supplier" | "order")[];
  /** The queue «На проверке» of the section: «Опубликовать» is the primary action there only. */
  queue?: boolean;
}) {
  const { notice, actionsOf, dialogs } = useReviewDecisions(onChanged);
  const rows = reviews.map((review) => ({ review, ...actionsOf(review, queue) }));
  const withActions = rows.some((row) => row.button !== null || row.menu.length > 0);
  const columns: Column[] = [
    { key: "review", header: "Отзыв" },
    ...(hide.includes("order") ? [] : [{ key: "order", header: "Заявка", width: 210 }]),
    { key: "author", header: "Автор", width: 190 },
    { key: "status", header: "Статус", width: 190 },
    ...(withActions
      ? [{ key: "actions", header: "Действия", width: 196, actions: true, hiddenHeader: true }]
      : []),
  ];

  return (
    <>
      <Table label="Отзывы" columns={columns} className="review-table">
        {rows.map(({ review, button, menu }) => {
          const order = hide.includes("supplier")
            ? `№ ${String(review.order.number)}`
            : `№ ${String(review.order.number)} · ${review.supplier.name}`;
          return (
            <tr key={review.id}>
              <td>
                <ReviewContent
                  review={review}
                  notice={notice?.id === review.id ? notice.text : undefined}
                />
              </td>
              {!hide.includes("order") && (
                <td>
                  <span className="review-line ac-text-body-s" title={order}>
                    <AppLink className="review-link" href={orderPath(review.order.id)}>
                      № {review.order.number}
                    </AppLink>
                    {!hide.includes("supplier") && (
                      <span className="ac-muted"> · {review.supplier.name}</span>
                    )}
                  </span>
                </td>
              )}
              <td>
                <ReviewAuthor review={review} />
              </td>
              <td>
                <ReviewStatus review={review} />
              </td>
              {withActions && (
                <td className="admin-table__actions">
                  <ReviewRowActions button={button} menu={menu} />
                </td>
              )}
            </tr>
          );
        })}
      </Table>
      {dialogs}
    </>
  );
}

/**
 * The review of an order (A-ORD-02): one card rather than a table of one
 * row — the score and the text, the author and when, the status, and the
 * decisions the review allows now.
 */
export function ReviewCard({
  review,
  onChanged,
}: {
  review: AdminReview;
  onChanged: (review: AdminReview) => void;
}) {
  const { notice, actionsOf, dialogs } = useReviewDecisions(onChanged);
  const { button, menu } = actionsOf(review, false);
  return (
    <div className="card review-card">
      <div className="review-card__head">
        <ReviewStars score={review.score} />
        <StatusBadge kind="review" status={review.status}>
          {REVIEW_STATUS_TEXT[review.status]}
        </StatusBadge>
        <span className="review-card__meta">
          {review.author.name ?? "Имя не указано"} · {review.author.phone} ·{" "}
          {formatMoment(review.createdAt)}
        </span>
      </div>
      <ReviewContentBody
        review={review}
        notice={notice?.id === review.id ? notice.text : undefined}
      />
      {(button !== null || menu.length > 0) && <ReviewRowActions button={button} menu={menu} />}
      {dialogs}
    </div>
  );
}

/** The text, the reasons and the status details of the review card (the score is in its head). */
function ReviewContentBody({ review, notice }: { review: AdminReview; notice?: string }) {
  return (
    <div className="review-cell">
      {review.text ? (
        <ReviewText text={review.text} />
      ) : (
        <span className="ac-text-caption ac-muted">Только оценка</span>
      )}
      <HoldReasons review={review} />
      {review.rejection && review.status === "text_rejected" && (
        <span className="ac-text-caption ac-muted">
          Текст отклонён: {REJECT_REASON_TEXT[review.rejection.reason]} ·{" "}
          {byAt(review.rejection.by.name, review.rejection.at)}
        </span>
      )}
      {review.edited && <span className="ac-text-caption ac-muted">текст исправлен автором</span>}
      {review.hidden && (
        <span className="ac-text-caption ac-muted">
          Скрыт: {review.hidden.reason} · {byAt(review.hidden.by.name, review.hidden.at)}
        </span>
      )}
      {review.checkingSince && (
        <span className="ac-text-caption ac-muted">
          ждёт проверки с {formatMoment(review.checkingSince)}
        </span>
      )}
      {notice && (
        <span className="review-alert" role="alert">
          {notice}
        </span>
      )}
    </div>
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
          <Select<ReviewRejectReason>
            label="Причина (её увидит автор)"
            value={reason}
            onChange={setReason}
            options={REASONS.map((value) => ({ value, label: REJECT_REASON_TEXT[value] }))}
          />
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

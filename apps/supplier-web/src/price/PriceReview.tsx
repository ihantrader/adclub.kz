import type {
  DecidePriceRowBody,
  OfferItem,
  PriceImport,
  PriceMissingPage,
  PriceReviewGroup,
  PriceReviewRow,
  PriceReviewSummary,
} from "@adclub/contracts";
import {
  AiBadge,
  Badge,
  Banner,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Icon,
  LoadingContent,
  Radio,
  ScreenError,
  SkeletonList,
  Switch,
  useLoadingGate,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { useLanguage } from "../i18n";
import { formatWhen } from "../orders/order-rules";
import { categoryLine } from "../offers/offer-rules";
import { useWide } from "../offers/use-wide";
import { replaceRouteState, useRouteState } from "../router";
import { ItemPicker } from "./ItemPicker";
import { formatNumber, rowErrorText } from "./price-rules";
import {
  applyBlocked,
  applyNotes,
  applyText,
  changeLines,
  chosenItem,
  decidedText,
  fileText,
  firstTab,
  noteText,
  REVIEW_TABS,
  reviewRefusal,
  summaryText,
  tabLabel,
  missingOrdersText,
  uncheckedText,
  type ReviewRefusal,
  type ReviewTab,
} from "./review-rules";

const PAGE = 50;

/** What a change of the review sends; the version is the screen's latest. */
type Change = (version: number) => Promise<PriceImport>;

interface Refused extends ReviewRefusal {
  /** «Повторить моё решение»: the same change at the version read again. */
  repeat: (() => void) | null;
}

/**
 * S-PRICE-03 «Сверка» (TASK-048): the summary of the server, five tabs, the
 * rows a page at a time — cards on a phone, a table from 1024 — the
 * decisions one row at a time («Пропустить все оставшиеся» is the only
 * action on many rows; nothing confirms in bulk, D-039), the one choice
 * about the offers missing in the file, and «Применить» with the numbers
 * of the server's preview.
 *
 * Every decision is kept on the server at once: leaving the page and coming
 * back goes on where it stopped. A colleague who changed the review in
 * another tab makes the server refuse with their name — the screen reads
 * the review again and offers to repeat the decision with one press.
 */
export function PriceReview({
  entry,
  timeZone,
  onLeft,
}: {
  entry: PriceImport;
  timeZone: string;
  /** The upload left the review (applied, being applied, expired): read it again. */
  onLeft: () => void;
}) {
  const { t, lang } = useLanguage();
  const online = useOnline();
  const opened = useRouteState() as { reviewTab?: ReviewTab } | null;
  const gate = useLoadingGate();
  const [summary, setSummary] = useState<PriceReviewSummary | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [tab, setTabState] = useState<ReviewTab | null>(opened?.reviewTab ?? null);
  const [refused, setRefused] = useState<Refused | null>(null);
  const [busy, setBusy] = useState(false);
  const [lists, setLists] = useState(0);
  const [confirmApply, setConfirmApply] = useState(false);
  const version = useRef(entry.version);
  const { begin, settle } = gate;

  const load = useCallback(async () => {
    const ticket = begin();
    try {
      const next = await apiClient.getPriceImportReview({ importId: entry.id });
      settle(ticket, () => {
        version.current = next.import.version;
        setSummary(next);
        setFailure(null);
        setTabState((current) => current ?? firstTab(next));
      });
      if (next.import.status !== "review") onLeft();
    } catch (error) {
      settle(ticket, () => setFailure(error));
    }
  }, [entry.id, begin, settle, onLeft]);

  useEffect(() => {
    void load();
  }, [load]);

  const setTab = (next: ReviewTab) => {
    setTabState(next);
    replaceRouteState({ reviewTab: next });
  };

  /** Sends a change of the review; refused — says why and, where it can, offers to repeat it. */
  const run = useCallback(
    async (change: Change): Promise<boolean> => {
      setBusy(true);
      setRefused(null);
      try {
        const updated = await change(version.current);
        version.current = updated.version;
        if (updated.status !== "review") {
          onLeft();
          return true;
        }
        await load();
        return true;
      } catch (error) {
        const refusal = reviewRefusal(error, timeZone, lang, t);
        setRefused({
          ...refusal,
          repeat: refusal.repeatable
            ? () => {
                void run(change).then((done) => {
                  if (done) setLists((n) => n + 1);
                });
              }
            : null,
        });
        if (refusal.left) onLeft();
        else if (refusal.reload) {
          await load();
          setLists((n) => n + 1);
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, onLeft, timeZone, lang, t],
  );

  /** A decision on one row; resolves with the row as the server keeps it now. */
  const decide = useCallback(
    async (rowNo: number, body: Omit<DecidePriceRowBody, "expectedVersion">) => {
      let row: PriceReviewRow | null = null;
      await run(async (expectedVersion) => {
        const answer = await apiClient.decidePriceReviewRow(
          { importId: entry.id, rowNo: String(rowNo) },
          { expectedVersion, ...body },
        );
        row = answer.row;
        return answer.import;
      });
      return row as PriceReviewRow | null;
    },
    [run, entry.id],
  );

  if (failure !== null && !summary) {
    return (
      <ScreenError
        title={t("common.errorTitle")}
        text={t("common.errorText")}
        retry={{ label: t("common.retry"), onRetry: () => load() }}
      />
    );
  }

  return (
    <LoadingContent
      ready={summary !== null && tab !== null}
      indicator={gate.indicator}
      skeleton={<SkeletonList rows={4} label={t("common.loading")} />}
      label={t("common.loading")}
    >
      {summary && tab && (
        <div className="price-review">
          <section className="card price-review__summary" aria-label={t("review.title")}>
            <p className="ac-text-body-strong">{summaryText(summary, t, lang)}</p>
            {summary.import.reviewUntil && (
              <p className="ac-text-body-s ac-muted">
                {t("review.until", {
                  when: formatWhen(summary.import.reviewUntil, timeZone, lang, t),
                })}
              </p>
            )}
          </section>

          {refused && (
            <Banner
              tone={refused.repeatable ? "warning" : "danger"}
              icon="alertTriangle"
              action={
                refused.repeat && (
                  <Button variant="text" size="s" onClick={refused.repeat} disabled={busy}>
                    {t("review.repeat")}
                  </Button>
                )
              }
            >
              {refused.text}
            </Banner>
          )}

          <div className="price-tabs" role="tablist" aria-label={t("review.tabsLabel")}>
            {REVIEW_TABS.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={tab === key ? "price-tab price-tab--on" : "price-tab"}
                onClick={() => setTab(key)}
              >
                {tabLabel(summary, key, t)}
              </button>
            ))}
          </div>

          <div role="tabpanel" className="price-review__panel">
            {tab === "missing" ? (
              <MissingOffers
                key={`missing-${String(lists)}`}
                summary={summary}
                busy={busy}
                onChoose={(action) =>
                  run((expectedVersion) =>
                    apiClient
                      .choosePriceMissingAction({ importId: entry.id }, { expectedVersion, action })
                      .then((answer) => answer.import),
                  )
                }
              />
            ) : (
              <ReviewRows
                key={`${tab}-${String(lists)}`}
                importId={entry.id}
                group={tab}
                summary={summary}
                timeZone={timeZone}
                busy={busy}
                decide={decide}
                onSkipRemaining={() =>
                  run((expectedVersion) =>
                    apiClient
                      .skipRemainingPriceRows({ importId: entry.id }, { expectedVersion })
                      .then((answer) => answer.import),
                  ).then((done) => {
                    if (done) setLists((n) => n + 1);
                  })
                }
              />
            )}
          </div>

          <ApplyBar
            summary={summary}
            online={online}
            busy={busy}
            onApply={() => setConfirmApply(true)}
            onMissing={() => setTab("missing")}
          />

          <Dialog
            open={confirmApply}
            onClose={() => setConfirmApply(false)}
            title={t("review.applyTitle")}
            actions={
              <>
                <Button
                  loading={busy}
                  onClick={() => {
                    void run((expectedVersion) =>
                      apiClient
                        .applyPriceImport({ importId: entry.id }, { expectedVersion })
                        .then((answer) => answer.import),
                    ).then(() => setConfirmApply(false));
                  }}
                >
                  {t("review.applyConfirm")}
                </Button>
                <Button variant="secondary" onClick={() => setConfirmApply(false)}>
                  {t("common.cancel")}
                </Button>
              </>
            }
          >
            <p>
              {t("review.applyText", {
                update: formatNumber(summary.preview.update),
                create: formatNumber(summary.preview.create),
                withdraw: formatNumber(summary.preview.withdraw),
                request: formatNumber(summary.preview.request),
              })}
            </p>
            {applyNotes(summary, t, lang).map((note) => (
              <p key={note} className="ac-muted">
                {note}
              </p>
            ))}
          </Dialog>
        </div>
      )}
    </LoadingContent>
  );
}

/** «Применить: …» with what keeps it off and the rows it leaves out. */
function ApplyBar({
  summary,
  online,
  busy,
  onApply,
  onMissing,
}: {
  summary: PriceReviewSummary;
  online: boolean;
  busy: boolean;
  onApply: () => void;
  onMissing: () => void;
}) {
  const { t, lang } = useLanguage();
  const blocked = applyBlocked(summary, online);
  return (
    <section className="card price-apply" aria-label={t("review.applySection")}>
      {applyNotes(summary, t, lang).map((note) => (
        <p key={note} className="ac-text-body-s price-apply__note">
          <Icon name="info" size={16} />
          <span>{note}</span>
        </p>
      ))}
      {blocked === "missing_choice" && (
        <p className="ac-text-body-s price-apply__blocked">
          <Icon name="alertTriangle" size={16} />
          <span>
            {t("review.applyNeedsMissing")}{" "}
            <button type="button" className="text-link" onClick={onMissing}>
              {t("review.tab.missing")}
            </button>
          </span>
        </p>
      )}
      {blocked === "offline" && (
        <p className="ac-text-body-s price-apply__blocked">{t("common.needNetwork")}</p>
      )}
      <Button disabled={blocked !== null || busy} onClick={onApply}>
        {applyText(summary, t)}
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------- rows

function ReviewRows({
  importId,
  group,
  summary,
  timeZone,
  busy,
  decide,
  onSkipRemaining,
}: {
  importId: string;
  group: PriceReviewGroup;
  summary: PriceReviewSummary;
  timeZone: string;
  busy: boolean;
  decide: (
    rowNo: number,
    body: Omit<DecidePriceRowBody, "expectedVersion">,
  ) => Promise<PriceReviewRow | null>;
  onSkipRemaining: () => void;
}) {
  const { t, lang } = useLanguage();
  const wide = useWide();
  const [rows, setRows] = useState<PriceReviewRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const page = useCallback(
    async (from: string | null) => {
      const answer = await apiClient.listPriceReviewRows(
        { importId },
        { query: { group, limit: PAGE, ...(from ? { cursor: from } : {}) } },
      );
      return answer;
    },
    [importId, group],
  );

  useEffect(() => {
    let live = true;
    page(null).then(
      (answer) => {
        if (!live) return;
        setRows(answer.rows);
        setCursor(answer.nextCursor);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [page]);

  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const answer = await page(cursor);
      setRows((current) => [...(current ?? []), ...answer.rows]);
      setCursor(answer.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const onDecided = (row: PriceReviewRow) =>
    setRows(
      (current) => current?.map((entry) => (entry.rowNo === row.rowNo ? row : entry)) ?? null,
    );

  if (failed && !rows) {
    return <Banner tone="danger">{t("common.errorText")}</Banner>;
  }
  if (!rows) return <SkeletonList rows={3} label={t("common.loading")} />;

  const unchecked = summary.preview.unchecked;
  return (
    <div className="stack-m">
      {group === "review" && unchecked > 0 && (
        <div className="price-review__bulk">
          <Button variant="secondary" disabled={busy} onClick={() => setSkipping(true)}>
            {t("review.skipRemaining")}
          </Button>
          <Dialog
            open={skipping}
            onClose={() => setSkipping(false)}
            title={t("review.skipRemainingTitle")}
            actions={
              <>
                <Button
                  onClick={() => {
                    setSkipping(false);
                    onSkipRemaining();
                  }}
                >
                  {t("review.skipRemainingConfirm")}
                </Button>
                <Button variant="secondary" onClick={() => setSkipping(false)}>
                  {t("common.cancel")}
                </Button>
              </>
            }
          >
            <p>{uncheckedText(unchecked, t, lang)}</p>
          </Dialog>
        </div>
      )}
      {group === "errors" && (
        <p className="ac-text-body-s ac-muted">{t("review.errorsNotApplied")}</p>
      )}
      {rows.length === 0 ? (
        <EmptyState icon="checklist" title={t("review.empty")} />
      ) : (
        <div className={wide ? "review-list review-list--table" : "review-list"} role="list">
          {rows.map((row) => (
            <RowCard
              key={row.rowNo}
              row={row}
              group={group}
              timeZone={timeZone}
              busy={busy}
              decide={decide}
              onDecided={onDecided}
            />
          ))}
        </div>
      )}
      {failed && <Banner tone="danger">{t("common.errorText")}</Banner>}
      {cursor && (
        <div className="load-more">
          <Button variant="secondary" loading={loadingMore} onClick={() => more()}>
            {t("price.showMore")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The item of a row: photo, name, brand and article. */
function ItemLine({ item, muted = false }: { item: OfferItem; muted?: boolean }) {
  const line = [item.brand?.name, item.article].filter(Boolean).join(" · ");
  return (
    <span className={muted ? "review-item review-item--muted" : "review-item"}>
      <span className="found-item__thumb review-item__thumb" aria-hidden="true">
        {item.photo ? (
          <img src={item.photo.thumbUrl} alt="" loading="lazy" />
        ) : (
          <Icon name="package" size={20} />
        )}
      </span>
      <span className="review-item__text">
        <span className="ac-text-body-strong price-wrap">{item.name.text}</span>
        <span className="ac-text-body-s ac-muted price-wrap">
          {[categoryLine(item), line].filter(Boolean).join(" · ")}
        </span>
      </span>
    </span>
  );
}

/**
 * One row of the review — a card on a phone, a row of the table from
 * 1024: the row of the file, the item, «было → стало», and what can be
 * decided about it in its group.
 */
function RowCard({
  row,
  group,
  timeZone,
  busy,
  decide,
  onDecided,
}: {
  row: PriceReviewRow;
  group: PriceReviewGroup;
  timeZone: string;
  busy: boolean;
  decide: (
    rowNo: number,
    body: Omit<DecidePriceRowBody, "expectedVersion">,
  ) => Promise<PriceReviewRow | null>;
  onDecided: (row: PriceReviewRow) => void;
}) {
  const { t, lang } = useLanguage();
  const [expanded, setExpanded] = useState(group !== "confident");
  // A table from 1024 takes the small buttons of tables (DESIGN 7.7); a phone — ones a finger hits.
  const size = useWide() ? "s" : "m";
  const [picking, setPicking] = useState(false);
  const act = async (body: Omit<DecidePriceRowBody, "expectedVersion">) => {
    const next = await decide(row.rowNo, body);
    if (next) onDecided(next);
  };
  const chosen = chosenItem(row);
  const decided = decidedText(row, timeZone, lang, t);
  const note = noteText(row, t);
  const changes = changeLines(row, t);
  const notApplicable = row.decision?.kind === "skip" || row.decision?.kind === "not_in_catalog";

  let body: ReactNode = null;
  if (group === "errors") {
    body = (
      <p className="ac-text-body-s review-row__errors">
        {row.errors.map((error) => rowErrorText(error, t)).join("; ")}
      </p>
    );
  } else if (group === "confident") {
    body = expanded && (
      <div className="actions-row">
        <Button variant="secondary" size={size} disabled={busy} onClick={() => setPicking(true)}>
          {t("review.change")}
        </Button>
        {row.decision && (
          <Button
            variant="text"
            size={size}
            disabled={busy}
            onClick={() => act({ decision: null })}
          >
            {t("review.undo")}
          </Button>
        )}
      </div>
    );
  } else if (group === "review") {
    body = row.decision ? (
      <div className="actions-row">
        <Button variant="text" size={size} disabled={busy} onClick={() => act({ decision: null })}>
          {t("review.undo")}
        </Button>
      </div>
    ) : (
      <div className="actions-row review-row__actions">
        {row.item && (
          <Button size={size} disabled={busy} onClick={() => act({ decision: "accept" })}>
            {t("review.accept")}
          </Button>
        )}
        <Button variant="secondary" size={size} disabled={busy} onClick={() => setPicking(true)}>
          {t("review.other")}
        </Button>
        <Button
          variant="text"
          size={size}
          disabled={busy}
          onClick={() => act({ decision: "skip" })}
        >
          {t("review.skip")}
        </Button>
      </div>
    );
  } else if (group === "not_found") {
    body = (
      <div className="stack-s">
        {row.decision?.kind === "other" ? (
          <div className="actions-row">
            <Button
              variant="text"
              size={size}
              disabled={busy}
              onClick={() => act({ decision: null })}
            >
              {t("review.undo")}
            </Button>
          </div>
        ) : (
          <>
            <Switch
              label={t("review.sendRequest")}
              checked={row.sendRequest}
              disabled={busy}
              onChange={(checked) => act({ sendRequest: checked })}
              description={
                row.requestRejectReason
                  ? t("review.requestRejected", { reason: row.requestRejectReason })
                  : undefined
              }
            />
            <div className="actions-row">
              <Button
                variant="secondary"
                size={size}
                disabled={busy}
                onClick={() => setPicking(true)}
              >
                {t("review.findManually")}
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <article
      className={row.sharpPrice && !notApplicable ? "review-row review-row--sharp" : "review-row"}
      role="listitem"
    >
      <div className="review-row__file">
        <span className="ac-text-caption ac-muted">{t("price.parsed.row", { n: row.rowNo })}</span>
        <span className="price-wrap">{fileText(row) || "—"}</span>
        {row.byName && group !== "errors" && (
          <span className="ac-text-caption ac-muted">{t("review.byName")}</span>
        )}
      </div>

      <div className="review-row__item">
        {group === "errors" ? null : chosen ? (
          <ItemLine item={chosen} muted={notApplicable} />
        ) : row.decision ? null : group === "review" && row.candidates.length > 0 ? (
          <>
            <span className="ac-text-body-s ac-muted">{t("review.chooseCandidate")}</span>
            <ul className="review-candidates" aria-label={t("review.candidates")}>
              {row.candidates.map((candidate, index) => (
                <li key={candidate.id} className="review-candidates__item">
                  <ItemLine item={candidate} />
                  <span className="review-candidates__act">
                    {/* AI's choice comes first among the candidates (TASK-047 I714). */}
                    {row.aiProposed && index === 0 && <AiBadge>{t("review.aiProposed")}</AiBadge>}
                    <Button
                      variant="secondary"
                      size={size}
                      disabled={busy}
                      onClick={() => act({ decision: "accept", itemId: candidate.id })}
                    >
                      {t("review.thisOne")}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {row.aiProposed && (
          <div className="review-row__ai">
            {row.item || row.decision ? (
              <AiBadge>{t("review.aiProposed")}</AiBadge>
            ) : (
              <span className="ac-text-body-s ac-muted">{t("review.aiNotSure")}</span>
            )}
            {row.aiExplanation && (
              <span className="ac-text-body-s ac-muted price-wrap">{row.aiExplanation}</span>
            )}
          </div>
        )}
        {note && <span className="ac-text-body-s review-row__note">{note}</span>}
        {decided && (
          <span className="ac-text-body-s review-row__decided">
            <Icon name="check" size={16} />
            {decided}
          </span>
        )}
      </div>

      <div className="review-row__price">
        {group !== "errors" &&
          !notApplicable &&
          changes.map((line, index) => (
            <span
              key={line}
              className={
                index === 0 && row.sharpPrice ? "ac-text-body-strong review-row__sharp" : "num"
              }
            >
              {line}
            </span>
          ))}
        {row.sharpPrice && !notApplicable && group !== "errors" && group !== "not_found" && (
          <>
            <Badge tone="warning" icon="alertTriangle">
              {t("review.sharp")}
            </Badge>
            <Checkbox
              label={t("review.confirmPrice")}
              checked={row.priceConfirmed}
              disabled={busy}
              onChange={(checked) => act({ priceConfirmed: checked })}
            />
          </>
        )}
      </div>

      <div className="review-row__actions-cell">
        {body}
        {group === "confident" && (
          <button
            type="button"
            className="text-link review-row__toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {t(expanded ? "review.collapse" : "review.expand")}
          </button>
        )}
      </div>

      <ItemPicker
        open={picking}
        initial={row.parsed?.article ?? row.parsed?.name ?? ""}
        onClose={() => setPicking(false)}
        onPick={(item) => {
          setPicking(false);
          void act({ decision: "other", itemId: item.id });
        }}
      />
    </article>
  );
}

// -------------------------------------------------------------- missing

function MissingOffers({
  summary,
  busy,
  onChoose,
}: {
  summary: PriceReviewSummary;
  busy: boolean;
  onChoose: (action: "withdraw" | "keep") => void;
}) {
  const { t, lang } = useLanguage();
  const [page, setPage] = useState<PriceMissingPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const importId = summary.import.id;

  useEffect(() => {
    let live = true;
    apiClient.listPriceMissingOffers({ importId }, { query: { limit: PAGE } }).then(
      (answer) => {
        if (live) setPage(answer);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [importId]);

  const more = async () => {
    if (!page?.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await apiClient.listPriceMissingOffers(
        { importId },
        { query: { limit: PAGE, cursor: page.nextCursor } },
      );
      setPage({ ...next, offers: [...page.offers, ...next.offers] });
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  if (summary.missing.offers === 0) {
    return <EmptyState icon="checklist" title={t("review.missingNone")} />;
  }

  return (
    <div className="stack-m">
      {summary.missing.withActiveOrders > 0 && (
        <Banner tone="warning" icon="alertTriangle">
          {missingOrdersText(summary.missing.withActiveOrders, t, lang)}
        </Banner>
      )}
      <fieldset className="card price-missing__choice">
        <legend className="ac-text-body-strong">{t("review.missingChoose")}</legend>
        <Radio
          name="missing"
          label={t("review.missingWithdraw")}
          checked={summary.missing.action === "withdraw"}
          disabled={busy}
          onChange={() => onChoose("withdraw")}
        />
        <Radio
          name="missing"
          label={t("review.missingKeep")}
          checked={summary.missing.action === "keep"}
          disabled={busy}
          onChange={() => onChoose("keep")}
        />
        {summary.missing.decidedBy && (
          <p className="ac-text-body-s ac-muted">
            {t("review.missingDecidedBy", {
              name: summary.missing.decidedBy.name ?? t("review.colleague"),
            })}
          </p>
        )}
      </fieldset>
      {failed && <Banner tone="danger">{t("common.errorText")}</Banner>}
      {!page && !failed && <SkeletonList rows={3} label={t("common.loading")} />}
      {page && (
        <ul className="price-errors" aria-label={t("review.tab.missing")}>
          {page.offers.map((entry) => (
            <li key={entry.offerId} className="review-missing">
              <ItemLine item={entry.item} />
              <span className="review-missing__facts">
                <span className="num">{formatNumber(entry.price)} ₸</span>
                {entry.activeOrders > 0 && (
                  <Badge tone="warning" icon="receipt">
                    {t("review.activeOrders", { n: formatNumber(entry.activeOrders) })}
                  </Badge>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {page?.nextCursor && (
        <div className="load-more">
          <Button variant="secondary" loading={loadingMore} onClick={() => more()}>
            {t("price.showMore")}
          </Button>
        </div>
      )}
    </div>
  );
}

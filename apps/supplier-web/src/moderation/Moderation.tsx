import type {
  SupplierCatalogRequest,
  SupplierModerationProposal,
  SupplierModerationSummary,
} from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Icon,
  LoadingContent,
  ScreenError,
  Segments,
  SkeletonList,
  useLoadingGate,
} from "@adclub/ui";
import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../api";
import { useLanguage } from "../i18n";
import { formatWhen } from "../orders/order-rules";
import { navigate, navigateTo, offerPath, replaceRouteState, useRouteState } from "../router";
import {
  addedAction,
  conditionsText,
  MODERATION_TAB_TEXT,
  requestSource,
  requestTitle,
  statusText,
  statusTone,
  type ModerationTab,
} from "./moderation-rules";
import { publishModerationUnseen } from "./unseen";

const PAGE = 30;

/**
 * S-MOD-01 «Модерация» (TASK-048): what the administrator decided on the
 * company's requests to add an item (from price lists and by hand) and on
 * its compatibility proposals — «На рассмотрении» / «Добавлено» /
 * «Отклонено: {причина}», «новое» on what this employee hasn't seen. Once
 * the lists are on screen, the server is told they were seen up to the
 * moment of its answer; the marks stay on this page until it is left.
 */
export function Moderation({ generation, timeZone }: { generation: number; timeZone: string }) {
  const { t } = useLanguage();
  const opened = useRouteState() as { moderationTab?: ModerationTab } | null;
  const [tab, setTab] = useState<ModerationTab>(opened?.moderationTab ?? "requests");
  const [summary, setSummary] = useState<SupplierModerationSummary | null>(null);

  useEffect(() => {
    let live = true;
    apiClient.getSupplierModerationSummary().then(
      async (first) => {
        if (!live) return;
        setSummary(first);
        // The lists of this visit show «новое» by the moment before it; from now on it is seen.
        try {
          const after = await apiClient.markSupplierModerationSeen({
            seenUntil: first.serverTime,
          });
          publishModerationUnseen(generation, after.unseen.total);
        } catch {
          // Not marked: the counter stays, the next visit marks it.
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [generation]);

  const label = (key: ModerationTab) => {
    const unseen = key === "requests" ? summary?.unseen.requests : summary?.unseen.compatibility;
    return unseen
      ? `${t(MODERATION_TAB_TEXT[key])} · ${t("moderation.newCount", { n: unseen })}`
      : t(MODERATION_TAB_TEXT[key]);
  };

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title page__title">{t("moderation.title")}</h1>
        <Button variant="secondary" icon="plus" onClick={() => navigate("offerRequest")}>
          {t("moderation.addRequest")}
        </Button>
      </div>
      <div className="offers-controls">
        <Segments<ModerationTab>
          label={t("moderation.title")}
          value={tab}
          onChange={(next) => {
            setTab(next);
            replaceRouteState({ moderationTab: next });
          }}
          options={[
            { value: "requests", label: label("requests") },
            { value: "compatibility", label: label("compatibility") },
          ]}
        />
      </div>
      {tab === "requests" ? <Requests timeZone={timeZone} /> : <Proposals timeZone={timeZone} />}
    </>
  );
}

/** A page-by-page list of the server, kept while the page is open. */
function usePages<T>(
  load: (cursor: string | null) => Promise<{ entries: T[]; next: string | null }>,
) {
  const gate = useLoadingGate();
  const [entries, setEntries] = useState<T[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const { begin, settle } = gate;

  const first = useCallback(async () => {
    const ticket = begin();
    try {
      const page = await load(null);
      settle(ticket, () => {
        setEntries(page.entries);
        setNext(page.next);
        setFailure(null);
      });
    } catch (error) {
      settle(ticket, () => setFailure(error));
    }
  }, [load, begin, settle]);

  useEffect(() => {
    void first();
  }, [first]);

  const more = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const page = await load(next);
      setEntries((current) => [...(current ?? []), ...page.entries]);
      setNext(page.next);
    } catch (error) {
      setFailure(error);
    } finally {
      setLoadingMore(false);
    }
  };

  return { entries, next, failure, loadingMore, more, retry: first, gate };
}

function Requests({ timeZone }: { timeZone: string }) {
  const { t } = useLanguage();
  const load = useCallback(async (cursor: string | null) => {
    const page = await apiClient.listSupplierCatalogRequests({
      query: { limit: PAGE, ...(cursor ? { cursor } : {}) },
    });
    return { entries: page.requests, next: page.nextCursor };
  }, []);
  const list = usePages<SupplierCatalogRequest>(load);
  return (
    <List
      list={list}
      empty={
        <EmptyState
          icon="checklist"
          title={t("moderation.emptyRequests")}
          text={t("moderation.emptyRequestsText")}
          action={
            <Button variant="secondary" onClick={() => navigate("offerRequest")}>
              {t("moderation.addRequest")}
            </Button>
          }
        />
      }
      render={(request) => <RequestCard key={request.id} request={request} timeZone={timeZone} />}
    />
  );
}

function Proposals({ timeZone }: { timeZone: string }) {
  const { t } = useLanguage();
  const load = useCallback(async (cursor: string | null) => {
    const page = await apiClient.listSupplierModerationProposals({
      query: { limit: PAGE, ...(cursor ? { cursor } : {}) },
    });
    return { entries: page.entries, next: page.nextCursor };
  }, []);
  const list = usePages<SupplierModerationProposal>(load);
  return (
    <List
      list={list}
      empty={<EmptyState icon="car" title={t("moderation.emptyCompatibility")} />}
      render={(entry) => <ProposalCard key={entry.proposal.id} entry={entry} timeZone={timeZone} />}
    />
  );
}

function List<T>({
  list,
  empty,
  render,
}: {
  list: ReturnType<typeof usePages<T>>;
  empty: React.ReactNode;
  render: (entry: T) => React.ReactNode;
}) {
  const { t } = useLanguage();
  if (list.failure !== null && !list.entries) {
    return (
      <ScreenError
        title={t("common.errorTitle")}
        text={t("common.errorText")}
        retry={{ label: t("common.retry"), onRetry: () => list.retry() }}
      />
    );
  }
  return (
    <LoadingContent
      ready={list.entries !== null}
      indicator={list.gate.indicator}
      skeleton={<SkeletonList rows={3} label={t("common.loading")} />}
      label={t("common.loading")}
    >
      {list.entries && list.entries.length === 0 && empty}
      {list.entries && list.entries.length > 0 && (
        <div className="offer-list">{list.entries.map(render)}</div>
      )}
      {list.failure !== null && list.entries && (
        <Banner tone="danger">{t("common.errorText")}</Banner>
      )}
      {list.next && (
        <div className="load-more">
          <Button variant="secondary" loading={list.loadingMore} onClick={() => list.more()}>
            {t("price.showMore")}
          </Button>
        </div>
      )}
    </LoadingContent>
  );
}

function NewMark() {
  const { t } = useLanguage();
  return (
    <Badge tone="accent" icon="sparkles">
      {t("moderation.new")}
    </Badge>
  );
}

function RequestCard({ request, timeZone }: { request: SupplierCatalogRequest; timeZone: string }) {
  const { t, lang } = useLanguage();
  const title = requestTitle(request);
  const action = addedAction(request);
  return (
    <article className="offer-card moderation-card">
      <div className="offer-card__head">
        <span className="ac-text-body-strong price-wrap moderation-card__title">{title.name}</span>
        {request.isNew && <NewMark />}
      </div>
      {title.line && <span className="ac-text-body-s num">{title.line}</span>}
      <span className="ac-text-body-s ac-muted">
        {[
          requestSource(request, t),
          request.category ? t("moderation.category", { name: request.category.name }) : null,
          formatWhen(request.createdAt, timeZone, lang, t),
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {request.comment && (
        <span className="ac-text-body-s price-wrap">
          {t("moderation.comment", { text: request.comment })}
        </span>
      )}
      <div className="moderation-card__status">
        <Badge
          tone={statusTone(request.status)}
          icon={
            request.status === "approved"
              ? "circleCheck"
              : request.status === "rejected"
                ? "circleX"
                : "clock"
          }
        >
          {statusText(request.status, request.rejectReason, t)}
        </Badge>
        {request.decidedAt && (
          <span className="ac-text-caption ac-muted">
            {formatWhen(request.decidedAt, timeZone, lang, t)}
          </span>
        )}
      </div>
      {request.item && (
        <div className="moderation-card__item">
          <Icon name="package" size={20} />
          <span className="price-wrap">{request.item.name.text}</span>
        </div>
      )}
      {action && (
        <div className="actions-row">
          {action === "open" ? (
            <Button
              variant="secondary"
              size="s"
              onClick={() => request.offer && navigateTo(offerPath(request.offer.id))}
            >
              {t("moderation.open")}
            </Button>
          ) : (
            <Button
              size="s"
              icon="plus"
              onClick={() => navigate("offerNew", { state: { item: request.item } })}
            >
              {t("moderation.put")}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

function ProposalCard({
  entry,
  timeZone,
}: {
  entry: SupplierModerationProposal;
  timeZone: string;
}) {
  const { t, lang } = useLanguage();
  const { proposal, item } = entry;
  return (
    <article className="offer-card moderation-card">
      <div className="offer-card__head">
        <span className="ac-text-body-strong price-wrap moderation-card__title">
          {item?.name.text ?? t("moderation.itemGone")}
        </span>
        {entry.isNew && <NewMark />}
      </div>
      {item && (item.brand || item.article) && (
        <span className="ac-text-body-s num">
          {[item.brand?.name, item.article].filter(Boolean).join(" · ")}
        </span>
      )}
      <span className="ac-text-body-s price-wrap">
        <Icon name="car" size={16} /> {conditionsText(proposal.label)}
      </span>
      <span className="ac-text-body-s ac-muted price-wrap">
        {t("moderation.evidence", { text: proposal.evidence })} ·{" "}
        {formatWhen(proposal.createdAt, timeZone, lang, t)}
      </span>
      <div className="moderation-card__status">
        <Badge
          tone={statusTone(proposal.status)}
          icon={
            proposal.status === "approved"
              ? "circleCheck"
              : proposal.status === "rejected"
                ? "circleX"
                : "clock"
          }
        >
          {statusText(proposal.status, proposal.rejectionReason, t)}
        </Badge>
        {proposal.approvedWithChanges && (
          <span className="ac-text-caption ac-muted">{t("moderation.withChanges")}</span>
        )}
      </div>
    </article>
  );
}

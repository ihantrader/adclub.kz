import type {
  SupplierCatalogRequest,
  SupplierModerationProposal,
  SupplierModerationSummary,
} from "@adclub/contracts";
import {
  ActionBar,
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
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { useLanguage } from "../i18n";
import { formatWhen } from "../orders/order-rules";
import { useWide } from "../offers/use-wide";
import {
  goBackTo,
  navigate,
  navigateTo,
  offerPath,
  replaceRouteState,
  useRouteState,
} from "../router";
import { PageHeader } from "../screens/PageHeader";
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
      <PageHeader
        title={t("moderation.title")}
        back={() => goBackTo("more")}
        deskRoot
        actions={
          <Button
            variant="secondary"
            icon="plus"
            className="page__head-action"
            onClick={() => navigate("offerRequest")}
          >
            {t("moderation.addRequest")}
          </Button>
        }
      />
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
  const toRow = useRequestRow(timeZone);
  return (
    <List
      list={list}
      toRow={toRow}
      aboutHeader={t("moderation.tableAbout")}
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
  const toRow = useProposalRow(timeZone);
  return (
    <List
      list={list}
      toRow={toRow}
      aboutHeader={t("moderation.tableCar")}
      empty={<EmptyState icon="car" title={t("moderation.emptyCompatibility")} />}
    />
  );
}

function List<T>({
  list,
  empty,
  toRow,
  aboutHeader,
}: {
  list: ReturnType<typeof usePages<T>>;
  empty: React.ReactNode;
  toRow: (entry: T) => ModerationRow;
  aboutHeader: string;
}) {
  const { t } = useLanguage();
  const wide = useWide();
  const rows = list.entries?.map(toRow) ?? [];
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
      {rows.length > 0 &&
        (wide ? (
          <RowsTable rows={rows} aboutHeader={aboutHeader} />
        ) : (
          <div className="card-grid">
            {rows.map((row) => (
              <RowCard key={row.id} row={row} />
            ))}
          </div>
        ))}
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

/**
 * One template for every decision (TASK-079): the status and «новое» on
 * top, the item and «бренд · артикул», what it was about and when, then
 * the one action. From 1024 the same parts are the cells of a table row.
 */
interface ModerationRow {
  id: string;
  isNew: boolean;
  status: Parameters<typeof statusTone>[0];
  statusText: string;
  /** When it was decided, or nothing yet. */
  decided: string | null;
  name: string;
  line: string | null;
  /** «Из прайса · Категория …» / the car of a compatibility proposal. */
  about: ReactNode;
  /** The comment, the source of a proposal — said in full on a card. */
  details: string | null;
  sent: string;
  action: ReactNode;
}

function StatusMark({ row }: { row: ModerationRow }) {
  return (
    <Badge
      tone={statusTone(row.status)}
      icon={
        row.status === "approved" ? "circleCheck" : row.status === "rejected" ? "circleX" : "clock"
      }
    >
      {row.statusText}
    </Badge>
  );
}

function RowCard({ row }: { row: ModerationRow }) {
  return (
    <article className="offer-card moderation-card">
      <div className="moderation-card__status">
        <StatusMark row={row} />
        {row.isNew && <NewMark />}
        {row.decided && <span className="ac-text-caption ac-muted">{row.decided}</span>}
      </div>
      <div className="moderation-card__title">
        <span className="ac-text-body-strong price-wrap">{row.name}</span>
        {row.line && <span className="ac-text-caption ac-muted num">{row.line}</span>}
      </div>
      <span className="ac-text-body-s price-wrap">{row.about}</span>
      {row.details && <span className="ac-text-body-s ac-muted price-wrap">{row.details}</span>}
      <span className="ac-text-caption ac-muted">{row.sent}</span>
      {row.action && <ActionBar compact others={[row.action]} />}
    </article>
  );
}

function RowsTable({ rows, aboutHeader }: { rows: ModerationRow[]; aboutHeader: string }) {
  const { t } = useLanguage();
  return (
    <div className="table-wrap">
      <table className="data-table moderation-table">
        <caption className="ac-visually-hidden">{t("moderation.title")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("moderation.tableItem")}</th>
            <th scope="col">{aboutHeader}</th>
            <th scope="col">{t("moderation.tableSent")}</th>
            <th scope="col">{t("moderation.tableStatus")}</th>
            <th scope="col">
              <span className="ac-visually-hidden">{t("offers.tableActions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="moderation-table__item">
                <span className="price-wrap">{row.name}</span>
                {row.line && <div className="ac-text-caption ac-muted num">{row.line}</div>}
              </td>
              <td>
                <span className="price-wrap">{row.about}</span>
                {row.details && (
                  <div className="ac-text-caption ac-muted price-wrap">{row.details}</div>
                )}
              </td>
              <td className="moderation-table__date">{row.sent}</td>
              <td>
                <span className="moderation-card__status">
                  <StatusMark row={row} />
                  {row.isNew && <NewMark />}
                </span>
                {row.decided && <div className="ac-text-caption ac-muted">{row.decided}</div>}
              </td>
              <td className="data-table__action">{row.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useRequestRow(timeZone: string): (request: SupplierCatalogRequest) => ModerationRow {
  const { t, lang } = useLanguage();
  return (request) => {
    const title = requestTitle(request);
    const action = addedAction(request);
    // The item the request became, unless it is the same name said again (TASK-079).
    const became =
      request.item && request.item.name.text !== title.name ? request.item.name.text : null;
    return {
      id: request.id,
      isNew: request.isNew,
      status: request.status,
      statusText: statusText(request.status, request.rejectReason, t),
      decided: request.decidedAt ? formatWhen(request.decidedAt, timeZone, lang, t) : null,
      name: title.name,
      line: title.line || null,
      about: [
        requestSource(request, t),
        request.category ? t("moderation.category", { name: request.category.name }) : null,
        became,
      ]
        .filter(Boolean)
        .join(" · "),
      details: request.comment ? t("moderation.comment", { text: request.comment }) : null,
      sent: formatWhen(request.createdAt, timeZone, lang, t),
      // A row's action is secondary: the screen has no main button in its rows (C15).
      action: action ? (
        <Button
          key="action"
          variant="secondary"
          size="s"
          icon={action === "open" ? undefined : "plus"}
          onClick={() =>
            action === "open"
              ? request.offer && navigateTo(offerPath(request.offer.id))
              : navigate("offerNew", { state: { item: request.item } })
          }
        >
          {t(action === "open" ? "moderation.open" : "moderation.put")}
        </Button>
      ) : null,
    };
  };
}

function useProposalRow(timeZone: string): (entry: SupplierModerationProposal) => ModerationRow {
  const { t, lang } = useLanguage();
  return ({ proposal, item, isNew }) => ({
    id: proposal.id,
    isNew,
    status: proposal.status,
    statusText: statusText(proposal.status, proposal.rejectionReason, t),
    decided: proposal.approvedWithChanges ? t("moderation.withChanges") : null,
    name: item?.name.text ?? t("moderation.itemGone"),
    line: item ? [item.brand?.name, item.article].filter(Boolean).join(" · ") || null : null,
    about: (
      <>
        <Icon name="car" size={16} /> {conditionsText(proposal.label)}
      </>
    ),
    details: t("moderation.evidence", { text: proposal.evidence }),
    sent: formatWhen(proposal.createdAt, timeZone, lang, t),
    action: null,
  });
}

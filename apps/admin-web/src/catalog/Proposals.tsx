import type { AdminCompatibilityProposal, CompatibilityProposalStatus } from "@adclub/contracts";
import {
  Banner,
  Button,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  TableToolbar,
} from "@adclub/ui";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { StatusChips } from "../layout/filters";
import { Header, RowTitle, rowLink, Table } from "../layout/layout";
import { catalogItemPath, navigateTo, routePaths, useLocation, withQuery } from "../router";
import { usePagedList, type PageOf } from "./paged";
import { catalogTabs } from "./shared";
import { labelText } from "./VehicleFields";

const STATUSES: { value: CompatibilityProposalStatus; label: string }[] = [
  { value: "pending", label: "На рассмотрении" },
  { value: "approved", label: "Подтверждённые" },
  { value: "rejected", label: "Отклонённые" },
];

const EMPTY: Record<CompatibilityProposalStatus, { title: string; text: string }> = {
  pending: {
    title: "Новых предложений нет",
    text: "Поставщики предлагают, каким автомобилям подходит позиция, из своего кабинета. Новое предложение появится здесь и во вкладке «Совместимость» позиции.",
  },
  approved: {
    title: "Подтверждённых предложений нет",
    text: "Здесь будут предложения поставщиков, которые стали записями совместимости.",
  },
  rejected: {
    title: "Отклонённых предложений нет",
    text: "Здесь будут предложения, отклонённые с причиной — её видит поставщик.",
  },
};

const COLUMNS = [
  { key: "item", header: "Позиция", width: 220 },
  { key: "cars", header: "Автомобили" },
  { key: "supplier", header: "Поставщик", width: 140 },
  { key: "when", header: "Когда", width: 120 },
];

/**
 * The queue of suppliers' compatibility proposals (TASK-035, TASK-080;
 * SCREENS A-CAT-05 «Совместимость»): every proposal across the catalog by
 * its state (chips), each row leading to its item's tab where it is
 * approved, approved with a correction or rejected; pages by the cursor.
 */
export function Proposals() {
  const { query } = useLocation();
  const asked = query.get("status");
  const status: CompatibilityProposalStatus =
    asked === "approved" || asked === "rejected" ? asked : "pending";
  const list = usePagedList<AdminCompatibilityProposal, PageOf<AdminCompatibilityProposal>>(
    async (cursor) => {
      const page = await apiClient.listCompatibilityProposals({
        query: { status, limit: 50, ...(cursor ? { cursor } : {}) },
      });
      return { items: page.proposals, total: page.total, nextCursor: page.nextCursor };
    },
    `proposals:${status}`,
  );
  const empty = EMPTY[status];
  return (
    <>
      <Header
        title="Справочник"
        tabs={catalogTabs("proposals")}
        actions={
          <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
        }
      />
      <StatusChips<CompatibilityProposalStatus>
        label="Состояние предложений"
        allLabel={null}
        value={status}
        chips={STATUSES.map((entry) => ({
          ...entry,
          count: entry.value === status && list.first.data ? list.total : undefined,
        }))}
        onChange={(next) =>
          navigateTo(
            withQuery(routePaths.catalogProposals, {
              status: !next || next === "pending" ? null : next,
            }),
            { replace: true },
          )
        }
      />
      {list.first.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={list.first.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(list.first.error)}
        </Banner>
      )}
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <div className="list-block">
          {list.items.length === 0 ? (
            <EmptyState icon="car" title={empty.title} text={empty.text} />
          ) : (
            <>
              <TableToolbar total={list.total} />
              <Table label="Предложения совместимости" columns={COLUMNS}>
                {list.items.map((proposal) => {
                  const href = catalogItemPath(proposal.item.id, "compatibility");
                  const name = proposal.item.name ?? "Без названия";
                  return (
                    <tr key={proposal.id} {...rowLink(href)}>
                      <td>
                        <RowTitle
                          href={href}
                          sub={
                            [proposal.item.brand, proposal.item.article]
                              .filter(Boolean)
                              .join(" · ") || undefined
                          }
                        >
                          <span className="clamp" title={name}>
                            {name}
                          </span>
                        </RowTitle>
                      </td>
                      <td>
                        <div className="cell-stack">
                          <span className="long-text">{labelText(proposal.label)}</span>
                          {proposal.matchesRecordId && (
                            <span className="ac-text-caption ac-muted">
                              Такая запись уже подтверждена
                            </span>
                          )}
                          {proposal.rejectionReason && (
                            <span className="ac-text-caption ac-muted">
                              Причина: {proposal.rejectionReason}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="ac-text-body-s">{proposal.supplier?.name ?? "—"}</td>
                      <td className="nowrap ac-text-body-s">{formatMoment(proposal.createdAt)}</td>
                    </tr>
                  );
                })}
              </Table>
            </>
          )}
          {list.moreError && <Banner tone="danger">{list.moreError}</Banner>}
          {list.hasMore && (
            <Button
              variant="secondary"
              size="s"
              onClick={() => void list.loadMore()}
              loading={list.loadingMore}
            >
              Показать ещё
            </Button>
          )}
        </div>
      </LoadingContent>
    </>
  );
}

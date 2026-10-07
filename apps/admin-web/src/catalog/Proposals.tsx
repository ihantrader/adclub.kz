import type {
  AdminCompatibilityProposalPage,
  CompatibilityProposalStatus,
} from "@adclub/contracts";
import { Banner, Button, EmptyState, LoadingContent, Segments, SkeletonList } from "@adclub/ui";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { catalogItemPath, navigateTo, routePaths, useLocation, withQuery } from "../router";
import { useLoad } from "../use-load";
import { AppLink, CatalogTabs } from "./shared";
import { labelText } from "./VehicleFields";

const STATUSES: { value: CompatibilityProposalStatus; label: string }[] = [
  { value: "pending", label: "На рассмотрении" },
  { value: "approved", label: "Подтверждённые" },
  { value: "rejected", label: "Отклонённые" },
];

/**
 * The queue of suppliers' compatibility proposals (TASK-035; SCREENS
 * A-CAT-05 «Совместимость»): every proposal waiting for review across the
 * catalog, each leading to its item's tab where it is approved, approved
 * with a correction or rejected.
 */
export function Proposals() {
  const { query } = useLocation();
  const asked = query.get("status");
  const status: CompatibilityProposalStatus =
    asked === "approved" || asked === "rejected" ? asked : "pending";
  const page = useLoad<AdminCompatibilityProposalPage>(
    () => apiClient.listCompatibilityProposals({ query: { status, limit: 100 } }),
    `proposals:${status}`,
  );
  const proposals = page.data?.proposals ?? [];
  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Справочник</h1>
        <Button variant="secondary" size="s" icon="refresh" onClick={page.reload}>
          Обновить
        </Button>
      </div>
      <CatalogTabs active="proposals" />
      <Segments<CompatibilityProposalStatus>
        label="Состояние"
        options={STATUSES}
        value={status}
        onChange={(next) =>
          navigateTo(
            withQuery(routePaths.catalogProposals, { status: next === "pending" ? null : next }),
            {
              replace: true,
            },
          )
        }
      />
      {page.error !== undefined && <Banner tone="danger">{loadErrorText(page.error)}</Banner>}
      <LoadingContent
        ready={page.data !== undefined}
        indicator={page.indicator}
        label="Загрузка"
        swapKey={page.answerKey}
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted">Всего: {page.data?.total ?? 0}</p>
        {proposals.length === 0 ? (
          <EmptyState icon="car" title="Предложений нет" />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Позиция</th>
                  <th scope="col">Автомобили</th>
                  <th scope="col">Поставщик</th>
                  <th scope="col">Когда</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((proposal) => (
                  <tr key={proposal.id}>
                    <td>
                      <div className="cell-stack">
                        <AppLink href={catalogItemPath(proposal.item.id, "compatibility")}>
                          <span className="clamp">{proposal.item.name ?? "Без названия"}</span>
                        </AppLink>
                        <span className="ac-text-caption ac-muted">
                          {[proposal.item.brand, proposal.item.article].filter(Boolean).join(" · ")}
                        </span>
                      </div>
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
                    <td className="ac-text-caption ac-muted">{formatMoment(proposal.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </LoadingContent>
    </>
  );
}

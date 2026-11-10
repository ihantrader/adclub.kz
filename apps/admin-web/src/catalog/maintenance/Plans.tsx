import type {
  AdminMaintenancePlan,
  AdminMaintenancePlanPage,
  MaintenancePlanSource,
  MaintenancePlanStatus,
} from "@adclub/contracts";
import {
  AiBadge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  Spinner,
  TableToolbar,
  TextField,
  TypeMark,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../../api";
import { loadErrorText } from "../../errors";
import { formatMoment } from "../../format";
import { FilterSearch, FilterSelect, StatusChips } from "../../layout/filters";
import { Header, RowTitle, rowLink, Table } from "../../layout/layout";
import { maintenancePlanPath, navigateTo, routePaths, useLocation, withQuery } from "../../router";
import { usePagedList, type PageOf } from "../paged";
import { catalogTabs } from "../shared";
import {
  PLAN_SOURCE_TEXT,
  PLAN_STATUS_TEXT,
  maintenanceErrorText,
  scopeLabelText,
} from "./maintenance-words";
import { EMPTY_SCOPE, ScopeFields, scopeInputOf, type ScopeChoice } from "./ScopeFields";

const STATUSES: { value: MaintenancePlanStatus; label: string }[] = [
  { value: "draft", label: "Черновики" },
  { value: "active", label: "Действуют" },
  { value: "archived", label: "В архиве" },
];

const SOURCES: { value: MaintenancePlanSource; label: string }[] = [
  { value: "ai_draft", label: "Черновик ИИ" },
  { value: "manual", label: "Вручную" },
  { value: "official", label: "Официальный" },
];

const COLUMNS = [
  { key: "plan", header: "Область" },
  { key: "source", header: "Источник", width: 150 },
  { key: "status", header: "Статус", width: 130 },
  { key: "items", header: "Элементов", width: 110, numeric: true },
  { key: "confirmed", header: "Подтвердил", width: 180 },
];

/** Where a plan came from: an AI draft carries the AI mark (DESIGN 7.9). */
export function SourceMark({ source }: { source: MaintenancePlanSource }) {
  if (source === "ai_draft") return <AiBadge>Черновик ИИ</AiBadge>;
  return (
    <TypeMark icon={source === "official" ? "circleCheck" : "user"}>
      {PLAN_SOURCE_TEXT[source]}
    </TypeMark>
  );
}

const STATUS_OF = (value: string | null): MaintenancePlanStatus | undefined =>
  value === "draft" || value === "active" || value === "archived" ? value : undefined;
const SOURCE_OF = (value: string | null): MaintenancePlanSource | undefined =>
  value === "ai_draft" || value === "manual" || value === "official" ? value : undefined;

/**
 * «Регламенты ТО» (TASK-061): the plans of the vehicle catalog's areas — the
 * area in words, where the plan came from (an AI draft marked), its status,
 * how many elements it has and who confirmed it; filters in the address,
 * pages by the server's cursor. «Новый план» writes one by hand or asks AI
 * for a draft.
 */
export function MaintenancePlans() {
  const { query } = useLocation();
  const status = STATUS_OF(query.get("status"));
  const source = SOURCE_OF(query.get("source"));
  const q = query.get("q") ?? "";
  const [typed, setTyped] = useState(q);
  const [creating, setCreating] = useState(false);
  const go = (patch: Record<string, string | null | undefined>) =>
    navigateTo(
      withQuery(routePaths.catalogMaintenance, { status, source, q: q || undefined, ...patch }),
      { replace: true },
    );
  const list = usePagedList<AdminMaintenancePlan, PageOf<AdminMaintenancePlan>>(
    async (cursor) => {
      const page: AdminMaintenancePlanPage = await apiClient.listMaintenancePlans({
        query: {
          ...(status ? { status } : {}),
          ...(source ? { source } : {}),
          ...(q ? { q } : {}),
          limit: 50,
          ...(cursor ? { cursor } : {}),
        },
      });
      return { items: page.plans, total: page.total, nextCursor: page.nextCursor };
    },
    `maintenance:${status ?? ""}:${source ?? ""}:${q}`,
  );
  return (
    <>
      <Header
        title="Справочник"
        tabs={catalogTabs("maintenance")}
        actions={
          <>
            <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
            <Button icon="plus" onClick={() => setCreating(true)}>
              Новый план
            </Button>
          </>
        }
      />
      <div className="filters">
        <FilterSearch
          label="Поиск планов"
          placeholder="Название, марка, модель или код двигателя"
          value={typed}
          onChange={setTyped}
          onSubmit={() => go({ q: typed.trim() || undefined })}
        />
        <FilterSelect<MaintenancePlanSource>
          label="Источник"
          value={source}
          options={SOURCES}
          onChange={(next) => go({ source: next })}
        />
      </div>
      <StatusChips<MaintenancePlanStatus>
        label="Статус планов"
        value={status}
        chips={STATUSES}
        onChange={(next) => go({ status: next })}
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
            <EmptyState
              icon="wrench"
              title="Планов нет"
              text="Регламент ТО — перечень работ по интервалам для марки, модели, поколения или двигателя. Заведите план вручную или попросите ИИ составить черновик."
            />
          ) : (
            <>
              <TableToolbar total={list.total} />
              <Table label="Регламенты ТО" columns={COLUMNS}>
                {list.items.map((plan) => {
                  const href = maintenancePlanPath(plan.id);
                  return (
                    <tr key={plan.id} {...rowLink(href)}>
                      <td>
                        <RowTitle href={href} sub={scopeLabelText(plan.label)}>
                          <span className="clamp" title={plan.name}>
                            {plan.name}
                          </span>
                        </RowTitle>
                      </td>
                      <td>
                        <SourceMark source={plan.source} />
                      </td>
                      <td className="ac-text-body-s">
                        {plan.generating ? "ИИ составляет…" : PLAN_STATUS_TEXT[plan.status]}
                        {plan.proposedCount > 0 && (
                          <div className="ac-text-caption ac-muted">
                            ждут подтверждения: {plan.proposedCount}
                          </div>
                        )}
                      </td>
                      <td className="num">{plan.itemCount}</td>
                      <td className="ac-text-body-s">
                        {plan.confirmedBy ? (
                          <div className="cell-stack">
                            <span>{plan.confirmedBy.name ?? "Администратор"}</span>
                            <span className="ac-text-caption ac-muted nowrap">
                              {formatMoment(plan.confirmedAt)}
                            </span>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
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
      <NewPlanDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

/**
 * «Новый план»: the area (a make required), a name if wished, then
 * «Создать вручную» — an empty draft — or «Сгенерировать черновик ИИ»: the
 * server asks AI and answers within a minute with the draft, whose elements
 * are marked «предложено ИИ»; the card opens on it.
 */
function NewPlanDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const online = useOnline();
  const [scope, setScope] = useState<ScopeChoice>(EMPTY_SCOPE);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"manual" | "ai" | null>(null);
  const [error, setError] = useState<{ text: string; field: string | null } | null>(null);

  const submit = async (kind: "manual" | "ai") => {
    if (!scope.makeId) {
      setError({ text: "Марка обязательна", field: "makeId" });
      return;
    }
    setError(null);
    setBusy(kind);
    const body = { scope: scopeInputOf(scope), ...(name.trim() ? { name: name.trim() } : {}) };
    try {
      const answer =
        kind === "ai"
          ? await apiClient.draftMaintenancePlan(body)
          : await apiClient.createMaintenancePlan(body);
      navigateTo(maintenancePlanPath(answer.plan.id));
    } catch (thrown) {
      setError({ text: maintenanceErrorText(thrown), field: null });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => busy === null && onClose()}
      title="Новый план"
      actions={
        <>
          <Button
            icon="sparkles"
            loading={busy === "ai"}
            disabled={busy !== null || !online}
            onClick={() => void submit("ai")}
          >
            Сгенерировать черновик ИИ
          </Button>
          <Button
            variant="secondary"
            loading={busy === "manual"}
            disabled={busy !== null || !online}
            onClick={() => void submit("manual")}
          >
            Создать вручную
          </Button>
          <Button variant="text" disabled={busy !== null} onClick={onClose}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">
        <ScopeFields
          value={scope}
          onChange={setScope}
          errorField={error?.field}
          errorText={error?.text}
        />
        <TextField
          label="Название"
          value={name}
          onChange={setName}
          hint="Служебное, для администратора. Пусто — по области: «Geely · Coolray»"
        />
        {busy === "ai" && (
          <Banner tone="neutral" icon="sparkles">
            <span className="row-actions">
              <Spinner size={16} />
              ИИ составляет черновик по открытым данным производителя — обычно до минуты. Ничего не
              активируется: каждый элемент вы подтвердите сами.
            </span>
          </Banner>
        )}
        {error && error.field === null && <Banner tone="warning">{error.text}</Banner>}
      </div>
    </Dialog>
  );
}

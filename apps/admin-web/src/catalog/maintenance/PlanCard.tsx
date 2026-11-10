import type {
  AdminMaintenanceItem,
  AdminMaintenancePlanResponse,
  MaintenancePlanCheckResponse,
} from "@adclub/contracts";
import {
  AiBadge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  LoadingContent,
  MenuButton,
  Select,
  SkeletonList,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../../api";
import { JournalHistory } from "../../audit/JournalHistory";
import { loadErrorText } from "../../errors";
import { formatMoment } from "../../format";
import { AppLink, Header, Table } from "../../layout/layout";
import { maintenancePlanPath, navigateTo, routePaths, withQuery } from "../../router";
import { CitySelect, useCities } from "../../suppliers/shared";
import { useLoad } from "../../use-load";
import { NamesLine, OrderArrows } from "../catalog-ui";
import { CATALOG_CRUMB, MAINTENANCE_CRUMB, whoChanged } from "../shared";
import { EMPTY_CHOICE, VehicleFields, vehicleOf, type VehicleChoice } from "../VehicleFields";
import { ItemDialog } from "./ItemDialog";
import {
  ITEM_KIND_TEXT,
  ITEM_STATUS_TEXT,
  LEVEL_TEXT,
  PLAN_STATUS_TEXT,
  PROBLEM_TEXT,
  REASON_TEXT,
  activePlanOf,
  catalogCountText,
  firstText,
  intervalText,
  isMaintenanceConflict,
  maintenanceErrorText,
  notReadyLines,
  numberOf,
  scopeLabelText,
} from "./maintenance-words";
import { SourceMark } from "./Plans";
import { EMPTY_SCOPE, ScopeFields, scopeInputOf, type ScopeChoice } from "./ScopeFields";

const COLUMNS = [
  { key: "work", header: "Работа" },
  { key: "interval", header: "Интервал", width: 200 },
  { key: "rule", header: "Правило подбора" },
  { key: "quantity", header: "Кол-во", width: 80, numeric: true },
  { key: "actions", header: "Действия", actions: true, hiddenHeader: true, width: 184 },
];

const CHECK_COLUMNS = [
  { key: "work", header: "Работа" },
  { key: "reason", header: "Почему", width: 170 },
  { key: "catalog", header: "Справочник и продажа", width: 280 },
];

type Notice =
  | { kind: "conflict"; text: string }
  | { kind: "error"; text: string }
  | { kind: "not_ready"; lines: string[] }
  | { kind: "active_exists"; planId: string };

/**
 * The card of a maintenance plan (TASK-061): its area, source, status and
 * version; the elements with their intervals, codes and rules in words —
 * what AI proposed marked until confirmed («Подтвердить» / «Изменить» /
 * «Убрать», «Подтвердить все предложенные»); the order; «Активировать план»
 * with the server's reasons when it refuses; «Скопировать для…»;
 * «Проверить на автомобиле» — the server's answer for a car; the archive;
 * the journal. A colleague's change meanwhile is the server's 409 —
 * «Эти данные только что изменил {кто}» and «Обновить данные».
 */
export function MaintenancePlanCard({ planId }: { planId: string }) {
  const toast = useToast();
  const online = useOnline();
  const data = useLoad<AdminMaintenancePlanResponse>(
    () => apiClient.getAdminMaintenancePlan({ planId }),
    `maintenance-plan:${planId}`,
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<AdminMaintenanceItem | "new" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [copying, setCopying] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const plan = data.data?.plan;
  const items = data.data?.items ?? [];
  const live = items.filter((item) => item.status !== "archived");
  const proposed = live.filter((item) => item.status === "proposed");
  const titleOf = (itemId: string) =>
    items.find((item) => item.id === itemId)?.title.ru?.text ?? "элемент";
  const editable = plan !== undefined && plan.status !== "archived" && !plan.generating;

  const act = async (
    action: () => Promise<AdminMaintenancePlanResponse>,
    done: string | ((answer: AdminMaintenancePlanResponse) => string),
    conflictOf: [string, string],
  ) => {
    setNotice(null);
    try {
      const answer = await action();
      data.replace(answer);
      toast.show(typeof done === "string" ? done : done(answer));
    } catch (thrown) {
      const active = activePlanOf(thrown);
      const lines = notReadyLines(thrown, titleOf);
      if (isMaintenanceConflict(thrown)) {
        setNotice({
          kind: "conflict",
          text: `Эти данные только что изменил ${(await whoChanged(conflictOf[0], conflictOf[1])) ?? "другой администратор"}`,
        });
      } else if (active) {
        setNotice({ kind: "active_exists", planId: active });
      } else if (lines) {
        setNotice({ kind: "not_ready", lines });
      } else {
        setNotice({ kind: "error", text: maintenanceErrorText(thrown) });
      }
    }
  };

  const setPlanStatus = (status: "active" | "archived" | "draft", done: string) => {
    if (!plan) return;
    void act(
      () =>
        apiClient.setMaintenancePlanStatus({ planId }, { expectedVersion: plan.version, status }),
      done,
      ["maintenance_plan", planId],
    );
  };

  const move = (item: AdminMaintenanceItem, by: -1 | 1) => {
    const order = live.map((entry) => entry.id);
    const from = order.indexOf(item.id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= order.length) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, item.id);
    void act(
      () => apiClient.reorderMaintenanceItems({ planId }, { itemIds: next, expectedOrder: order }),
      "Порядок изменён",
      ["maintenance_plan", planId],
    );
  };

  const itemStatus = (item: AdminMaintenanceItem, status: "active" | "archived", done: string) =>
    void act(
      () =>
        apiClient.setMaintenanceItemStatus(
          { itemId: item.id },
          { expectedVersion: item.version, status },
        ),
      done,
      ["maintenance_plan_item", item.id],
    );

  return (
    <>
      <Header
        crumbs={[CATALOG_CRUMB, MAINTENANCE_CRUMB]}
        title={plan?.name ?? "Регламент ТО"}
        subtitle={
          plan && (
            <span className="row-actions">
              <SourceMark source={plan.source} />
              <span className="ac-text-body-s">
                {plan.generating ? "ИИ составляет черновик…" : PLAN_STATUS_TEXT[plan.status]}
              </span>
              <span className="ac-text-body-s ac-muted">{scopeLabelText(plan.label)}</span>
              <span className="ac-text-caption ac-muted">версия {plan.version}</span>
              {plan.confirmedBy && (
                <span className="ac-text-caption ac-muted">
                  подтвердил {plan.confirmedBy.name ?? "администратор"},{" "}
                  {formatMoment(plan.confirmedAt)}
                </span>
              )}
            </span>
          )
        }
        actions={
          plan && (
            <>
              {plan.status === "draft" && (
                <Button
                  icon="check"
                  disabled={!online || plan.generating}
                  onClick={() => setPlanStatus("active", "План активирован: клиенты видят его")}
                >
                  Активировать план
                </Button>
              )}
              {plan.status === "archived" && (
                <Button
                  variant="secondary"
                  disabled={!online}
                  onClick={() => setPlanStatus("draft", "План восстановлен как черновик")}
                >
                  Восстановить
                </Button>
              )}
              <MenuButton
                text="Ещё"
                label="Действия с планом"
                disabled={!online || plan.generating}
                actions={[
                  {
                    key: "rename",
                    label: "Изменить…",
                    icon: "settings",
                    onSelect: () => setRenaming(true),
                  },
                  {
                    key: "copy",
                    label: "Скопировать для…",
                    icon: "copy",
                    onSelect: () => setCopying(true),
                  },
                  ...(plan.status !== "archived"
                    ? [
                        {
                          key: "archive",
                          label: "В архив…",
                          icon: "archive" as const,
                          destructive: true,
                          onSelect: () => setArchiving(true),
                        },
                      ]
                    : []),
                ]}
              />
            </>
          )
        }
      />
      {notice?.kind === "conflict" && (
        <Banner
          tone="warning"
          action={
            <Button
              variant="text"
              size="s"
              onClick={() => {
                setNotice(null);
                data.reload();
              }}
            >
              Обновить данные
            </Button>
          }
        >
          {notice.text}
        </Banner>
      )}
      {notice?.kind === "error" && <Banner tone="warning">{notice.text}</Banner>}
      {notice?.kind === "not_ready" && (
        <Banner tone="warning">
          <div className="cell-stack">
            <span className="ac-text-body-strong">План нельзя активировать:</span>
            {notice.lines.map((line) => (
              <span key={line} className="ac-text-body-s">
                {line}
              </span>
            ))}
          </div>
        </Banner>
      )}
      {notice?.kind === "active_exists" && (
        <Banner
          tone="warning"
          action={
            <AppLink href={maintenancePlanPath(notice.planId)}>Открыть действующий план</AppLink>
          }
        >
          У этой области уже есть действующий план. Сначала уберите его в архив или измените область
          этого плана.
        </Banner>
      )}
      {data.data?.activePlanId && plan?.status !== "active" && notice?.kind !== "active_exists" && (
        <Banner
          tone="neutral"
          action={
            <AppLink href={maintenancePlanPath(data.data.activePlanId)}>
              Открыть действующий план
            </AppLink>
          }
        >
          У этой области уже есть действующий план — этот можно будет активировать после его
          архивации.
        </Banner>
      )}
      {data.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={data.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(data.error)}
        </Banner>
      )}
      <LoadingContent
        ready={data.data !== undefined}
        indicator={data.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <div className="cat-sections">
          <section className="section">
            <div className="section__head">
              <h3 className="section__title">Элементы</h3>
              <span className="row-actions">
                {proposed.length > 0 && (
                  <Button
                    variant="secondary"
                    size="s"
                    icon="check"
                    disabled={!online || !editable}
                    onClick={() =>
                      plan &&
                      void act(
                        () =>
                          apiClient.confirmMaintenanceItems(
                            { planId },
                            { expectedVersion: plan.version },
                          ),
                        (answer) => {
                          const result = answer as AdminMaintenancePlanResponse & {
                            confirmed?: number;
                            skipped?: number;
                          };
                          return result.skipped
                            ? `Подтверждено: ${String(result.confirmed ?? 0)}. Без правила или с ошибкой осталось: ${String(result.skipped)}`
                            : `Подтверждено: ${String(result.confirmed ?? 0)}`;
                        },
                        ["maintenance_plan", planId],
                      )
                    }
                  >
                    Подтвердить все предложенные · {proposed.length}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="s"
                  icon="plus"
                  disabled={!online || !editable}
                  onClick={() => setEditing("new")}
                >
                  Добавить элемент
                </Button>
              </span>
            </div>
            {plan?.source === "ai_draft" && proposed.length > 0 && (
              <p className="section__note">
                Черновик составил ИИ по открытым данным производителя. Проверьте каждый элемент:
                интервалы, коды ТО и правило подбора — клиенты увидят план только после активации.
              </p>
            )}
            {items.length === 0 ? (
              <EmptyState
                compact
                icon="wrench"
                title="Элементов нет"
                text="Добавьте работу: что менять или делать, с каким интервалом и по какому правилу подбирать позиции справочника"
              />
            ) : (
              <Table label="Элементы плана" columns={COLUMNS}>
                {items.map((item) => {
                  const index = live.indexOf(item);
                  const title = item.title.ru?.text ?? "Без названия";
                  return (
                    <tr
                      key={item.id}
                      className={item.status === "archived" ? "row--muted" : undefined}
                    >
                      <td>
                        <div className="cell-stack">
                          <span className="row-actions">
                            {item.status !== "archived" && (
                              <OrderArrows
                                name={title}
                                first={index === 0}
                                last={index === live.length - 1}
                                disabled={!online || !editable}
                                onMove={(by) => move(item, by)}
                              />
                            )}
                            <span className="ac-text-body-strong long-text">{title}</span>
                          </span>
                          {item.status === "proposed" && <AiBadge>предложено ИИ</AiBadge>}
                          <NamesLine texts={item.title} />
                          <span className="ac-text-caption ac-muted">
                            {ITEM_KIND_TEXT[item.kind]}
                            {item.status === "archived" ? ` · ${ITEM_STATUS_TEXT.archived}` : ""}
                          </span>
                          {item.note && (
                            <span className="ac-text-caption ac-muted long-text">{item.note}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          <span className="ac-text-body-s">{intervalText(item)}</span>
                          {firstText(item) && (
                            <span className="ac-text-caption ac-muted">{firstText(item)}</span>
                          )}
                          {item.serviceCodes.length > 0 && (
                            <span className="ac-text-caption ac-muted">
                              {item.serviceCodes.join(", ")}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          <span className="ac-text-body-s long-text">
                            {item.targetLabel ?? "Правило не задано"}
                          </span>
                          {item.problems.map((problem) => (
                            <span key={problem} className="ac-text-caption ac-danger">
                              {PROBLEM_TEXT[problem]}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="num">{item.quantity ?? "—"}</td>
                      <td className="admin-table__actions">
                        <span className="row-actions">
                          {item.status === "proposed" && (
                            <Button
                              variant="secondary"
                              size="s"
                              disabled={!online || !editable || item.problems.length > 0}
                              onClick={() => itemStatus(item, "active", "Элемент подтверждён")}
                            >
                              Подтвердить
                            </Button>
                          )}
                          {item.status === "archived" ? (
                            <Button
                              variant="secondary"
                              size="s"
                              disabled={!online || !editable}
                              onClick={() => itemStatus(item, "active", "Элемент восстановлен")}
                            >
                              Восстановить
                            </Button>
                          ) : (
                            <MenuButton
                              size="s"
                              label={`Действия: ${title}`}
                              disabled={!online || !editable}
                              actions={[
                                {
                                  key: "edit",
                                  label: "Изменить…",
                                  icon: "settings",
                                  onSelect: () => setEditing(item),
                                },
                                {
                                  key: "archive",
                                  label: "Убрать",
                                  icon: "archive",
                                  destructive: true,
                                  onSelect: () => itemStatus(item, "archived", "Элемент убран"),
                                },
                              ]}
                            />
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </section>
          {plan && <PlanCheck planId={planId} codes={serviceCodes(items)} />}
          <section className="section">
            <JournalHistory
              filter={{ entityType: "maintenance_plan", entityId: planId }}
              loadKey={`maintenance-history:${planId}:${String(plan?.version ?? 0)}`}
              caption="История плана"
            />
          </section>
        </div>
      </LoadingContent>

      {plan && (
        <ItemDialog
          planId={planId}
          editing={editing}
          onCancel={() => setEditing(null)}
          onDone={(answer, text) => {
            setEditing(null);
            data.replace(answer);
            toast.show(text);
          }}
        />
      )}
      {plan && renaming && (
        <RenameDialog
          plan={plan}
          onClose={() => setRenaming(false)}
          onSave={(name, scope) => {
            setRenaming(false);
            void act(
              () =>
                apiClient.updateMaintenancePlan(
                  { planId },
                  { expectedVersion: plan.version, name, ...(scope ? { scope } : {}) },
                ),
              "План изменён",
              ["maintenance_plan", planId],
            );
          }}
        />
      )}
      {plan && copying && <CopyDialog planId={planId} onClose={() => setCopying(false)} />}
      <Dialog
        open={archiving}
        onClose={() => setArchiving(false)}
        title="Убрать план в архив?"
        actions={
          <>
            <Button
              destructive
              onClick={() => {
                setArchiving(false);
                setPlanStatus("archived", "План в архиве");
              }}
            >
              В архив
            </Button>
            <Button variant="secondary" onClick={() => setArchiving(false)}>
              Отмена
            </Button>
          </>
        }
      >
        <p className="ac-text-body-s">
          {plan?.status === "active"
            ? "Клиенты и помощник перестанут видеть этот план; для области будет действовать более общий план, если он есть."
            : "Черновик уйдёт в архив; его можно восстановить."}{" "}
          План останется в истории.
        </p>
      </Dialog>
    </>
  );
}

function serviceCodes(items: readonly AdminMaintenanceItem[]): string[] {
  const codes = new Map<string, string>();
  for (const item of items) {
    if (item.status === "archived") continue;
    for (const code of item.serviceCodes) codes.set(code.toLowerCase(), code);
  }
  const number = (code: string) => Number(/\d+/u.exec(code)?.[0] ?? Number.NaN);
  return [...codes.values()].sort((a, b) => number(a) - number(b) || a.localeCompare(b, "ru"));
}

/** «Изменить…»: the name, and the area of a plan that is not active. */
function RenameDialog({
  plan,
  onClose,
  onSave,
}: {
  plan: AdminMaintenancePlanResponse["plan"];
  onClose: () => void;
  onSave: (name: string, scope: ReturnType<typeof scopeInputOf> | null) => void;
}) {
  const [name, setName] = useState(plan.name);
  const [scope, setScope] = useState<ScopeChoice>({
    makeId: plan.scope.makeId,
    modelId: plan.scope.modelId ?? "",
    generationId: plan.scope.generationId ?? "",
    engineId: plan.scope.engineId ?? "",
  });
  const [scopeTouched, setScopeTouched] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Изменить план"
      actions={
        <>
          <Button
            disabled={!name.trim() || !scope.makeId}
            onClick={() => onSave(name.trim(), scopeTouched ? scopeInputOf(scope) : null)}
          >
            Сохранить
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">
        <TextField label="Название" value={name} onChange={setName} />
        {plan.status === "active" ? (
          <p className="ac-text-body-s ac-muted">
            Область действующего плана не меняется: {scopeLabelText(plan.label)}. Чтобы сменить её,
            уберите план в архив или сделайте копию.
          </p>
        ) : (
          <>
            <p className="ac-text-body-s ac-muted">Сейчас: {scopeLabelText(plan.label)}</p>
            <ScopeFields
              value={scope}
              onChange={(next) => {
                setScope(next);
                setScopeTouched(true);
              }}
            />
          </>
        )}
      </div>
    </Dialog>
  );
}

/** «Скопировать для…»: a new manual draft of another area with the same elements. */
function CopyDialog({ planId, onClose }: { planId: string; onClose: () => void }) {
  const [scope, setScope] = useState<ScopeChoice>(EMPTY_SCOPE);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!scope.makeId) {
      setError("Марка обязательна");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const answer = await apiClient.copyMaintenancePlan(
        { planId },
        { scope: scopeInputOf(scope), ...(name.trim() ? { name: name.trim() } : {}) },
      );
      onClose();
      navigateTo(maintenancePlanPath(answer.plan.id));
    } catch (thrown) {
      setError(maintenanceErrorText(thrown));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Скопировать план"
      actions={
        <>
          <Button loading={busy} onClick={() => void submit()}>
            Скопировать
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">
        <p className="ac-text-body-s ac-muted">
          Новый черновик с теми же элементами — для соседнего поколения или другого двигателя. Если
          у области уже есть действующий план, копию можно будет активировать после его архивации.
        </p>
        <ScopeFields
          value={scope}
          onChange={setScope}
          errorField={error ? "makeId" : null}
          errorText={error}
        />
        <TextField label="Название" value={name} onChange={setName} hint="Пусто — по области" />
      </div>
    </Dialog>
  );
}

/**
 * «Проверить на автомобиле»: the server's answer for this plan and a car —
 * the due elements (proposed ones too), how many items of each rule the
 * catalog has and how many are sold for this car and city, with a link to
 * the subcategory's items list.
 */
function PlanCheck({ planId, codes }: { planId: string; codes: string[] }) {
  const cities = useCities();
  const [choice, setChoice] = useState<VehicleChoice>(EMPTY_CHOICE);
  const [mileage, setMileage] = useState("");
  const [cityId, setCityId] = useState("");
  const [code, setCode] = useState("");
  const [answer, setAnswer] = useState<MaintenancePlanCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const mileageKm = numberOf(mileage);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setAnswer(
        await apiClient.checkMaintenancePlan(
          { planId },
          {
            vehicle: vehicleOf(choice),
            ...(typeof mileageKm === "number" ? { mileageKm } : {}),
            ...(code ? { serviceCode: code } : {}),
            ...(cityId ? { cityId } : {}),
          },
        ),
      );
    } catch (thrown) {
      setAnswer(null);
      setError(maintenanceErrorText(thrown));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="card cat-block">
      <div className="section__head">
        <h3 className="section__title">Проверить на автомобиле</h3>
      </div>
      <p className="section__note">
        Ответ считает сервер: что положено по плану и сколько позиций каждого правила есть в
        справочнике и продаётся для этого автомобиля и города — так же, как каталог приложения.
      </p>
      <VehicleFields value={choice} onChange={setChoice} mode="car" compact />
      <div className="filters">
        <TextField
          className="ac-field--compact"
          label="Пробег, км"
          value={mileage}
          onChange={setMileage}
          inputMode="numeric"
          placeholder="Например, 20 000"
          error={mileageKm === undefined ? "Только цифры" : undefined}
        />
        <Select<string>
          compact
          label="Код ТО"
          value={code || "any"}
          options={[
            { value: "any", label: "По пробегу" },
            ...codes.map((entry) => ({ value: entry, label: entry })),
          ]}
          onChange={(next) => setCode(next === "any" ? "" : next)}
        />
        <CitySelect value={cityId} onChange={setCityId} cities={cities} any="Без города" />
      </div>
      <div className="row-actions">
        <Button
          variant="secondary"
          loading={checking}
          disabled={!choice.makeId || mileageKm === undefined}
          onClick={() => void check()}
        >
          Проверить
        </Button>
        {!choice.makeId && <span className="ac-text-caption ac-muted">Сначала выберите марку</span>}
      </div>
      {error && <Banner tone="warning">{error}</Banner>}
      {answer && (
        <div className="dialog-stack" role="status">
          <span className="ac-text-body-s">
            {answer.scope.result === "fits"
              ? "Область плана подходит автомобилю."
              : answer.scope.result === "needs_details"
                ? `Плану нужно больше данных об автомобиле: ${answer.scope.missing.map((level) => LEVEL_TEXT[level]).join(", ")}.`
                : "Область плана не подходит этому автомобилю — ему достанется другой план."}
            {answer.serviceKm !== null &&
              ` Ближайшее ТО — ${answer.serviceKm.toLocaleString("ru-RU")} км, следующее — ${(answer.nextServiceKm ?? 0).toLocaleString("ru-RU")} км.`}
          </span>
          {answer.reason === "mileage_required" ? (
            <Banner tone="neutral">
              Укажите пробег или код ТО — без них план ничего не назначит.
            </Banner>
          ) : answer.items.length === 0 ? (
            <EmptyState
              compact
              icon="checklist"
              title="Ничего не положено"
              text="На этом пробеге по плану работ нет"
            />
          ) : (
            <Table label="Что положено автомобилю" columns={CHECK_COLUMNS}>
              {answer.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="cell-stack">
                      <span className="ac-text-body-strong">{item.title.text}</span>
                      {item.status === "proposed" && <AiBadge>предложено ИИ</AiBadge>}
                      {item.problems.map((problem) => (
                        <span key={problem} className="ac-text-caption ac-danger">
                          {PROBLEM_TEXT[problem]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="ac-text-body-s">
                    {REASON_TEXT[item.reason]}
                    {item.atKm !== null && ` · ${item.atKm.toLocaleString("ru-RU")} км`}
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span className="ac-text-body-s">
                        {catalogCountText(
                          item.catalogTotal,
                          item.catalog.count,
                          item.catalog.cityRequired,
                        )}
                      </span>
                      {item.catalog.minPrice !== null && (
                        <span className="ac-text-caption ac-muted">
                          от {item.catalog.minPrice.toLocaleString("ru-RU")} ₸
                        </span>
                      )}
                      {item.catalog.categoryId && (
                        <AppLink
                          href={withQuery(routePaths.catalogItems, {
                            categoryId: item.catalog.categoryId,
                          })}
                        >
                          Позиции подкатегории
                        </AppLink>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      )}
    </section>
  );
}

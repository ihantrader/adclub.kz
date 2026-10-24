import { isApiError } from "@adclub/api-client";
import type {
  AdminVehicleImport,
  AdminVehicleOptionListResponse,
  VehicleImportPlan,
  VehicleImportRow,
} from "@adclub/contracts";
import type { IconName, Tone } from "@adclub/ui-core";
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  LoadingContent,
  SkeletonList,
  StatusBadge,
  TableToolbar,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { StatusChips } from "../layout/filters";
import { AppLink, Header, Muted, Table, type Column } from "../layout/layout";
import { navigateTo, routePaths, vehicleImportPath } from "../router";
import { useLoad } from "../use-load";
import {
  IMPORTS_CRUMB,
  LoadError,
  MoreButton,
  RefreshButton,
  usePaged,
  VEHICLES_CRUMB,
} from "./shared";
import {
  countText,
  IMPORT_STATUS_TEXT,
  OUTCOME_TEXT,
  optionNameOf,
  personText,
  PLAN_TEXT,
  reasonText,
  rowNumbersText,
  ROWS,
  vehicleErrorView,
} from "./vehicle-words";

/** How often a working import is asked again: the page follows it by itself. */
const POLL_MS = 1500;

type Options = AdminVehicleOptionListResponse["options"];

const working = (entry: AdminVehicleImport | undefined) =>
  entry?.status === "parsing" || entry?.status === "applying";

/** The mark of a row's plan and of its outcome (X7): a badge, never colored text. */
const PLAN_ROLE: Record<VehicleImportPlan, { tone: Tone; icon: IconName }> = {
  create: { tone: "accent", icon: "plus" },
  update: { tone: "accent", icon: "refresh" },
  unchanged: { tone: "neutral", icon: "check" },
  rejected: { tone: "danger", icon: "circleX" },
};

const OUTCOME_ROLE: Record<keyof typeof OUTCOME_TEXT, { tone: Tone; icon: IconName }> = {
  created: { tone: "success", icon: "plus" },
  updated: { tone: "success", icon: "refresh" },
  unchanged: { tone: "neutral", icon: "check" },
  rejected: { tone: "danger", icon: "circleX" },
};

const ROW_COLUMNS: Column[] = [
  { key: "row", header: "Строка", width: 76, numeric: true },
  { key: "car", header: "Автомобиль" },
  { key: "years", header: "Годы", width: 104 },
  { key: "market", header: "Рынок", width: 80 },
  { key: "plan", header: "План", width: 240 },
];

const REJECTED_COLUMNS: Column[] = [
  { key: "row", header: "Строка", width: 76, numeric: true },
  { key: "reasons", header: "Что не так" },
];

/** «Geely Coolray I (SX11)» and the rest of a row as read. */
function rowCar(values: Record<string, string>): string {
  return [values.make, values.model, values.generation].filter(Boolean).join(" ") || "—";
}

/** The lists' values of a row by their names («Кроссовер · JLH-3G15TD · Робот (DCT) · Передний»). */
function rowSpecs(values: Record<string, string>, options: Options): string {
  return [
    optionNameOf(options, "body", values.body),
    values.engine_code,
    optionNameOf(options, "transmission", values.transmission),
    optionNameOf(options, "drive", values.drive),
  ]
    .filter(Boolean)
    .join(" · ");
}

function rowYears(values: Record<string, string>): string {
  if (!values.year_from) return "—";
  return `${values.year_from}–${values.year_to || "н.в."}`;
}

/** The four numbers of a report or a result: big figures with their words. */
function Numbers({ entries }: { entries: { label: string; value: number; warn?: boolean }[] }) {
  return (
    <dl className="vehicles-numbers">
      {entries.map((entry) => (
        <div key={entry.label} className="vehicles-numbers__item">
          <dt>{entry.label}</dt>
          <dd className={entry.warn && entry.value > 0 ? "num vehicles-numbers--warn" : "num"}>
            {entry.value.toLocaleString("ru-RU")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A-CAR-02, one import (SCREENS 7.2; TASK-035.B, TASK-080): the crumbs
 * «Автомобили › Импорт», the file's name with its status; while the server
 * checks the rows — the waiting and how far it has got, the page asks again
 * by itself; then the report before anything changes — the four numbers,
 * the rejected rows with their row numbers and reasons, the makes, models,
 * generations and engines the file would create, every row by its plan (the
 * values of the lists by their names); «Применить» once, with the numbers —
 * or, with nothing to apply, one «Закрыть»; then the result and the rows
 * that went otherwise than the report said.
 */
export function ImportReport({ importId }: { importId: string }) {
  const toast = useToast();
  const online = useOnline();
  const entry = useLoad<AdminVehicleImport>(
    async () => (await apiClient.getVehicleImport({ importId })).import,
    importId,
  );
  const options = useLoad<AdminVehicleOptionListResponse>(
    () => apiClient.listVehicleOptions(),
    "options",
  );
  const current = entry.data && entry.data.id === importId ? entry.data : undefined;
  const [plan, setPlan] = useState<VehicleImportPlan | undefined>(undefined);
  const [confirming, setConfirming] = useState<"apply" | "cancel" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const same = useLoad<AdminVehicleImport | null>(
    async () =>
      current?.sameFileAsImportId
        ? (await apiClient.getVehicleImport({ importId: current.sameFileAsImportId })).import
        : null,
    current?.sameFileAsImportId ?? "none",
  );

  // The page follows a working import by itself; it stops once the job is done.
  const reload = entry.reload;
  useEffect(() => {
    if (!working(current)) return;
    const timer = setTimeout(reload, POLL_MS);
    return () => clearTimeout(timer);
  }, [current, reload]);

  const ready = current?.status === "ready";
  const applied = current?.status === "applied";
  const rows = usePaged<VehicleImportRow & { id: string }>(
    async (cursor) => {
      const page = await apiClient.listVehicleImportRows(
        { importId },
        { query: { ...(plan ? { planned: plan } : {}), limit: 50, cursor } },
      );
      return {
        items: page.rows.map((row) => ({ ...row, id: String(row.row) })),
        total: page.total,
        nextCursor: page.nextCursor,
      };
    },
    JSON.stringify({ importId, plan, status: current?.status }),
  );
  const differing = usePaged<VehicleImportRow & { id: string }>(async (cursor) => {
    if (!applied || !current?.result?.differsFromReport) {
      return { items: [], total: 0, nextCursor: null };
    }
    const page = await apiClient.listVehicleImportRows(
      { importId },
      { query: { differsFromReport: "true", limit: 50, cursor } },
    );
    return {
      items: page.rows.map((row) => ({ ...row, id: String(row.row) })),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }, JSON.stringify({ importId, applied }));

  /** «Применить», «Отменить импорт», and «Закрыть» of a report with nothing to apply. */
  const act = async (what: "apply" | "cancel" | "close") => {
    setBusy(true);
    setActionError(null);
    try {
      const answer =
        what === "apply"
          ? await apiClient.applyVehicleImport({ importId })
          : await apiClient.cancelVehicleImport({ importId });
      setConfirming(null);
      if (what === "close") {
        toast.show("Импорт закрыт");
        navigateTo(routePaths.vehicleImports);
        return;
      }
      entry.replace(answer.import);
      toast.show(what === "apply" ? "Импорт применяется" : "Импорт отменён");
    } catch (thrown) {
      if (isApiError(thrown) && thrown.code === "VEHICLE_IMPORT_STATE") {
        // Someone else got there first: say who and what the import is now.
        const now = (await apiClient.getVehicleImport({ importId }).catch(() => null))?.import;
        if (now) entry.replace(now);
        setConfirming(null);
        setActionError(
          now?.status === "applied" || now?.status === "applying"
            ? `Импорт уже ${now.status === "applied" ? "применён" : "применяется"}: ${personText(now.appliedBy)}, ${formatMoment(now.appliedAt)}`
            : now?.status === "cancelled"
              ? "Импорт уже отменён"
              : `Импорт сейчас: ${now ? IMPORT_STATUS_TEXT[now.status].toLowerCase() : "изменился"}`,
        );
      } else {
        setActionError(vehicleErrorView(thrown).text);
      }
    } finally {
      setBusy(false);
    }
  };

  const report = current?.report ?? null;
  const progress = current?.progress ?? null;
  const nothingToApply = report !== null && report.create + report.update === 0;
  const optionList = options.data?.options ?? [];
  return (
    <>
      <Header
        crumbs={[VEHICLES_CRUMB, IMPORTS_CRUMB]}
        title={current ? (current.fileName ?? "Импорт") : "Импорт"}
        subtitle={
          current && (
            <>
              <span aria-live="polite">
                <StatusBadge kind="vehicleImport" status={current.status}>
                  {IMPORT_STATUS_TEXT[current.status]}
                </StatusBadge>
              </span>
              <span>{countText(current.rowCount, ROWS)}</span>
              <span>
                загрузил {personText(current.uploadedBy)}, {formatMoment(current.createdAt)}
              </span>
            </>
          )
        }
        actions={<RefreshButton onClick={entry.reload} />}
      />
      <LoadError error={entry.error} retry={entry.reload} />
      <LoadingContent
        ready={current !== undefined}
        indicator={entry.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        {current && (
          <div className="vehicles-stack vehicles-stack--page">
            {same.data && (
              <Banner tone="warning">
                Этот файл уже загружали {formatMoment(same.data.createdAt)} ·{" "}
                <AppLink href={vehicleImportPath(same.data.id)}>Открыть прошлый импорт</AppLink>
              </Banner>
            )}
            {actionError && <Banner tone="warning">{actionError}</Banner>}

            {working(current) && (
              <section className="card" aria-live="polite">
                <p className="ac-text-body-strong">
                  {current.status === "parsing"
                    ? "Проверяем строки файла…"
                    : "Применяем строки к справочнику…"}
                </p>
                {progress && progress.total > 0 && (
                  <div className="cell-stack vehicles-progress">
                    <div
                      className="progress"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={progress.total}
                      aria-valuenow={progress.done}
                    >
                      <div
                        className="progress__bar"
                        style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                      />
                    </div>
                    <p className="section__note">
                      {progress.done.toLocaleString("ru-RU")} из{" "}
                      {progress.total.toLocaleString("ru-RU")} — страница обновится сама
                    </p>
                  </div>
                )}
                {current.status === "parsing" && (
                  <p className="section__note">В справочнике пока ничего не меняется.</p>
                )}
              </section>
            )}

            {report && !applied && (
              <section className="card" aria-labelledby="report-numbers">
                <h2 id="report-numbers" className="card__title">
                  Отчёт до применения
                </h2>
                <Numbers
                  entries={[
                    { label: PLAN_TEXT.create, value: report.create },
                    { label: PLAN_TEXT.update, value: report.update },
                    { label: PLAN_TEXT.unchanged, value: report.unchanged },
                    { label: "Ошибок", value: report.rejected, warn: true },
                  ]}
                />
                {report.rejected > 0 && (
                  <p className="ac-text-body-s">
                    Строки с ошибками: {rowNumbersText(report.rejectedRows.map((row) => row.row))}
                    {report.rejected > report.rejectedRows.length ? " и другие" : ""}.
                    {ready ? " Они не применятся; остальные — да." : ""}
                  </p>
                )}
                {ready &&
                  (nothingToApply ? (
                    <ActionBar
                      label="Действия с импортом"
                      main={
                        <Button disabled={!online} loading={busy} onClick={() => void act("close")}>
                          Закрыть
                        </Button>
                      }
                      note="Применять нечего: все строки уже есть в справочнике или с ошибками. «Закрыть» завершит импорт, справочник не изменится."
                    />
                  ) : (
                    <>
                      <Banner tone="neutral">
                        До «Применить» в справочнике ничего не меняется. «Обновится» меняет только
                        рынок модификации.
                      </Banner>
                      <ActionBar
                        label="Действия с импортом"
                        main={
                          <Button disabled={!online} onClick={() => setConfirming("apply")}>
                            Применить
                          </Button>
                        }
                        others={[
                          <Button
                            key="cancel"
                            variant="secondary"
                            disabled={!online}
                            onClick={() => setConfirming("cancel")}
                          >
                            Отменить импорт
                          </Button>,
                        ]}
                      />
                    </>
                  ))}
              </section>
            )}

            {applied && current.result && (
              <section className="card" aria-labelledby="result-numbers">
                <div className="cell-stack">
                  <h2 id="result-numbers" className="card__title">
                    Итог
                  </h2>
                  <p className="section__note">
                    Применил {personText(current.appliedBy)}, {formatMoment(current.appliedAt)}.
                    Изменения видны в приложении не позже чем через минуту.
                  </p>
                </div>
                <Numbers
                  entries={[
                    ...(["created", "updated", "unchanged", "rejected"] as const).map((key) => ({
                      label: OUTCOME_TEXT[key],
                      value: current.result![key],
                    })),
                    {
                      label: "Решено иначе, чем в отчёте",
                      value: current.result.differsFromReport,
                      warn: true,
                    },
                  ]}
                />
              </section>
            )}

            {applied && current.result && current.result.differsFromReport > 0 && (
              <section className="section" aria-labelledby="differs">
                <div className="cell-stack">
                  <h2 id="differs" className="section__title">
                    Решено иначе, чем в отчёте
                  </h2>
                  <p className="section__note">
                    Справочник изменили вручную после отчёта, и при применении эти строки проверены
                    заново.
                  </p>
                </div>
                <RowsTable list={differing} mode="differs" options={optionList} />
              </section>
            )}

            {current.status === "cancelled" && (
              <Banner tone="neutral">
                Импорт отменён{current.finishedAt ? ` ${formatMoment(current.finishedAt)}` : ""} — в
                справочнике ничего не изменилось.
              </Banner>
            )}
            {current.status === "failed" && (
              <Banner tone="danger">
                Импорт прервался по времени.{" "}
                {current.appliedAt
                  ? "Строки, применённые до этого, остались применёнными; загрузите файл заново — уже применённые строки окажутся «без изменений»."
                  : "В справочнике ничего не изменилось — загрузите файл заново."}
              </Banner>
            )}

            {report &&
              (report.newMakes.length > 0 ||
                report.newModels.length > 0 ||
                report.newGenerations.length > 0 ||
                report.newEngines.length > 0) && (
                <section className="section" aria-labelledby="report-new">
                  <div className="cell-stack">
                    <h2 id="report-new" className="section__title">
                      {applied ? "Что файл создавал" : "Что файл создаст"}
                    </h2>
                    <p className="section__note">
                      Проверьте написание: опечатка в марке станет новой маркой.
                    </p>
                  </div>
                  <div className="vehicles-new">
                    <NewList
                      title="Марки"
                      entries={report.newMakes.map((item) => ({ row: item.row, text: item.name }))}
                    />
                    <NewList
                      title="Модели"
                      entries={report.newModels.map((item) => ({
                        row: item.row,
                        text: `${item.make} ${item.name}`,
                      }))}
                    />
                    <NewList
                      title="Поколения"
                      entries={report.newGenerations.map((item) => ({
                        row: item.row,
                        text: `${item.make} ${item.model} ${item.name} (${item.yearFrom}–${item.yearTo ?? "н.в."})`,
                      }))}
                    />
                    <NewList
                      title="Двигатели"
                      entries={report.newEngines.map((item) => ({
                        row: item.row,
                        text: item.code,
                      }))}
                    />
                  </div>
                </section>
              )}

            {report && report.rejectedRows.length > 0 && !applied && (
              <section className="section" aria-labelledby="report-rejected">
                <h2 id="report-rejected" className="section__title">
                  Строки с ошибками
                </h2>
                <Table label="Строки с ошибками" columns={REJECTED_COLUMNS}>
                  {report.rejectedRows.map((row) => (
                    <tr key={row.row}>
                      <td className="num">{row.row}</td>
                      <td>
                        <ul className="reason-list ac-text-body-s">
                          {row.reasons.map((reason, index) => (
                            <li key={index}>{reasonText(reason)}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </Table>
                {report.rejected > report.rejectedRows.length && (
                  <p className="section__note">
                    Показаны первые {report.rejectedRows.length}; все — в таблице строк ниже с
                    отбором «Ошибка».
                  </p>
                )}
              </section>
            )}

            {current.status !== "parsing" && (
              <section className="section" aria-labelledby="report-rows">
                <h2 id="report-rows" className="section__title">
                  Все строки
                </h2>
                <StatusChips<VehicleImportPlan>
                  label="Отбор по плану"
                  value={plan}
                  allCount={report ? current.rowCount : undefined}
                  chips={(Object.keys(PLAN_TEXT) as VehicleImportPlan[]).map((key) => ({
                    value: key,
                    label: PLAN_TEXT[key],
                    count: report ? report[key] : undefined,
                  }))}
                  onChange={setPlan}
                />
                <RowsTable list={rows} mode={applied ? "applied" : "report"} options={optionList} />
              </section>
            )}
          </div>
        )}
      </LoadingContent>

      <Dialog
        open={confirming === "apply"}
        onClose={() => setConfirming(null)}
        title="Применить импорт?"
        actions={
          <>
            <Button onClick={() => act("apply")} loading={busy}>
              Применить
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Отмена
            </Button>
          </>
        }
      >
        {report && (
          <div className="dialog-stack">
            <p>
              Добавится {report.create}, обновится {report.update}. Строки без изменений (
              {report.unchanged}) и с ошибками ({report.rejected}) ничего не меняют.
            </p>
            <p>
              Применить можно один раз. Каждая строка проверяется заново: если справочник изменили
              после отчёта, итог покажет, что решено иначе.
            </p>
          </div>
        )}
      </Dialog>
      <Dialog
        open={confirming === "cancel"}
        onClose={() => setConfirming(null)}
        title="Отменить импорт?"
        actions={
          <>
            <Button onClick={() => act("cancel")} loading={busy}>
              Отменить импорт
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Назад
            </Button>
          </>
        }
      >
        В справочнике ничего не изменится. Чтобы импортировать файл позже, его нужно будет загрузить
        заново.
      </Dialog>
    </>
  );
}

function NewList({ title, entries }: { title: string; entries: { row: number; text: string }[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="card vehicles-new__card">
      <h3 className="ac-text-body-strong">
        {title}: <span className="num">{entries.length}</span>
      </h3>
      <ul className="reason-list ac-text-body-s">
        {entries.map((entry, index) => (
          <li key={index}>
            {entry.text} <span className="ac-muted nowrap">· строка {entry.row}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RowsTable({
  list,
  mode,
  options,
}: {
  list: ReturnType<typeof usePaged<VehicleImportRow & { id: string }>>;
  mode: "report" | "applied" | "differs";
  options: Options;
}) {
  const columns = ROW_COLUMNS.map((column) =>
    column.key === "plan" ? { ...column, header: mode === "report" ? "План" : "Итог" } : column,
  );
  return (
    <>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <div className="list-block">
          <TableToolbar total={list.items.length === 0 ? null : list.total} />
          {list.items.length === 0 ? (
            <EmptyState compact icon="search" title="Строк нет" text="Выберите другой отбор" />
          ) : (
            <Table label="Строки файла" columns={columns}>
              {list.items.map((row) => {
                const reasons =
                  mode === "report"
                    ? row.reasons
                    : row.outcomeReasons.length > 0
                      ? row.outcomeReasons
                      : row.reasons;
                return (
                  <tr key={row.row}>
                    <td className="num">{row.row}</td>
                    <td>
                      <span className="row-title">
                        <span>{rowCar(row.values)}</span>
                        <span className="row-title__sub">
                          {rowSpecs(row.values, options) || "—"}
                        </span>
                      </span>
                    </td>
                    <td className="nowrap">{rowYears(row.values)}</td>
                    <td className="nowrap">{row.values.market || <Muted>—</Muted>}</td>
                    <td>
                      <div className="cell-stack">
                        <RowMark row={row} mode={mode} />
                        {mode === "differs" &&
                          row.planned === "create" &&
                          row.outcome === "unchanged" && (
                            <span className="row-title__sub">
                              Такая модификация уже появилась в справочнике
                            </span>
                          )}
                        {reasons.map((reason, index) => (
                          <span key={index} className="row-title__sub">
                            {reasonText(reason, row.values)}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          <MoreButton list={list} />
        </div>
      </LoadingContent>
    </>
  );
}

/** The plan of a row (the report) or its outcome (the result), «в отчёте: …» where they differ. */
function RowMark({ row, mode }: { row: VehicleImportRow; mode: "report" | "applied" | "differs" }) {
  if (mode === "report") {
    if (!row.planned) return <Muted>—</Muted>;
    const role = PLAN_ROLE[row.planned];
    return (
      <Badge tone={role.tone} icon={role.icon}>
        {PLAN_TEXT[row.planned]}
      </Badge>
    );
  }
  if (!row.outcome) return <Muted>—</Muted>;
  const role = OUTCOME_ROLE[row.outcome];
  return (
    <span className="badges">
      <Badge tone={role.tone} icon={role.icon}>
        {OUTCOME_TEXT[row.outcome]}
      </Badge>
      {mode === "differs" && row.planned && (
        <span className="row-title__sub nowrap">
          в отчёте: {PLAN_TEXT[row.planned].toLowerCase()}
        </span>
      )}
    </span>
  );
}

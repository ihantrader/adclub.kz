import { isApiError } from "@adclub/api-client";
import type { AdminVehicleImport, VehicleImportPlan, VehicleImportRow } from "@adclub/contracts";
import {
  Banner,
  Button,
  Chip,
  Dialog,
  EmptyState,
  LoadingContent,
  SkeletonList,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import { formatMoment } from "../format";
import { routePaths, vehicleImportPath } from "../router";
import { useLoad } from "../use-load";
import { Crumbs, LoadError, MoreButton, usePaged } from "./shared";
import {
  countText,
  IMPORT_STATUS_TEXT,
  OUTCOME_TEXT,
  personText,
  PLAN_TEXT,
  reasonText,
  rowNumbersText,
  ROWS,
  vehicleErrorView,
} from "./vehicle-words";

/** How often a working import is asked again: the page follows it by itself. */
const POLL_MS = 1500;

const working = (entry: AdminVehicleImport | undefined) =>
  entry?.status === "parsing" || entry?.status === "applying";

/** «Geely Coolray I (SX11)» and the rest of a row as read. */
function rowCar(values: Record<string, string>): string {
  return [values.make, values.model, values.generation].filter(Boolean).join(" ") || "—";
}

function rowSpecs(values: Record<string, string>): string {
  return [values.body, values.engine_code, values.transmission, values.drive]
    .filter(Boolean)
    .join(" · ");
}

function rowYears(values: Record<string, string>): string {
  if (!values.year_from) return "—";
  return `${values.year_from}–${values.year_to || "н.в."}`;
}

/**
 * A-CAR-02, one import (SCREENS 7.2; TASK-035.B): while the server checks
 * the rows — the waiting and how far it has got, the page asks again by
 * itself; then the report before anything changes — the four numbers, the
 * rejected rows with their row numbers and reasons, the makes, models,
 * generations and engines the file would create, every row by its plan;
 * «Применить» once, with the numbers; then the result and the rows that
 * went otherwise than the report said (the catalog was changed by hand
 * meanwhile).
 */
export function ImportReport({ importId }: { importId: string }) {
  const toast = useToast();
  const online = useOnline();
  const entry = useLoad<AdminVehicleImport>(
    async () => (await apiClient.getVehicleImport({ importId })).import,
    importId,
  );
  const current = entry.data;
  const [plan, setPlan] = useState<VehicleImportPlan | null>(null);
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

  const act = async (what: "apply" | "cancel") => {
    setBusy(true);
    setActionError(null);
    try {
      const answer =
        what === "apply"
          ? await apiClient.applyVehicleImport({ importId })
          : await apiClient.cancelVehicleImport({ importId });
      entry.replace(answer.import);
      setConfirming(null);
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
  return (
    <>
      <Crumbs
        steps={[
          { label: "Импорт", href: routePaths.vehicleImports },
          { label: current?.fileName ?? "Файл" },
        ]}
      />
      <LoadError error={entry.error} retry={entry.reload} />
      <LoadingContent
        ready={current !== undefined}
        indicator={entry.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        {current && (
          <>
            <div className="page__head">
              <div className="cell-stack">
                <h1 className="ac-text-title-l page__title">{current.fileName ?? "Импорт"}</h1>
                <span className="ac-text-body-s ac-muted">
                  {countText(current.rowCount, ROWS)} · загрузил {personText(current.uploadedBy)},{" "}
                  {formatMoment(current.createdAt)}
                </span>
              </div>
              <span className="status status--open" aria-live="polite">
                {IMPORT_STATUS_TEXT[current.status]}
              </span>
            </div>

            {same.data && (
              <Banner tone="warning">
                Этот файл уже загружали {formatMoment(same.data.createdAt)} ·{" "}
                <AppLink href={vehicleImportPath(same.data.id)}>Открыть прошлый импорт</AppLink>
              </Banner>
            )}
            {actionError && <Banner tone="warning">{actionError}</Banner>}

            {working(current) && (
              <section className="panel-box" aria-live="polite">
                <p className="ac-text-body-strong">
                  {current.status === "parsing"
                    ? "Проверяем строки файла…"
                    : "Применяем строки к справочнику…"}
                </p>
                {progress && progress.total > 0 && (
                  <>
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
                    <p className="ac-text-caption ac-muted">
                      {progress.done.toLocaleString("ru-RU")} из{" "}
                      {progress.total.toLocaleString("ru-RU")} — страница обновится сама
                    </p>
                  </>
                )}
                {current.status === "parsing" && (
                  <p className="ac-text-caption ac-muted">В справочнике пока ничего не меняется.</p>
                )}
              </section>
            )}

            {report && !applied && (
              <section className="panel-box" aria-labelledby="report-numbers">
                <h2 id="report-numbers" className="ac-text-heading">
                  Отчёт до применения
                </h2>
                <dl className="counts-line">
                  <div>
                    <dt className="ac-text-caption ac-muted">Добавится</dt>
                    <dd className="ac-text-title">{report.create}</dd>
                  </div>
                  <div>
                    <dt className="ac-text-caption ac-muted">Обновится</dt>
                    <dd className="ac-text-title">{report.update}</dd>
                  </div>
                  <div>
                    <dt className="ac-text-caption ac-muted">Без изменений</dt>
                    <dd className="ac-text-title">{report.unchanged}</dd>
                  </div>
                  <div>
                    <dt className="ac-text-caption ac-muted">Ошибок</dt>
                    <dd className={`ac-text-title${report.rejected > 0 ? " warning-text" : ""}`}>
                      {report.rejected}
                    </dd>
                  </div>
                </dl>
                {report.rejected > 0 && (
                  <p className="ac-text-body-s">
                    Строки с ошибками: {rowNumbersText(report.rejectedRows.map((row) => row.row))}
                    {report.rejected > report.rejectedRows.length ? " и другие" : ""}.
                    {ready ? " Они не применятся; остальные — да." : ""}
                  </p>
                )}
                {ready && (
                  <>
                    <Banner tone="neutral">
                      До «Применить» в справочнике ничего не меняется. «Обновится» меняет только
                      рынок модификации.
                    </Banner>
                    <div className="button-row">
                      <Button
                        disabled={!online || report.create + report.update === 0}
                        onClick={() => setConfirming("apply")}
                      >
                        Применить
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={!online}
                        onClick={() => setConfirming("cancel")}
                      >
                        Отменить импорт
                      </Button>
                    </div>
                    {report.create + report.update === 0 && (
                      <p className="ac-text-caption ac-muted">
                        Применять нечего: все строки уже есть в справочнике или с ошибками.
                      </p>
                    )}
                  </>
                )}
              </section>
            )}

            {applied && current.result && (
              <section className="panel-box" aria-labelledby="result-numbers">
                <h2 id="result-numbers" className="ac-text-heading">
                  Итог
                </h2>
                <p className="ac-text-body-s ac-muted">
                  Применил {personText(current.appliedBy)}, {formatMoment(current.appliedAt)}.
                  Изменения видны в приложении не позже чем через минуту.
                </p>
                <dl className="counts-line">
                  {(["created", "updated", "unchanged", "rejected"] as const).map((key) => (
                    <div key={key}>
                      <dt className="ac-text-caption ac-muted">{OUTCOME_TEXT[key]}</dt>
                      <dd className="ac-text-title">{current.result![key]}</dd>
                    </div>
                  ))}
                  <div>
                    <dt className="ac-text-caption ac-muted">Решено иначе, чем в отчёте</dt>
                    <dd
                      className={`ac-text-title${current.result.differsFromReport > 0 ? " warning-text" : ""}`}
                    >
                      {current.result.differsFromReport}
                    </dd>
                  </div>
                </dl>
              </section>
            )}

            {applied && current.result && current.result.differsFromReport > 0 && (
              <section className="dialog-stack" aria-labelledby="differs">
                <h2 id="differs" className="ac-text-heading">
                  Решено иначе, чем в отчёте
                </h2>
                <p className="ac-text-body-s ac-muted">
                  Справочник изменили вручную после отчёта, и при применении эти строки проверены
                  заново.
                </p>
                <RowsTable list={differing} mode="differs" />
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
                <section className="dialog-stack" aria-labelledby="report-new">
                  <h2 id="report-new" className="ac-text-heading">
                    {applied ? "Что файл создавал" : "Что файл создаст"}
                  </h2>
                  <p className="ac-text-body-s ac-muted">
                    Проверьте написание: опечатка в марке станет новой маркой.
                  </p>
                  <div className="import-columns">
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
              <section className="dialog-stack" aria-labelledby="report-rejected">
                <h2 id="report-rejected" className="ac-text-heading">
                  Строки с ошибками
                </h2>
                <div className="table-wrap">
                  <table className="admin-table vehicles-table">
                    <thead>
                      <tr>
                        <th scope="col" className="num">
                          Строка
                        </th>
                        <th scope="col">Что не так</th>
                      </tr>
                    </thead>
                    <tbody>
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
                    </tbody>
                  </table>
                </div>
                {report.rejected > report.rejectedRows.length && (
                  <p className="ac-text-caption ac-muted">
                    Показаны первые {report.rejectedRows.length}; все — в таблице строк ниже с
                    отбором «Ошибка».
                  </p>
                )}
              </section>
            )}

            {current.status !== "parsing" && (
              <section className="dialog-stack" aria-labelledby="report-rows">
                <h2 id="report-rows" className="ac-text-heading">
                  Все строки
                </h2>
                <div className="chips" role="group" aria-label="Отбор по плану">
                  <Chip selected={plan === null} onClick={() => setPlan(null)}>
                    Все
                  </Chip>
                  {(Object.keys(PLAN_TEXT) as VehicleImportPlan[]).map((key) => (
                    <Chip key={key} selected={plan === key} onClick={() => setPlan(key)}>
                      {PLAN_TEXT[key]}
                    </Chip>
                  ))}
                </div>
                <RowsTable list={rows} mode={applied ? "applied" : "report"} />
              </section>
            )}
          </>
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
    <div className="panel-box">
      <h3 className="ac-text-body-strong">
        {title}: {entries.length}
      </h3>
      <ul className="reason-list ac-text-body-s">
        {entries.map((entry, index) => (
          <li key={index}>
            {entry.text} <span className="ac-muted">· строка {entry.row}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RowsTable({
  list,
  mode,
}: {
  list: ReturnType<typeof usePaged<VehicleImportRow & { id: string }>>;
  mode: "report" | "applied" | "differs";
}) {
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
        <p className="ac-text-body-s ac-muted">Всего: {list.total.toLocaleString("ru-RU")}</p>
        {list.items.length === 0 ? (
          <EmptyState icon="search" title="Строк нет" text="Выберите другой отбор" />
        ) : (
          <div className="table-wrap">
            <table className="admin-table vehicles-table">
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Строка
                  </th>
                  <th scope="col">Автомобиль</th>
                  <th scope="col">Кузов · двигатель · КПП · привод</th>
                  <th scope="col">Годы</th>
                  <th scope="col">Рынок</th>
                  <th scope="col">{mode === "report" ? "План" : "Итог"}</th>
                </tr>
              </thead>
              <tbody>
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
                      <td className="ac-text-body-s">{rowCar(row.values)}</td>
                      <td className="ac-text-body-s">{rowSpecs(row.values) || "—"}</td>
                      <td className="years ac-text-body-s">{rowYears(row.values)}</td>
                      <td className="ac-text-body-s">{row.values.market || "—"}</td>
                      <td>
                        <div className="cell-stack ac-text-body-s">
                          <span
                            className={
                              (mode === "report" ? row.planned : row.outcome) === "rejected"
                                ? "warning-text"
                                : undefined
                            }
                          >
                            {mode === "report"
                              ? row.planned
                                ? PLAN_TEXT[row.planned]
                                : "—"
                              : row.outcome
                                ? OUTCOME_TEXT[row.outcome]
                                : "—"}
                            {mode === "differs" && row.planned && (
                              <span className="ac-muted">
                                {" "}
                                (в отчёте: {PLAN_TEXT[row.planned].toLowerCase()})
                              </span>
                            )}
                          </span>
                          {mode === "differs" &&
                            row.planned === "create" &&
                            row.outcome === "unchanged" && (
                              <span className="ac-text-caption ac-muted">
                                Такая модификация уже появилась в справочнике
                              </span>
                            )}
                          {reasons.map((reason, index) => (
                            <span key={index} className="ac-text-caption ac-muted">
                              {reasonText(reason, row.values)}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </>
  );
}

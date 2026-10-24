import type {
  PriceColumnRoleName,
  PriceImportColumn,
  PriceImportDetailResponse,
  PriceImportRow,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Checkbox,
  Icon,
  LoadingContent,
  ScreenError,
  SkeletonList,
  useLoadingGate,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../api";
import { useLanguage } from "../i18n";
import { useVisiblePoll } from "../orders/live";
import { PriceResult } from "./PriceResult";
import { PriceReview } from "./PriceReview";
import { formatWhen } from "../orders/order-rules";
import { goBack, navigate, navigateTo, priceImportPath, useRouteId } from "../router";
import { PageHeader } from "../screens/PageHeader";
import {
  assignRole,
  cellText,
  confirmErrorText,
  failureText,
  formatNumber,
  isRunning,
  missingRoleKeys,
  progressText,
  ROLE_ORDER,
  ROLE_TEXT,
  rowErrorText,
  rowsText,
} from "./price-rules";

const RUNNING_POLL_MS = 1500;
const ERRORS_PAGE = 50;

/**
 * One upload (TASK-046): while the file is read — «Обрабатываем файл.
 * Страницу можно закрыть — результат появится здесь» with the rows read so
 * far; then S-PRICE-02 «Колонки» to confirm the roles (skipped for the
 * company's remembered format); then the rows read by them — «Разобрано: N
 * строк, ошибки в строках — M» with the errors by row. Matching with the
 * catalog is the next step (TASK-047, TASK-048).
 */
export function PriceImportScreen({ timeZone }: { timeZone: string }) {
  const { t, lang } = useLanguage();
  const importId = useRouteId();
  const gate = useLoadingGate();
  const [detail, setDetail] = useState<PriceImportDetailResponse | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const { begin, settle } = gate;

  const load = useCallback(async () => {
    if (!importId) return;
    const ticket = begin();
    try {
      const next = await apiClient.getPriceImport({ importId });
      settle(ticket, () => {
        setDetail(next);
        setFailure(null);
      });
    } catch (error) {
      settle(ticket, () => setFailure(error));
    }
  }, [importId, begin, settle]);

  useEffect(() => {
    setDetail(null);
    setEditing(false);
    void load();
  }, [load]);

  const status = detail?.import.status;
  useVisiblePoll(() => void load(), RUNNING_POLL_MS, status !== undefined && isRunning(status));
  const reload = useCallback(() => void load(), [load]);

  // The file's name is the title of the top bar (C3); when and who — the first line of the page.
  const head = (
    <>
      <PageHeader
        title={detail?.import.fileName ?? t("price.title")}
        back={() => goBack("price")}
      />
      {detail && (
        <p className="ac-text-body-s ac-muted price-wrap">
          {[
            detail.import.fileName,
            formatWhen(detail.import.createdAt, timeZone, lang, t),
            detail.import.uploadedBy.name,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </>
  );

  if (failure !== null && !detail) {
    return (
      <>
        {head}
        <ScreenError
          title={t("common.errorTitle")}
          text={t("common.errorText")}
          retry={{ label: t("common.retry"), onRetry: () => load() }}
        />
      </>
    );
  }

  return (
    <>
      {head}
      <LoadingContent
        className={
          detail?.import.status === "review" || detail?.import.status === "applied"
            ? "price-screen price-screen--wide"
            : "price-screen"
        }
        ready={detail !== null}
        indicator={gate.indicator}
        skeleton={<SkeletonList rows={4} label={t("common.loading")} />}
        label={t("common.loading")}
      >
        {detail && (
          <Body
            detail={detail}
            editing={editing}
            setEditing={setEditing}
            onChanged={setDetail}
            timeZone={timeZone}
            reload={reload}
          />
        )}
      </LoadingContent>
    </>
  );
}

function Body({
  detail,
  editing,
  setEditing,
  onChanged,
  timeZone,
  reload,
}: {
  detail: PriceImportDetailResponse;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  onChanged: (detail: PriceImportDetailResponse) => void;
  timeZone: string;
  reload: () => void;
}) {
  const { t, lang } = useLanguage();
  const entry = detail.import;
  const same = entry.sameFileAsImportId && (
    <Banner
      tone="neutral"
      icon="info"
      action={
        <Button
          variant="text"
          size="s"
          onClick={() => navigateTo(priceImportPath(entry.sameFileAsImportId!))}
        >
          {t("price.sameFileOpen")}
        </Button>
      }
    >
      {t("price.sameFile")}
    </Banner>
  );

  if (
    entry.status === "parsing" ||
    entry.status === "reading" ||
    entry.status === "matching" ||
    entry.status === "applying"
  ) {
    return (
      <>
        {same}
        <div className="card price-running" role="status">
          <Icon name="clock" size={24} />
          <div className="stack-s">
            <p className="ac-text-body-strong">
              {t(entry.status === "applying" ? "review.applying" : "price.processing")}
            </p>
            {entry.status !== "applying" &&
              progressText(entry, t, lang) !== t("price.processing") && (
                <p className="ac-text-body-s ac-muted">{progressText(entry, t, lang)}</p>
              )}
          </div>
        </div>
      </>
    );
  }

  if (entry.status === "failed" || entry.status === "expired") {
    return (
      <>
        <Banner tone="danger" icon="alertTriangle">
          {entry.status === "expired"
            ? t("price.expired.short")
            : entry.failure
              ? failureText(entry.failure, t)
              : t("price.error.notATable")}
        </Banner>
        <div>
          <Button icon="fileSpreadsheet" onClick={() => navigate("price")}>
            {t("price.uploadAnother")}
          </Button>
        </div>
      </>
    );
  }

  if (entry.status === "columns" || editing) {
    return (
      <>
        {same}
        <ColumnsEditor
          detail={detail}
          onCancel={editing ? () => setEditing(false) : null}
          onConfirmed={(next) => {
            setEditing(false);
            onChanged({ ...detail, import: next });
          }}
        />
      </>
    );
  }

  const stats = entry.stats;
  const columnsLine = (
    <p className="ac-text-body-s ac-muted">
      {t(
        entry.columnsSource === "remembered"
          ? "price.parsed.columnsRemembered"
          : "price.parsed.columnsConfirmed",
      )}{" "}
      {entry.status === "review" && (
        <Button variant="text" size="s" onClick={() => setEditing(true)}>
          {t("price.parsed.changeColumns")}
        </Button>
      )}
    </p>
  );

  if (entry.status === "review") {
    return (
      <>
        {same}
        {columnsLine}
        <PriceReview entry={entry} timeZone={timeZone} onLeft={reload} />
      </>
    );
  }

  if (entry.status === "applied") {
    return (
      <>
        <PriceResult entry={entry} />
        {((stats?.errorRows ?? 0) > 0 || (entry.match?.errors ?? 0) > 0) && (
          <RowErrors importId={entry.id} />
        )}
      </>
    );
  }

  return (
    <>
      {same}
      <div className="card price-summary">
        <p className="ac-text-heading">
          {t("price.parsed.summary", {
            rows: rowsText(lang, stats?.dataRows ?? 0, t),
            errors: formatNumber(stats?.errorRows ?? 0),
          })}
        </p>
        <p className="ac-text-body-s ac-muted">
          {t(
            entry.columnsSource === "remembered"
              ? "price.parsed.columnsRemembered"
              : "price.parsed.columnsConfirmed",
          )}{" "}
          <Button variant="text" size="s" onClick={() => setEditing(true)}>
            {t("price.parsed.changeColumns")}
          </Button>
        </p>
        {stats && stats.serviceRows > 0 && (
          <p className="ac-text-body-s ac-muted">
            {t("price.parsed.serviceRows", { n: formatNumber(stats.serviceRows) })}
          </p>
        )}
        <p className="ac-text-body-s price-summary__next">
          <Icon name="info" size={16} />
          <span>{t("price.parsed.next")}</span>
        </p>
      </div>
      {((stats?.errorRows ?? 0) > 0 || (entry.match?.errors ?? 0) > 0) && (
        <RowErrors importId={entry.id} />
      )}
    </>
  );
}

/** The role a column has now, and what it was recognised as (for «определено автоматически»). */
function initialRoles(columns: readonly PriceImportColumn[]): PriceColumnRoleName[] {
  return columns.map((column) => column.role);
}

/**
 * S-PRICE-02 «Колонки»: the first rows of goods as a table, a role above
 * each column, «определено автоматически» under the ones recognised (and
 * «из прошлой загрузки» under remembered ones), what is still missing in
 * words, «Запомнить для следующих загрузок» (on), «Продолжить».
 */
function ColumnsEditor({
  detail,
  onConfirmed,
  onCancel,
}: {
  detail: PriceImportDetailResponse;
  onConfirmed: (next: PriceImportDetailResponse["import"]) => void;
  onCancel: (() => void) | null;
}) {
  const { t } = useLanguage();
  const online = useOnline();
  const columns = detail.columns ?? [];
  const [roles, setRoles] = useState<PriceColumnRoleName[]>(() => initialRoles(columns));
  const [remember, setRemember] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = missingRoleKeys(roles);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const answer = await apiClient.confirmPriceImportColumns(
        { importId: detail.import.id },
        { roles, remember, expectedVersion: detail.import.version },
      );
      onConfirmed(answer.import);
    } catch (failure) {
      setError(confirmErrorText(failure, t));
    } finally {
      setSaving(false);
    }
  }

  const note = (column: PriceImportColumn) => {
    if (roles[column.index] !== column.role || column.role === "ignore") return null;
    if (column.source === "header" || column.source === "content") return t("price.columns.auto");
    if (column.source === "remembered") return t("price.columns.remembered");
    return null;
  };

  return (
    <div className="price-columns">
      <div className="stack-s">
        <h2 className="ac-text-heading">{t("price.columns.title")}</h2>
        <p className="ac-text-body-s ac-muted">{t("price.columns.lead")}</p>
      </div>
      <div className="table-wrap">
        <table className="price-table">
          <caption className="ac-visually-hidden">{t("price.columns.title")}</caption>
          <thead>
            <tr>
              <th scope="col" className="price-table__no">
                <span className="ac-visually-hidden">{t("price.columns.rowNo")}</span>
              </th>
              {columns.map((column) => (
                <th key={column.index} scope="col" className="price-table__role">
                  <label className="inline-field inline-field--select">
                    <span className="ac-visually-hidden">
                      {t("price.columns.roleOf", {
                        column: column.header ?? t("price.columns.column", { n: column.index + 1 }),
                      })}
                    </span>
                    <select
                      className="inline-field__select"
                      value={roles[column.index]}
                      disabled={saving}
                      onChange={(event) =>
                        setRoles((current) =>
                          assignRole(
                            current,
                            column.index,
                            event.target.value as PriceColumnRoleName,
                          ),
                        )
                      }
                    >
                      {ROLE_ORDER.map((role) => (
                        <option key={role} value={role}>
                          {t(ROLE_TEXT[role])}
                        </option>
                      ))}
                    </select>
                    <Icon name="chevronDown" size={16} />
                  </label>
                  {note(column) && (
                    <span className="price-table__auto ac-text-caption">
                      <Icon name="sparkles" size={16} />
                      {note(column)}
                    </span>
                  )}
                </th>
              ))}
            </tr>
            {detail.header && (
              <tr className="price-table__header">
                <th scope="row" className="price-table__no">
                  {detail.header.rowNo}
                </th>
                {columns.map((column) => (
                  <th key={column.index} scope="col">
                    {column.header ?? ""}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {detail.preview.map((row) => (
              <tr key={row.rowNo}>
                <th scope="row" className="price-table__no">
                  {row.rowNo}
                </th>
                {row.cells.map((cell, index) => (
                  <td
                    key={index}
                    className={roles[index] === "ignore" ? "price-table__cell--off" : undefined}
                  >
                    {cellText(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {missing.length > 0 && (
        <Banner tone="warning" icon="alertTriangle">
          {missing.map((key) => t(key)).join(". ")}
        </Banner>
      )}
      {error && (
        <Banner tone="danger" icon="alertTriangle">
          {error}
        </Banner>
      )}
      <Checkbox
        label={t("price.columns.remember")}
        checked={remember}
        onChange={setRemember}
        disabled={saving}
      />
      <div className="actions-row">
        <Button
          onClick={() => save()}
          loading={saving}
          disabled={missing.length > 0 || !online || saving}
        >
          {t("price.columns.continue")}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            {t("common.cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** «Ошибки в строках»: the row as the file numbers it and why, a page at a time. */
function RowErrors({ importId }: { importId: string }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<PriceImportRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  /** A page of rows with errors; the caller marks the loading (an effect only fetches). */
  const more = useCallback(
    async (from: string | null, reset: boolean) => {
      try {
        const page = await apiClient.listPriceImportRows(
          { importId },
          { query: { only: "errors", limit: ERRORS_PAGE, ...(from ? { cursor: from } : {}) } },
        );
        setRows((current) => (reset ? page.rows : [...current, ...page.rows]));
        setTotal(page.total);
        setCursor(page.nextCursor);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [importId],
  );

  // The first page; later ones come from the buttons.
  useEffect(() => {
    let live = true;
    apiClient
      .listPriceImportRows({ importId }, { query: { only: "errors", limit: ERRORS_PAGE } })
      .then(
        (page) => {
          if (!live) return;
          setRows(page.rows);
          setTotal(page.total);
          setCursor(page.nextCursor);
          setLoading(false);
        },
        () => {
          if (!live) return;
          setFailed(true);
          setLoading(false);
        },
      );
    return () => {
      live = false;
    };
  }, [importId]);

  return (
    <section className="stack-s" aria-label={t("price.parsed.errorsTitle")}>
      <h2 className="ac-text-heading">
        {total === null
          ? t("price.parsed.errorsTitle")
          : `${t("price.parsed.errorsTitle")} · ${formatNumber(total)}`}
      </h2>
      <ul className="price-errors">
        {rows.map((row) => (
          <li key={row.rowNo} className="price-errors__row">
            <span className="price-errors__no ac-text-body-strong">
              {t("price.parsed.row", { n: row.rowNo })}
            </span>
            <span className="stack-s">
              <span>{row.errors.map((error) => rowErrorText(error, t)).join("; ")}</span>
              <span className="ac-text-body-s ac-muted price-wrap">
                {row.cells
                  .filter((cell) => cell !== null)
                  .map(cellText)
                  .join(" · ")}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {failed && (
        <Banner
          tone="danger"
          action={
            <Button
              variant="text"
              size="s"
              onClick={() => {
                setLoading(true);
                setFailed(false);
                void more(cursor, rows.length === 0);
              }}
            >
              {t("common.retry")}
            </Button>
          }
        >
          {t("common.errorText")}
        </Banner>
      )}
      {cursor && !failed && (
        <div className="load-more">
          <Button
            variant="secondary"
            loading={loading}
            onClick={() => {
              setLoading(true);
              void more(cursor, false);
            }}
          >
            {t("price.showMore")}
          </Button>
        </div>
      )}
    </section>
  );
}

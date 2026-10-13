import type { PriceImport, PriceImportPage } from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Icon,
  LoadingContent,
  ScreenError,
  SkeletonList,
  useLoadingGate,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { apiClient } from "../api";
import { useLanguage } from "../i18n";
import { useVisiblePoll } from "../orders/live";
import { formatWhen } from "../orders/order-rules";
import { navigateTo, priceImportPath } from "../router";
import {
  isRunning,
  progressText,
  sizeText,
  STATUS_TEXT,
  statusTone,
  uploadErrorText,
} from "./price-rules";
import { PriceExport } from "./PriceExport";
import { uploadPriceFile } from "./upload";

/** How often the history is asked again while a file is being read. */
const RUNNING_POLL_MS = 2000;
const PAGE = 20;

/** What the file picker offers; whatever is chosen, the server decides by the content. */
const ACCEPT =
  ".xlsx,.xls,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain";

interface Uploading {
  name: string;
  size: number;
  fraction: number;
}

const STATUS_ICON = {
  parsing: "clock",
  columns: "checklist",
  reading: "clock",
  parsed: "clock",
  matching: "clock",
  review: "checklist",
  applying: "clock",
  applied: "circleCheck",
  failed: "circleX",
  expired: "circleX",
} as const;

/**
 * S-PRICE-01 «Загрузка» (TASK-046): the zone «Загрузите прайс как есть:
 * Excel или CSV» — a file dropped on it (a computer) or chosen (a phone
 * too), sent with the progress of the upload; then the upload opens its
 * own page, where the reading goes on. Below — the history of uploads with
 * their state, asked again every two seconds while one of them is read.
 * «Скачать мой прайс» — the company's own offers as a file to edit and
 * upload back (TASK-048).
 */
export function PriceImports({ timeZone }: { timeZone: string }) {
  const { t, lang } = useLanguage();
  const online = useOnline();
  const gate = useLoadingGate();
  const [page, setPage] = useState<PriceImportPage | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [uploading, setUploading] = useState<Uploading | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { begin, settle } = gate;

  const load = useCallback(async () => {
    const ticket = begin();
    try {
      const next = await apiClient.listPriceImports({ query: { limit: PAGE } });
      settle(ticket, () => {
        // Pages loaded below the first stay: the first page is replaced in place.
        setPage((current) => {
          if (!current || current.imports.length <= PAGE) return next;
          const fresh = new Set(next.imports.map((entry) => entry.id));
          const older = current.imports.slice(PAGE).filter((entry) => !fresh.has(entry.id));
          return { ...next, imports: [...next.imports, ...older], nextCursor: current.nextCursor };
        });
        setFailure(null);
      });
    } catch (error) {
      settle(ticket, () => setFailure(error));
    }
  }, [begin, settle]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = page?.imports.some((entry) => isRunning(entry.status)) ?? false;
  useVisiblePoll(() => void load(), RUNNING_POLL_MS, running);

  const maxFileMb = page?.limits.maxFileMb ?? 20;

  async function upload(file: File) {
    setUploadError(null);
    if (file.size > maxFileMb * 1024 * 1024) {
      setUploadError(t("price.error.tooLarge", { mb: maxFileMb }));
      return;
    }
    setUploading({ name: file.name, size: file.size, fraction: 0 });
    try {
      const created = await uploadPriceFile(file, lang, (fraction) =>
        setUploading((current) => (current ? { ...current, fraction } : current)),
      );
      navigateTo(priceImportPath(created.id));
    } catch (error) {
      setUploadError(uploadErrorText(error, t, maxFileMb));
    } finally {
      setUploading(null);
    }
  }

  function chosen(files: FileList | null) {
    const file = files?.[0];
    if (file) void upload(file);
    if (input.current) input.current.value = "";
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (!uploading && online) chosen(event.dataTransfer.files);
  }

  async function loadMore() {
    if (!page?.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await apiClient.listPriceImports({
        query: { limit: PAGE, cursor: page.nextCursor },
      });
      setPage((current) =>
        current
          ? {
              ...current,
              imports: [
                ...current.imports,
                ...next.imports.filter((entry) => !current.imports.some((c) => c.id === entry.id)),
              ],
              nextCursor: next.nextCursor,
            }
          : current,
      );
    } catch {
      // The list on screen stays; «Показать ещё» tries again.
    } finally {
      setLoadingMore(false);
    }
  }

  const disabled = uploading !== null || !online;
  const limits = page?.limits;

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title page__title">{t("price.title")}</h1>
      </div>

      <section
        className={dragging ? "price-drop price-drop--over" : "price-drop"}
        aria-label={t("price.dropTitle")}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <Icon name="fileSpreadsheet" size={28} />
        <p className="ac-text-title-s">{t("price.dropTitle")}</p>
        {uploading ? (
          <div className="price-drop__progress" role="status">
            <span className="ac-text-body-s price-wrap">
              {t("price.uploading", { name: uploading.name, size: sizeText(uploading.size, t) })}
            </span>
            <div
              className="progress"
              role="progressbar"
              aria-label={t("price.uploadingLabel")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(uploading.fraction * 100)}
            >
              <span style={{ width: `${String(Math.round(uploading.fraction * 100))}%` }} />
            </div>
          </div>
        ) : (
          <>
            <p className="ac-text-body-s ac-muted">
              {limits
                ? t("price.dropHint", {
                    mb: limits.maxFileMb,
                    rows: limits.maxRows.toLocaleString("ru-RU").replace(/\s/g, "\u202f"),
                  })
                : t("price.dropHintShort")}
            </p>
            <Button icon="plus" disabled={disabled} onClick={() => input.current?.click()}>
              {t("price.choose")}
            </Button>
          </>
        )}
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="ac-visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="price-file"
          onChange={(event) => chosen(event.target.files)}
        />
      </section>

      {uploadError && (
        <Banner tone="danger" icon="alertTriangle">
          {uploadError}
        </Banner>
      )}

      <PriceExport />

      <h2 className="ac-text-title-s">{t("price.history")}</h2>
      {failure !== null && !page ? (
        <ScreenError
          title={t("common.errorTitle")}
          text={t("common.errorText")}
          retry={{ label: t("common.retry"), onRetry: () => load() }}
        />
      ) : (
        <LoadingContent
          ready={page !== null}
          indicator={gate.indicator}
          skeleton={<SkeletonList rows={3} label={t("common.loading")} />}
          label={t("common.loading")}
        >
          {page && page.imports.length === 0 && (
            <EmptyState icon="fileSpreadsheet" title={t("price.historyEmpty")} />
          )}
          {page && page.imports.length > 0 && (
            <ul className="price-history">
              {page.imports.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} timeZone={timeZone} />
              ))}
            </ul>
          )}
          {page?.nextCursor && (
            <div className="load-more">
              <Button variant="secondary" loading={loadingMore} onClick={() => loadMore()}>
                {t("price.showMore")}
              </Button>
            </div>
          )}
        </LoadingContent>
      )}
    </>
  );
}

function HistoryRow({ entry, timeZone }: { entry: PriceImport; timeZone: string }) {
  const { t, lang } = useLanguage();
  const href = priceImportPath(entry.id);
  const progress = progressText(entry, t, lang);
  return (
    <li>
      <a
        className="price-history__row"
        href={href}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          navigateTo(href);
        }}
      >
        <span className="price-history__main">
          <span className="ac-text-body-strong price-wrap">
            {entry.fileName ?? t("price.noFileName")}
          </span>
          <span className="ac-text-body-s ac-muted">
            {[
              formatWhen(entry.createdAt, timeZone, lang, t),
              entry.uploadedBy.name,
              sizeText(entry.byteSize, t),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {progress && <span className="ac-text-body-s">{progress}</span>}
        </span>
        <Badge tone={statusTone(entry.status)} icon={STATUS_ICON[entry.status]}>
          {t(STATUS_TEXT[entry.status])}
        </Badge>
      </a>
    </li>
  );
}

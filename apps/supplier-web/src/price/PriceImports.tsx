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
import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { apiClient } from "../api";
import { useLanguage } from "../i18n";
import { useVisiblePoll } from "../orders/live";
import { formatWhen } from "../orders/order-rules";
import { useWide } from "../offers/use-wide";
import { navigateTo, priceImportPath } from "../router";
import { PageHeader } from "../screens/PageHeader";
import {
  importTitle,
  isRunning,
  progressText,
  sizeText,
  STATUS_TEXT,
  statusTone,
  uploadErrorText,
} from "./price-rules";
import { PriceExport } from "./PriceExport";
import { shrinkPhoto } from "./photo-shrink";
import { uploadPriceFile, uploadPricePhotos } from "./upload";

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
  needs_retake: "camera",
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
  const wide = useWide();
  const gate = useLoadingGate();
  const [page, setPage] = useState<PriceImportPage | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [uploading, setUploading] = useState<Uploading | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState<DraftPage[] | null>(null);
  // The pages and «preparing» as they are now, for a second drop before a render (TASK-064).
  const draftRef = useRef<DraftPage[]>([]);
  draftRef.current = draft ?? [];
  const preparingRef = useRef(false);
  // The previews of a draft left behind (another page of the cabinet) are freed.
  useEffect(
    () => () => {
      for (const entry of draftRef.current) URL.revokeObjectURL(entry.url);
    },
    [],
  );
  const [preparing, setPreparing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
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
    if (uploading || !online || preparing) return;
    const files = [...event.dataTransfer.files];
    // Pictures dropped are pages of a photographed price list (TASK-064).
    if (files.length > 0 && files.every((file) => file.type.startsWith("image/"))) {
      void addPhotos(files);
      return;
    }
    chosen(event.dataTransfer.files);
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

  const disabled = uploading !== null || !online || preparing;
  const limits = page?.limits;
  const maxPages = limits?.photoMaxPages ?? 10;

  /** Photos chosen or taken: shrunk, added to the pages after those already there. */
  async function addPhotos(files: FileList | readonly File[] | null) {
    if (preparingRef.current) return;
    const chosenFiles = files ? [...files] : [];
    if (chosenFiles.length === 0) return;
    setUploadError(null);
    const room = maxPages - draftRef.current.length;
    if (chosenFiles.length > room) setUploadError(t("price.photo.tooMany", { pages: maxPages }));
    setPreparing(true);
    preparingRef.current = true;
    try {
      const pages = await Promise.all(
        chosenFiles.slice(0, Math.max(0, room)).map(async (file) => {
          const blob = await shrinkPhoto(file);
          return {
            id: `${String(Date.now())}-${Math.random()}`,
            blob,
            url: URL.createObjectURL(blob),
          };
        }),
      );
      setDraft((current) => [...(current ?? []), ...pages]);
    } finally {
      setPreparing(false);
      preparingRef.current = false;
    }
  }

  function removePage(id: string) {
    setDraft((current) => {
      const left = (current ?? []).filter((entry) => {
        if (entry.id === id) URL.revokeObjectURL(entry.url);
        return entry.id !== id;
      });
      return left.length > 0 ? left : null;
    });
  }

  function dropDraft() {
    for (const entry of draft ?? []) URL.revokeObjectURL(entry.url);
    setDraft(null);
  }

  async function uploadPhotos() {
    if (!draft || draft.length === 0) return;
    setUploadError(null);
    const size = draft.reduce((sum, entry) => sum + entry.blob.size, 0);
    setUploading({ name: t("price.photo.title", { n: String(draft.length) }), size, fraction: 0 });
    try {
      const created = await uploadPricePhotos(
        draft.map((entry) => entry.blob),
        lang,
        (fraction) => setUploading((current) => (current ? { ...current, fraction } : current)),
      );
      dropDraft();
      navigateTo(priceImportPath(created.id));
    } catch (error) {
      setUploadError(uploadErrorText(error, t, maxFileMb));
    } finally {
      setUploading(null);
    }
  }

  return (
    <>
      <PageHeader title={t("price.title")} />

      {/* The upload and «Скачать мой прайс» side by side from 1024 (TASK-079). */}
      <div className="price-top">
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
          <Icon name="table" size={24} />
          <p className="ac-text-heading">{t("price.dropTitle")}</p>
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
          ) : draft ? (
            <PhotoDraft
              pages={draft}
              maxPages={maxPages}
              disabled={disabled}
              preparing={preparing}
              onRemove={removePage}
              onAdd={() => gallery.current?.click()}
              onCamera={() => camera.current?.click()}
              onUpload={() => void uploadPhotos()}
              onCancel={dropDraft}
            />
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
              <div className="actions-row price-drop__actions">
                <Button icon="plus" disabled={disabled} onClick={() => input.current?.click()}>
                  {t("price.choose")}
                </Button>
                <Button
                  variant="secondary"
                  icon="camera"
                  disabled={disabled}
                  loading={preparing}
                  onClick={() => camera.current?.click()}
                >
                  {t("price.takePhoto")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => gallery.current?.click()}
                >
                  {t("price.choosePhotos")}
                </Button>
              </div>
            </>
          )}
          {/* The camera of a phone (`capture`), and several pictures from the gallery (TASK-064). */}
          <input
            ref={camera}
            type="file"
            accept="image/*"
            capture="environment"
            className="ac-visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="price-camera"
            onChange={(event) => {
              void addPhotos(event.target.files);
              event.target.value = "";
            }}
          />
          <input
            ref={gallery}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/*"
            multiple
            className="ac-visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="price-photos"
            onChange={(event) => {
              void addPhotos(event.target.files);
              event.target.value = "";
            }}
          />
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

        <PriceExport />
      </div>

      {uploadError && (
        <Banner tone="danger" icon="alertTriangle">
          {uploadError}
        </Banner>
      )}

      <h2 className="ac-text-heading section-title">{t("price.history")}</h2>
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
          {page && page.imports.length > 0 && wide && (
            <HistoryTable imports={page.imports} timeZone={timeZone} />
          )}
          {page && page.imports.length > 0 && !wide && (
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

/** Opens an upload in the cabinet; a modifier click — in a new tab. */
function openImport(event: MouseEvent, href: string) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigateTo(href);
}

/** The history from 1024 px (TASK-079): a table, a row of 48 for an upload. */
function HistoryTable({ imports, timeZone }: { imports: PriceImport[]; timeZone: string }) {
  const { t, lang } = useLanguage();
  return (
    <div className="table-wrap">
      <table className="data-table price-history-table">
        <caption className="ac-visually-hidden">{t("price.history")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("price.tableFile")}</th>
            <th scope="col">{t("price.tableWhen")}</th>
            <th scope="col">{t("price.tableWho")}</th>
            <th scope="col" className="num-col">
              {t("price.tableSize")}
            </th>
            <th scope="col">{t("price.tableResult")}</th>
            <th scope="col">{t("price.tableState")}</th>
          </tr>
        </thead>
        <tbody>
          {imports.map((entry) => {
            const href = priceImportPath(entry.id);
            return (
              <tr
                key={entry.id}
                className="data-table__row--link"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("a")) return;
                  navigateTo(href);
                }}
              >
                <td className="price-history-table__file">
                  <a
                    className="offer-title"
                    href={href}
                    onClick={(event) => openImport(event, href)}
                  >
                    {importTitle(entry, t) ?? t("price.noFileName")}
                  </a>
                </td>
                <td className="num">{formatWhen(entry.createdAt, timeZone, lang, t)}</td>
                <td>{entry.uploadedBy.name}</td>
                <td className="num-col">{sizeText(entry.byteSize, t)}</td>
                <td className="ac-text-caption">{progressText(entry, t, lang)}</td>
                <td>
                  <Badge tone={statusTone(entry.status)} icon={STATUS_ICON[entry.status]}>
                    {t(STATUS_TEXT[entry.status])}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
            {importTitle(entry, t) ?? t("price.noFileName")}
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

/** A page chosen before the upload: the picture made smaller and its preview. */
interface DraftPage {
  id: string;
  blob: Blob;
  url: string;
}

/**
 * The pages of a photographed price list before the upload (S-PRICE-01,
 * TASK-064): thumbnails in the order of the pages, «Убрать» under each,
 * «Добавить страницу», «Загрузить». The order is the order chosen.
 */
function PhotoDraft({
  pages,
  maxPages,
  disabled,
  preparing,
  onRemove,
  onAdd,
  onCamera,
  onUpload,
  onCancel,
}: {
  pages: DraftPage[];
  maxPages: number;
  disabled: boolean;
  preparing: boolean;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onCamera: () => void;
  onUpload: () => void;
  onCancel: () => void;
}) {
  const { t } = useLanguage();
  const full = pages.length >= maxPages;
  return (
    <div className="price-photos stack-s">
      <p className="ac-text-body-strong">{t("price.photo.draftTitle", { n: pages.length })}</p>
      <p className="ac-text-body-s ac-muted">{t("price.photo.hint", { pages: maxPages })}</p>
      <ol className="price-photos__pages">
        {pages.map((entry, index) => (
          <li key={entry.id} className="price-photos__page">
            <img src={entry.url} alt={t("price.photo.page", { n: index + 1 })} />
            <span className="ac-text-caption">{t("price.photo.page", { n: index + 1 })}</span>
            <Button variant="text" size="s" disabled={disabled} onClick={() => onRemove(entry.id)}>
              {t("price.photo.remove")}
            </Button>
          </li>
        ))}
      </ol>
      <div className="actions-row price-drop__actions">
        <Button icon="upload" disabled={disabled || pages.length === 0} onClick={onUpload}>
          {t("price.photo.upload")}
        </Button>
        <Button
          variant="secondary"
          icon="camera"
          disabled={disabled || full}
          loading={preparing}
          onClick={onCamera}
        >
          {t("price.takePhoto")}
        </Button>
        <Button variant="secondary" disabled={disabled || full} onClick={onAdd}>
          {t("price.photo.addMore")}
        </Button>
        <Button variant="text" disabled={disabled} onClick={onCancel}>
          {t("price.photo.cancel")}
        </Button>
      </div>
    </div>
  );
}

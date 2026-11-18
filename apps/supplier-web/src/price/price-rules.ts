import { isApiError } from "@adclub/api-client";
import {
  priceImportPhotoInvalidDetailsSchema,
  priceImportVersionConflictDetailsSchema,
  type PriceColumnRoleName,
  type PriceImport,
  type PriceImportFailure,
  type PriceImportStatus,
  type PricePhotoPageInfo,
  type PricePhotoPageStatus,
  type PricePhotoProblem,
  type PriceRowErrorValue,
} from "@adclub/contracts";
import { missingPriceRoles, numberText } from "@adclub/domain";
import { pluralForm, type Lang, type SupplierTextKey } from "@adclub/i18n";
import { retryMinutes } from "../errors";
import type { Translate } from "../i18n";

/**
 * What the screens of «Прайс» decide (TASK-046; SCREENS S-PRICE-01,
 * S-PRICE-02): the words of states and errors, the roles a column can be
 * given and what giving one does to the others. Everything the file holds
 * and what it means is the server's answer; nothing here reads a file.
 */

/** The roles in the order of S-PRICE-02: Артикул · Бренд · Название · Цена · Наличие · Срок · Не использовать. */
export const ROLE_ORDER: readonly PriceColumnRoleName[] = [
  "article",
  "brand",
  "name",
  "price",
  "availability",
  "lead_days",
  "item_id",
  "ignore",
];

export const ROLE_TEXT: Record<PriceColumnRoleName, SupplierTextKey> = {
  article: "price.role.article",
  brand: "price.role.brand",
  name: "price.role.name",
  price: "price.role.price",
  availability: "price.role.availability",
  lead_days: "price.role.leadDays",
  item_id: "price.role.itemId",
  ignore: "price.role.ignore",
};

/**
 * Gives column `index` a role. A role is one column's: the column that had
 * it before becomes «Не использовать» (of «Опт» and «Розница», choosing the
 * price for one takes it from the other).
 */
export function assignRole(
  roles: readonly PriceColumnRoleName[],
  index: number,
  role: PriceColumnRoleName,
): PriceColumnRoleName[] {
  return roles.map((current, at) => {
    if (at === index) return role;
    return role !== "ignore" && current === role ? "ignore" : current;
  });
}

/** What the supplier still has to choose before «Продолжить»; empty — nothing. */
export function missingRoleKeys(roles: readonly PriceColumnRoleName[]): SupplierTextKey[] {
  return missingPriceRoles(roles).map((missing) =>
    missing === "price" ? "price.columns.needPrice" : "price.columns.needArticleOrName",
  );
}

/**
 * The server is at work on the upload — reading the file, matching it with
 * the catalog (TASK-047), applying it: the page asks again until it ends.
 */
export function isRunning(status: PriceImportStatus): boolean {
  return (
    status === "parsing" ||
    status === "reading" ||
    status === "parsed" ||
    status === "matching" ||
    status === "applying"
  );
}

export const STATUS_TEXT: Record<PriceImportStatus, SupplierTextKey> = {
  parsing: "price.status.parsing",
  columns: "price.status.columns",
  reading: "price.status.reading",
  parsed: "price.status.parsed",
  matching: "price.status.matching",
  review: "price.status.review",
  applying: "price.status.applying",
  applied: "price.status.applied",
  failed: "price.status.failed",
  expired: "price.status.expired",
  needs_retake: "price.status.needsRetake",
};

export type StatusTone = "neutral" | "warning" | "success" | "danger";

export function statusTone(status: PriceImportStatus): StatusTone {
  switch (status) {
    case "columns":
    case "review":
    case "needs_retake":
      return "warning";
    case "parsed":
    case "applied":
      return "success";
    case "failed":
    case "expired":
      return "danger";
    default:
      return "neutral";
  }
}

type FailureReason = PriceImportFailure["reason"];

const FAILURE_TEXT: Record<FailureReason, SupplierTextKey> = {
  not_a_table: "price.error.notATable",
  old_excel: "price.error.oldExcel",
  encrypted: "price.error.encrypted",
  broken: "price.error.broken",
  empty: "price.error.empty",
  too_many_rows: "price.error.tooManyRows",
  encoding: "price.error.encoding",
  file_missing: "price.error.fileMissing",
  timeout: "price.error.timeout",
};

/** Why a file could not be read, in words — at the upload (400) or from the worker (`failure`). */
export function failureText(
  failure: Pick<PriceImportFailure, "reason" | "limit">,
  t: Translate,
): string {
  const key = FAILURE_TEXT[failure.reason] ?? "price.error.notATable";
  return t(key, { limit: failure.limit === null ? "" : numberText(failure.limit) });
}

function reasonOf(details: unknown): Pick<PriceImportFailure, "reason" | "limit"> | null {
  if (typeof details !== "object" || details === null || !("reason" in details)) return null;
  const { reason, limit } = details as { reason: unknown; limit?: unknown };
  if (typeof reason !== "string" || !(reason in FAILURE_TEXT)) return null;
  return { reason: reason as FailureReason, limit: typeof limit === "number" ? limit : null };
}

/** Who confirmed the columns first, from the details of `PRICE_IMPORT_VERSION_CONFLICT`. */
function confirmedByName(details: unknown): string | null {
  const parsed = priceImportVersionConflictDetailsSchema.safeParse(details);
  return parsed.success ? (parsed.data.confirmedBy?.name ?? null) : null;
}

/** The words of a refused upload (S-PRICE-01). `maxFileMb` — the limit the list told. */
export function uploadErrorText(error: unknown, t: Translate, maxFileMb: number): string {
  if (!isApiError(error)) return t("common.errorText");
  switch (error.code) {
    case "PRICE_IMPORT_FILE_INVALID": {
      const reason = reasonOf(error.details);
      return reason ? failureText(reason, t) : t("price.error.notATable");
    }
    case "PRICE_IMPORT_PHOTO_INVALID":
      return photoErrorText(error.details, t);
    case "PAYLOAD_TOO_LARGE":
      return t("price.error.tooLarge", { mb: maxFileMb });
    case "UNSUPPORTED_MEDIA_TYPE":
      return t("price.error.notATable");
    case "RATE_LIMITED":
      return t("price.error.tooManyUploads", { minutes: retryMinutes(error) });
    case "NETWORK_ERROR":
      return t("price.error.network");
    case "SERVICE_UNAVAILABLE":
      return t("price.error.storage");
    default:
      return t("common.errorText");
  }
}

const PHOTO_PROBLEM_TEXT: Record<PricePhotoProblem, SupplierTextKey> = {
  not_an_image: "price.error.photo.notAnImage",
  unsupported_format: "price.error.photo.unsupportedFormat",
  broken: "price.error.photo.broken",
  too_many_pixels: "price.error.photo.tooManyPixels",
  too_large: "price.error.photo.tooLarge",
  no_pages: "price.error.photo.noPages",
  too_many_pages: "price.error.photo.tooManyPages",
  malformed: "price.error.photo.malformed",
};

/**
 * A refused photo (TASK-064): «Стр. 2: это не фото» — by the page's number;
 * a problem of the whole upload as it is.
 */
export function photoErrorText(details: unknown, t: Translate): string {
  const parsed = priceImportPhotoInvalidDetailsSchema.safeParse(details);
  if (!parsed.success) return t("price.error.photo.malformed");
  const { page, reason, limit } = parsed.data;
  const text = t(PHOTO_PROBLEM_TEXT[reason] ?? "price.error.photo.malformed", {
    limit: limit === null ? "" : String(limit),
  });
  return page === null ? text : t("price.error.photoPage", { page: String(page), reason: text });
}

/** The name of an upload: the file's, or «Фото, 3 стр.» for photographed pages (TASK-064). */
export function importTitle(entry: PriceImport, t: Translate): string | null {
  if (entry.format === "photo") {
    return t("price.photo.title", { n: String(entry.photo?.pages.length ?? 0) });
  }
  return entry.fileName;
}

const PAGE_STATUS_TEXT: Record<PricePhotoPageStatus, SupplierTextKey> = {
  waiting: "price.photo.status.waiting",
  read: "price.photo.status.read",
  no_table: "price.photo.status.noTable",
  unreadable: "price.photo.status.unreadable",
  failed: "price.photo.status.failed",
};

/** What a photographed page gave, in words. */
export function pageStatusText(page: PricePhotoPageInfo, t: Translate, lang: Lang): string {
  return t(PAGE_STATUS_TEXT[page.status], {
    rows: page.rows === null ? "" : rowsText(lang, page.rows, t),
  });
}

/** A page to take again or leave out: it gave nothing. */
export function pageNeedsRetake(page: PricePhotoPageInfo): boolean {
  return page.status === "no_table" || page.status === "unreadable" || page.status === "failed";
}

/** The words of a confirmation of the columns that was refused. */
export function confirmErrorText(error: unknown, t: Translate): string {
  if (!isApiError(error)) return t("common.saveFailed");
  switch (error.code) {
    case "PRICE_IMPORT_STATE":
      return t("price.columns.notNow");
    case "PRICE_IMPORT_VERSION_CONFLICT": {
      const name = confirmedByName(error.details);
      return name ? t("price.columns.changedBy", { name }) : t("price.columns.changed");
    }
    case "VALIDATION_ERROR":
      return t("price.columns.invalid");
    case "NETWORK_ERROR":
      return t("common.saveOffline");
    default:
      return t("common.saveFailed");
  }
}

/** One problem of a row, in words (the list of errors under the summary). */
export function rowErrorText(error: PriceRowErrorValue, t: Translate): string {
  const number = (value: number | null) => (value === null ? "" : formatNumber(value));
  switch (error.code) {
    case "price_missing":
      return t("price.rowError.priceMissing");
    case "price_not_number":
      return t("price.rowError.priceNotNumber", { text: error.text ?? "" });
    case "price_out_of_range":
      return t("price.rowError.priceOutOfRange", {
        value: number(error.value),
        min: number(error.min),
        max: number(error.max),
      });
    case "no_article_or_name":
      return t("price.rowError.noArticleOrName");
    case "lead_days_out_of_range":
      return t("price.rowError.leadDaysOutOfRange", {
        value: number(error.value),
        max: number(error.max),
      });
    // Found by matching with the catalog (TASK-047). The row number is not a quantity: no separators.
    case "repeated_row":
      return t("price.rowError.repeatedRow", { value: String(error.value ?? "") });
    case "service_item":
      return t("price.rowError.serviceItem");
    case "supplier_type":
      return t("price.rowError.supplierType");
    // The hidden column of «Скачать мой прайс» (TASK-048): never says whose the item is.
    case "unknown_item_id":
      return t("price.rowError.unknownItemId");
  }
}

/** «12 500» — thousands apart by a thin no-break space, as the cabinet writes prices. */
export function formatNumber(value: number): string {
  const [whole, fraction] = numberText(value).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  return fraction ? `${grouped},${fraction}` : grouped;
}

/** A cell of the preview as the file holds it: a number without its format, a text as it is. */
export function cellText(cell: string | number | null): string {
  if (cell === null) return "";
  return typeof cell === "number" ? numberText(cell).replace(".", ",") : cell;
}

/** «1 240 строк» in the right form of the noun. */
export function rowsText(lang: Lang, count: number, t: Translate): string {
  const n = formatNumber(count);
  switch (pluralForm(lang, count)) {
    case "one":
      return t("price.rows.one", { n });
    case "few":
      return t("price.rows.few", { n });
    default:
      return t("price.rows.many", { n });
  }
}

/** «2,4 МБ», «180 КБ». */
export function sizeText(bytes: number, t: Translate): string {
  if (bytes >= 1024 * 1024) {
    return t("price.sizeMb", { n: (bytes / (1024 * 1024)).toFixed(1).replace(".", ",") });
  }
  return t("price.sizeKb", { n: Math.max(1, Math.round(bytes / 1024)) });
}

/** The line under an upload in the history: how far its reading is. */
type CountKey =
  | "price.part.confident"
  | "price.part.review"
  | "price.part.notFound"
  | "price.part.updated"
  | "price.part.created"
  | "price.part.withdrawn"
  | "price.part.requested";

/**
 * «Обновлено — 12, на добавление — 3»: only the parts that happened (C18,
 * TASK-079) — «снято — 0, создано — 0» said nothing; none at all — «Без изменений».
 */
export function countsText(parts: readonly (readonly [CountKey, number])[], t: Translate): string {
  const said = parts
    .filter(([, n]) => n > 0)
    .map(([key, n]) => t(key, { n: formatNumber(n) }))
    .join(", ");
  if (!said) return t("price.part.none");
  return said.charAt(0).toLocaleUpperCase() + said.slice(1);
}

export function progressText(entry: PriceImport, t: Translate, lang: Lang): string | null {
  if (entry.status === "parsing" && entry.photo) {
    // Photographed pages (TASK-064): «ожидает распознавания» or the page being read.
    if (entry.photo.aiWaiting) return t("price.photo.waiting");
    const total = entry.photo.pages.length;
    return total > 1
      ? t("price.photo.recognizing", {
          done: String(Math.min(total, entry.photo.recognized + 1)),
          total: String(total),
        })
      : t("price.photo.recognizingShort");
  }
  if (entry.status === "needs_retake" && entry.photo) {
    return t("price.photo.retakeTitle", {
      pages: entry.photo.pages
        .filter(pageNeedsRetake)
        .map((page) => String(page.pageNo))
        .join(", "),
    });
  }
  if (entry.status === "parsing") {
    return entry.progress && entry.progress.done > 0
      ? t("price.progressRows", { n: formatNumber(entry.progress.done) })
      : t("price.processing");
  }
  if (entry.status === "reading") {
    const done = entry.progress?.done ?? 0;
    const total = entry.progress?.total ?? entry.stats?.dataRows ?? 0;
    return t("price.progressValues", { done: formatNumber(done), total: formatNumber(total) });
  }
  if (entry.status === "parsed" && entry.stats) {
    return t("price.parsed.short", {
      rows: rowsText(lang, entry.stats.dataRows, t),
      errors: formatNumber(entry.stats.errorRows ?? 0),
    });
  }
  if (entry.status === "columns" && entry.stats) {
    return t("price.columnsWaiting", { rows: rowsText(lang, entry.stats.dataRows, t) });
  }
  if (entry.status === "failed" && entry.failure) return failureText(entry.failure, t);
  if (entry.status === "matching" && entry.match) {
    if (entry.match.aiWaiting) return t("price.aiWaiting");
    return t("price.progressMatch", {
      done: formatNumber(entry.match.done),
      total: formatNumber(entry.match.total),
    });
  }
  if (entry.status === "review" && entry.match) {
    return countsText(
      [
        ["price.part.confident", entry.match.confident],
        ["price.part.review", entry.match.review],
        ["price.part.notFound", entry.match.notFound],
      ],
      t,
    );
  }
  if (entry.status === "applied" && entry.result) {
    return countsText(
      [
        ["price.part.updated", entry.result.updated + entry.result.returned],
        ["price.part.created", entry.result.created],
        ["price.part.withdrawn", entry.result.withdrawnOutOfStock + entry.result.withdrawnMissing],
        ["price.part.requested", entry.result.requested],
      ],
      t,
    );
  }
  if (entry.status === "expired") return t("price.expired.short");
  return null;
}

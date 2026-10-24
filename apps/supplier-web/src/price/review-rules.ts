import { isApiError } from "@adclub/api-client";
import {
  priceImportItemUnavailableDetailsSchema,
  priceImportStateDetailsSchema,
  priceImportVersionConflictDetailsSchema,
  type DecidePriceRowBody,
  type PriceImportResult,
  type PriceReviewGroup,
  type PriceReviewRow,
  type PriceReviewSummary,
  type PriceRowNotAppliedReason,
} from "@adclub/contracts";
import { pluralForm, type Lang, type SupplierTextKey } from "@adclub/i18n";
import { retryMinutes } from "../errors";
import type { Translate } from "../i18n";
import { TENGE } from "../offers/offer-rules";
import { formatAt } from "../orders/order-rules";
import { formatNumber, rowsText } from "./price-rules";

/**
 * What the screens of the review and of its result decide (TASK-048;
 * SCREENS S-PRICE-03, S-PRICE-04): the words of the summary and of the
 * button «Применить», why the button is off, the tabs, «было → стало», the
 * state of a row's decision, a refusal of the server in words, the lines of
 * the result. Every number is the server's; nothing here decides a row.
 */

/** The five tabs of S-PRICE-03: four groups of rows and «Пропали из файла». */
export type ReviewTab = PriceReviewGroup | "missing";

export const REVIEW_TABS: readonly ReviewTab[] = [
  "confident",
  "review",
  "not_found",
  "errors",
  "missing",
];

const TAB_TEXT: Record<ReviewTab, SupplierTextKey> = {
  confident: "review.tab.confident",
  review: "review.tab.review",
  not_found: "review.tab.notFound",
  errors: "review.tab.errors",
  missing: "review.tab.missing",
};

/** How many entries a tab has, as the summary counts them. */
export function tabCount(summary: PriceReviewSummary, tab: ReviewTab): number {
  switch (tab) {
    case "confident":
      return summary.groups.confident;
    case "review":
      return summary.groups.review;
    case "not_found":
      return summary.groups.notFound;
    case "errors":
      return summary.groups.errors;
    case "missing":
      return summary.missing.offers;
  }
}

/** «Нужно проверить» — the name of a tab (under its number in the summary, TASK-079). */
export function tabName(tab: ReviewTab, t: Translate): string {
  return t(TAB_TEXT[tab]);
}

/** «1 240 строк» — all the rows of the file the review is about. */
export function totalRowsText(summary: PriceReviewSummary, t: Translate, lang: Lang): string {
  const { groups } = summary;
  return rowsText(lang, groups.confident + groups.review + groups.notFound + groups.errors, t);
}

/** «Нужно проверить · 800». */
export function tabLabel(summary: PriceReviewSummary, tab: ReviewTab, t: Translate): string {
  return `${t(TAB_TEXT[tab])} · ${formatNumber(tabCount(summary, tab))}`;
}

/**
 * The tab a review opens on: the one wanting a decision first — «Нужно
 * проверить», then «Пропали из файла» without a choice — else «Уверенно».
 */
export function firstTab(summary: PriceReviewSummary): ReviewTab {
  if (summary.preview.unchecked > 0) return "review";
  if (summary.missing.offers > 0 && summary.missing.action === null) return "missing";
  if (summary.sharpPrice.unconfirmed > 0) return "confident";
  if (summary.groups.review > 0) return "review";
  if (summary.groups.confident > 0) return "confident";
  if (summary.groups.notFound > 0) return "not_found";
  return summary.groups.errors > 0 ? "errors" : "confident";
}

/**
 * The summary of SCREENS S-PRICE-03, word for word: «N строк: уверенно — …;
 * нужно проверить — …; не найдено — …; ошибки в строках — …. Пропали из
 * файла — … (по N есть активные заявки)».
 */
export function summaryText(summary: PriceReviewSummary, t: Translate, lang: Lang): string {
  const { groups, missing } = summary;
  const total = groups.confident + groups.review + groups.notFound + groups.errors;
  const head = t("review.summary", {
    rows: rowsText(lang, total, t),
    confident: formatNumber(groups.confident),
    review: formatNumber(groups.review),
    notFound: formatNumber(groups.notFound),
    errors: formatNumber(groups.errors),
    missing: formatNumber(missing.offers),
  });
  return missing.withActiveOrders > 0
    ? `${head} ${t("review.summaryOrders", { n: formatNumber(missing.withActiveOrders) })}`
    : head;
}

/** «Применить: обновить N · снять M · отправить на добавление K» — the preview of the server. */
export function applyText(summary: PriceReviewSummary, t: Translate): string {
  const { preview } = summary;
  return t("review.apply", {
    update: formatNumber(preview.update + preview.create),
    withdraw: formatNumber(preview.withdraw),
    request: formatNumber(preview.request),
  });
}

/** Why «Применить» is off; `null` — it is on. */
export function applyBlocked(
  summary: PriceReviewSummary,
  online: boolean,
): "missing_choice" | "offline" | "not_review" | null {
  if (summary.import.status !== "review") return "not_review";
  if (summary.missing.offers > 0 && summary.missing.action === null) return "missing_choice";
  if (!online) return "offline";
  return null;
}

/**
 * «N строк не проверены и не будут применены» (SCREENS), the verb agreeing
 * with the number: «21 строка не проверена и не будет применена».
 */
export function uncheckedText(count: number, t: Translate, lang: Lang): string {
  const rows = rowsText(lang, count, t);
  return pluralForm(lang, count) === "one"
    ? t("review.uncheckedOne", { rows })
    : t("review.unchecked", { rows });
}

/** «По N позициям есть активные заявки — их нужно выполнить», «По 1 позиции …». */
export function missingOrdersText(count: number, t: Translate, lang: Lang): string {
  return t(pluralForm(lang, count) === "one" ? "review.missingOrdersOne" : "review.missingOrders", {
    n: formatNumber(count),
  });
}

/** The notes beside the button: rows left unchecked, prices waiting for «Подтвердить». */
export function applyNotes(summary: PriceReviewSummary, t: Translate, lang: Lang): string[] {
  const notes: string[] = [];
  if (summary.preview.unchecked > 0) {
    notes.push(uncheckedText(summary.preview.unchecked, t, lang));
  }
  if (summary.preview.priceConfirmationRequired > 0) {
    notes.push(
      t("review.priceWaiting", {
        rows: rowsText(lang, summary.preview.priceConfirmationRequired, t),
      }),
    );
  }
  return notes;
}

// ---------------------------------------------------------------- a row

/** What the file says of the item: article, brand, name — as written. */
export function fileText(row: PriceReviewRow): string {
  const parsed = row.parsed;
  if (!parsed) return "";
  return [parsed.article, parsed.brand, parsed.name].filter(Boolean).join(" · ");
}

const AVAILABILITY_TEXT = {
  in_stock: "review.availability.inStock",
  on_order: "review.availability.onOrder",
  out_of_stock: "review.availability.outOfStock",
} as const satisfies Record<string, SupplierTextKey>;

/**
 * «было → стало» of a row: the price («12 500 → 13 000 ₸»), and the
 * availability and the term when the file changes them; «новое
 * предложение» when the company has none yet.
 */
export function changeLines(row: PriceReviewRow, t: Translate): string[] {
  const parsed = row.parsed;
  if (!parsed || parsed.price === null) return [];
  const price = (value: number) => `${formatNumber(value)}${TENGE}`;
  if (!row.offer) {
    const lines = [`${price(parsed.price)} · ${t("review.newOffer")}`];
    if (parsed.availability) lines.push(t(AVAILABILITY_TEXT[parsed.availability]));
    return lines;
  }
  const lines = [
    row.offer.price === parsed.price
      ? price(parsed.price)
      : `${formatNumber(row.offer.price)} → ${price(parsed.price)}`,
  ];
  if (parsed.availability && parsed.availability !== row.offer.availability) {
    lines.push(
      `${t(AVAILABILITY_TEXT[row.offer.availability])} → ${t(AVAILABILITY_TEXT[parsed.availability])}`,
    );
  }
  if (parsed.leadDays !== null && parsed.leadDays !== row.offer.leadDays) {
    lines.push(
      t("review.leadDaysChange", {
        from: formatNumber(row.offer.leadDays),
        to: formatNumber(parsed.leadDays),
      }),
    );
  }
  return lines;
}

const DECISION_TEXT = {
  accept: "review.decided.accept",
  other: "review.decided.other",
  skip: "review.decided.skip",
  not_in_catalog: "review.decided.notInCatalog",
} as const satisfies Record<string, SupplierTextKey>;

/** «Верно · Ерлан, в 14:02» — the decision on the row, who took it and when. */
export function decidedText(
  row: PriceReviewRow,
  timeZone: string,
  lang: Lang,
  t: Translate,
): string | null {
  const decision = row.decision;
  if (!decision) return null;
  return t("review.decidedBy", {
    decision: t(DECISION_TEXT[decision.kind]),
    name: decision.by.name ?? t("review.colleague"),
    when: formatAt(decision.at, timeZone, lang, t),
  });
}

/** The item the row will be applied to now: the decision's, else the matched one. */
export function chosenItem(row: PriceReviewRow) {
  if (row.decision?.kind === "accept" || row.decision?.kind === "other") {
    const id = row.decision.itemId;
    return [row.item, ...row.candidates].find((item) => item?.id === id) ?? null;
  }
  if (row.decision) return null;
  return row.item;
}

/** A note of a row in words: several brands, the brand of the file has none, another row on the item. */
export function noteText(row: PriceReviewRow, t: Translate): string | null {
  const note = row.note;
  if (!note) return null;
  switch (note.code) {
    case "several_brands":
      return t("review.note.severalBrands");
    case "other_brand":
      return t("review.note.otherBrand");
    case "same_item":
      return t("review.note.sameItem", { row: String(note.rowNo ?? "") });
  }
}

/**
 * The body of «Подтвердить новую цену» — the one action the cabinet takes
 * on a row of «Уверенно» without changing its item.
 */
export function confirmPriceBody(confirmed: boolean): Omit<DecidePriceRowBody, "expectedVersion"> {
  return { priceConfirmed: confirmed };
}

// ---------------------------------------------------------- refusals

/** A refused change of the review, in words, and what the screen does next. */
export interface ReviewRefusal {
  text: string;
  /** Read the review again: someone else changed it. */
  reload: boolean;
  /** The same action may be repeated once the review is read again («Повторить моё решение»). */
  repeatable: boolean;
  /** The import left the review (applied, expired): show the whole upload again. */
  left: boolean;
}

export function reviewRefusal(
  error: unknown,
  timeZone: string,
  lang: Lang,
  t: Translate,
): ReviewRefusal {
  const plain = (text: string): ReviewRefusal => ({
    text,
    reload: false,
    repeatable: false,
    left: false,
  });
  if (!isApiError(error)) return plain(t("common.saveFailed"));
  switch (error.code) {
    case "PRICE_IMPORT_VERSION_CONFLICT": {
      const details = priceImportVersionConflictDetailsSchema.safeParse(error.details);
      const name = details.success ? details.data.changedBy?.name : null;
      return {
        text: name ? t("review.conflict", { name }) : t("review.conflictNoName"),
        reload: true,
        repeatable: true,
        left: false,
      };
    }
    case "PRICE_IMPORT_STATE": {
      const details = priceImportStateDetailsSchema.safeParse(error.details);
      const data = details.success ? details.data : null;
      const applied = data && (data.status === "applying" || data.status === "applied");
      const text = !applied
        ? data?.status === "expired"
          ? t("price.expired.short")
          : t("review.notReview")
        : data.appliedBy?.name && data.appliedAt
          ? t("review.alreadyApplied", {
              name: data.appliedBy.name,
              when: formatAt(data.appliedAt, timeZone, lang, t),
            })
          : t("review.alreadyAppliedNoName");
      return { text, reload: true, repeatable: false, left: true };
    }
    case "PRICE_IMPORT_ITEM_UNAVAILABLE": {
      const details = priceImportItemUnavailableDetailsSchema.safeParse(error.details);
      const reason = details.success ? details.data.reason : "unavailable";
      return plain(t(ITEM_REFUSAL_TEXT[reason]));
    }
    case "PRICE_IMPORT_MISSING_CHOICE":
      return { ...plain(t("review.applyNeedsMissing")), reload: true };
    case "SUPPLIER_BLOCKED":
      return plain(t("review.blocked"));
    case "VALIDATION_ERROR":
      return { ...plain(t("review.rowError")), reload: true };
    case "RATE_LIMITED":
      return plain(t("common.tooManyRequests", { minutes: retryMinutes(error) }));
    case "NETWORK_ERROR":
      return plain(t("common.saveOffline"));
    default:
      return plain(t("common.saveFailed"));
  }
}

const ITEM_REFUSAL_TEXT = {
  service_item: "review.itemUnavailable.service",
  supplier_type: "review.itemUnavailable.supplierType",
  unavailable: "review.itemUnavailable.unavailable",
} as const satisfies Record<string, SupplierTextKey>;

// ------------------------------------------------------------ the result

/**
 * S-PRICE-04 word for word: «Готово: обновлено N, снято M, на добавление
 * отправлено K — результат в разделе „Модерация“». «Обновлено» counts the
 * offers changed and those back on sale; «снято» — both kinds.
 */
export function resultText(result: PriceImportResult, t: Translate): string {
  return t("result.done", {
    updated: formatNumber(result.updated + result.returned),
    withdrawn: formatNumber(result.withdrawnOutOfStock + result.withdrawnMissing),
    requested: formatNumber(result.requested),
  });
}

/** The other lines of the result, without the zero ones. */
/**
 * The rest of the result as rows «подпись — число» (S-PRICE-04, TASK-079:
 * not a bulleted list); only what happened.
 */
export function resultRows(
  result: PriceImportResult,
  t: Translate,
): { label: string; count: string }[] {
  const lines: [SupplierTextKey, number][] = [
    ["result.created", result.created],
    ["result.returned", result.returned],
    ["result.outOfStock", result.withdrawnOutOfStock],
    ["result.missing", result.withdrawnMissing],
    ["result.unchanged", result.unchanged],
    ["result.skipped", result.skipped],
  ];
  return lines
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ label: t(key), count: formatNumber(count) }));
}

/**
 * A reason of «Не применено» as its short name and the explanation after
 * « — », said quieter under it (TASK-079).
 */
export function reasonParts(text: string): { name: string; explanation: string | null } {
  const at = text.indexOf(" — ");
  return at < 0
    ? { name: text, explanation: null }
    : { name: text.slice(0, at), explanation: text.slice(at + 3) };
}

const NOT_APPLIED_TEXT: Record<PriceRowNotAppliedReason, SupplierTextKey> = {
  price_out_of_range: "result.reason.priceOutOfRange",
  lead_days_out_of_range: "result.reason.leadDaysOutOfRange",
  on_order_needs_lead_days: "result.reason.onOrderNeedsLeadDays",
  no_fulfillment: "result.reason.noFulfillment",
  pickup_needs_address: "result.reason.pickupNeedsAddress",
  warranty_both: "result.reason.warrantyBoth",
  warranty_contacts: "result.reason.warrantyContacts",
  price_confirmation_required: "result.reason.priceConfirmationRequired",
  item_unavailable: "result.reason.itemUnavailable",
  service_item: "result.reason.serviceItem",
  supplier_type: "result.reason.supplierType",
  out_of_stock: "result.reason.outOfStock",
  duplicate_item: "result.reason.duplicateItem",
};

/** Why rows were not applied, in words; a reason the cabinet doesn't know yet — a general one. */
export function notAppliedText(reason: PriceRowNotAppliedReason, t: Translate): string {
  return t(NOT_APPLIED_TEXT[reason] ?? "result.reason.other");
}

/** The reasons of «Не применено», the most rows first. */
export function notAppliedGroups(
  result: PriceImportResult,
): { reason: PriceRowNotAppliedReason; rows: number }[] {
  return [...result.notApplied].filter((entry) => entry.rows > 0).sort((a, b) => b.rows - a.rows);
}

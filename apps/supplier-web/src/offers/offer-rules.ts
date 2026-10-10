import { isApiError } from "@adclub/api-client";
import type {
  OfferAvailability,
  OfferItem,
  OfferHiddenReasonValue,
  OfferReceipt,
  SupplierOffer,
  UpdateOfferBody,
} from "@adclub/contracts";
import { pluralForm, type Lang, type SupplierTextKey } from "@adclub/i18n";

/**
 * What the cabinet makes of the server's answers about offers (TASK-032;
 * SCREENS S-OFF-01…03). Nothing here decides a rule of the showcase, a
 * receipt date or whether an offer is valid — the server does (TASK-018,
 * TASK-020.A); these functions only word its answer and put it next to the
 * field it is about.
 */

export type Translate = (
  key: SupplierTextKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

/** Letters and digits of a query: the server asks for at least three of them. */
export function meaningfulLength(query: string): number {
  return query.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

/** «Тормоза › Тормозные колодки» — where the item is in the club's catalog. */
export function categoryLine(item: OfferItem): string {
  return [item.category.parentName?.text, item.category.name.text].filter(Boolean).join(" › ");
}

// ------------------------------------------------------------ the showcase

export interface HiddenReason {
  key: SupplierTextKey;
  /** The fix is on the company card («Компания»). */
  toCompany: boolean;
}

const HIDDEN_REASONS: Record<OfferHiddenReasonValue, HiddenReason> = {
  offer_withdrawn: { key: "offers.hidden.withdrawn", toCompany: false },
  offer_suspended: { key: "offers.hidden.suspended", toCompany: false },
  supplier_blocked: { key: "offers.hidden.blocked", toCompany: false },
  supplier_paused: { key: "offers.hidden.paused", toCompany: false },
  supplier_type_mismatch: { key: "offers.hidden.typeMismatch", toCompany: false },
  item_unavailable: { key: "offers.hidden.itemUnavailable", toCompany: false },
  category_hidden: { key: "offers.hidden.categoryHidden", toCompany: false },
  no_city: { key: "offers.hidden.noCity", toCompany: false },
  hours_not_set: { key: "offers.hidden.hoursNotSet", toCompany: true },
  no_working_day: { key: "offers.hidden.noWorkingDay", toCompany: true },
};

/**
 * «Не видно клиентам: …» of an offer, in the server's order. On the tab
 * «Снятые» the tab itself says the offer is withdrawn, so that reason is
 * left out there (`withWithdrawn: false`).
 */
export function hiddenReasons(
  offer: Pick<SupplierOffer, "showcase">,
  options: { withWithdrawn?: boolean } = {},
): HiddenReason[] {
  if (offer.showcase.visible) return [];
  return offer.showcase.reasons
    .filter((reason) => options.withWithdrawn !== false || reason !== "offer_withdrawn")
    .map((reason) => HIDDEN_REASONS[reason]);
}

/**
 * The reason that is the company's schedule, if any offer on screen has it
 * (D-060): one banner over the list with the way to «Компания» — every
 * offer of the point is hidden by it, so saying it once is clearer than a
 * hundred rows saying the same.
 */
export function scheduleProblem(
  offers: readonly Pick<SupplierOffer, "showcase">[],
): "hours_not_set" | "no_working_day" | null {
  for (const offer of offers) {
    for (const reason of offer.showcase.reasons) {
      if (reason === "hours_not_set" || reason === "no_working_day") return reason;
    }
  }
  return null;
}

// ------------------------------------------------------------ server errors

/** The fields of the offer form, where a refusal is shown. */
export type OfferField =
  | "price"
  | "availability"
  | "leadDays"
  | "pickup"
  | "delivery"
  | "warrantyMonths"
  | "warrantyText"
  | "supplierSku"
  | "supplierName";

const OFFER_FIELDS: ReadonlySet<string> = new Set<OfferField>([
  "price",
  "availability",
  "leadDays",
  "pickup",
  "delivery",
  "warrantyMonths",
  "warrantyText",
  "supplierSku",
  "supplierName",
]);

export interface OfferProblem {
  /** The field the refusal is about; `null` — the form as a whole. */
  field: OfferField | null;
  key: SupplierTextKey;
  params?: Record<string, string | number>;
  /** Where the fix is: the company card, or the offer that already exists. */
  link?: { to: "company" } | { to: "offer"; offerId: string };
  /** The offer was changed meanwhile (a colleague): reload it, keep what was typed. */
  conflict?: boolean;
}

interface Issue {
  path?: unknown;
  min?: unknown;
  max?: unknown;
}

function firstIssue(details: unknown): Issue | null {
  if (Array.isArray(details) && typeof details[0] === "object" && details[0] !== null) {
    return details[0] as Issue;
  }
  return null;
}

function record(details: unknown): Record<string, unknown> {
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)
    : {};
}

const tenge = (value: number) => formatAmount(value);

/** The refusal of a VALIDATION_ERROR, by the first field the server named. */
function validationProblem(details: unknown): OfferProblem {
  const issue = firstIssue(details);
  const path = typeof issue?.path === "string" ? issue.path.split(".")[0]! : "";
  const field = OFFER_FIELDS.has(path) ? (path as OfferField) : null;
  const bounds =
    typeof issue?.min === "number" && typeof issue.max === "number"
      ? { min: issue.min, max: issue.max }
      : null;
  switch (field) {
    case "price":
      return bounds
        ? {
            field,
            key: "offers.error.priceRange",
            params: { min: tenge(bounds.min), max: tenge(bounds.max) },
          }
        : { field, key: "offers.error.price" };
    case "leadDays":
      return bounds
        ? { field, key: "offers.error.leadDaysRange", params: { max: bounds.max } }
        : { field, key: "offers.error.onOrderNeedsDays" };
    case "availability":
      // The one rule the server checks on «наличие»: under order needs a term.
      return { field: "leadDays", key: "offers.error.onOrderNeedsDays" };
    case "pickup":
    case "delivery":
      return { field: "pickup", key: "offers.error.pickupOrDelivery" };
    case "warrantyMonths":
      return { field, key: "offers.error.warrantyMonths" };
    case "warrantyText":
      return { field, key: "offers.error.warrantyText" };
    case "supplierSku":
    case "supplierName":
      return { field, key: "offers.error.text" };
    default:
      return { field: null, key: "common.saveFailed" };
  }
}

/** Where and how to show a refused create, change, withdraw or return of an offer. */
export function offerProblem(error: unknown): OfferProblem {
  if (!isApiError(error)) return { field: null, key: "common.saveFailed" };
  const details = record(error.details);
  switch (error.code) {
    case "NETWORK_ERROR":
      return { field: null, key: "common.saveOffline" };
    case "RATE_LIMITED":
      return {
        field: null,
        key: "common.tooManyRequests",
        params: {
          minutes: Math.max(1, Math.ceil(Number(details.retryAfterSeconds ?? 60) / 60)),
        },
      };
    case "VALIDATION_ERROR":
      return validationProblem(error.details);
    case "OFFER_PICKUP_NEEDS_ADDRESS":
      return { field: "pickup", key: "offers.error.pickupNeedsAddress", link: { to: "company" } };
    case "OFFER_WARRANTY_CONTACTS":
      return { field: "warrantyText", key: "offers.error.warrantyContacts" };
    case "OFFER_EXISTS":
      return {
        field: null,
        key:
          details.status === "withdrawn" ? "offers.error.existsWithdrawn" : "offers.error.exists",
        link:
          typeof details.existingOfferId === "string"
            ? { to: "offer", offerId: details.existingOfferId }
            : undefined,
      };
    case "OFFER_VERSION_CONFLICT":
      return { field: null, key: "offers.conflict", conflict: true };
    case "OFFER_ITEM_UNAVAILABLE":
      return { field: null, key: "offers.error.itemUnavailable" };
    case "OFFER_NOT_APPLICABLE":
      // The company's type (TASK-019): «только товары» or «только услуги».
      return {
        field: null,
        key:
          details.supplierType === "services"
            ? "offers.error.servicesOnly"
            : "offers.error.goodsOnly",
      };
    case "OFFER_STATE":
      return { field: null, key: "offers.error.state", conflict: true };
    case "NOT_FOUND":
      return { field: null, key: "offers.error.notFound" };
    default:
      return { field: null, key: "common.saveFailed" };
  }
}

// ------------------------------------------------------------- the receipt

function localeOf(lang: Lang): string {
  return lang === "kk" ? "kk-KZ" : lang;
}

/** «14 марта» of a `YYYY-MM-DD` date (the date as the server gave it, no time zone shift). */
export function formatDay(date: string, lang: Lang): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** «сегодня, 14 марта», «завтра, 15 марта» or «16 марта» — from the day the order would be confirmed. */
export function receiptDay(receipt: OfferReceipt, lang: Lang, t: Translate): string | null {
  if (!receipt.date) return null;
  const day = formatDay(receipt.date, lang);
  switch (daysBetween(receipt.confirmedOn, receipt.date)) {
    case 0:
      return t("offerForm.today", { date: day });
    case 1:
      return t("offerForm.tomorrow", { date: day });
    default:
      return day;
  }
}

/**
 * «Клиент увидит: Самовывоз — завтра, 14 марта · Доставка — до 14 марта»
 * (S-OFF-03; ARCHITECTURE 4.29 I288: one date per offer, delivery «до» it).
 * `null` — no date: the point has no hours or no working day (D-060).
 */
export function receiptPreview(
  receipt: OfferReceipt,
  receiving: { pickup: boolean; delivery: boolean },
  lang: Lang,
  t: Translate,
): string[] | null {
  const when = receiptDay(receipt, lang, t);
  if (when === null || !receipt.date) return null;
  const lines: string[] = [];
  if (receiving.pickup) lines.push(t("offerForm.previewPickup", { when }));
  if (receiving.delivery) {
    lines.push(t("offerForm.previewDelivery", { date: formatDay(receipt.date, lang) }));
  }
  return lines;
}

// --------------------------------------------------------- numbers in fields

/** `\s` covers the no-break spaces of a pasted «13 000» too. */
const GROUPING = /\s/g;

/** «13 000» → 13000; anything but digits (and spaces between them) — `null`. */
export function parseAmount(text: string): number | null {
  const digits = text.replace(GROUPING, "");
  if (!/^\d{1,10}$/.test(digits)) return null;
  return Number(digits);
}

/** 13000 → «13 000» (a plain space: the field and the list show the same text). */
export function formatAmount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Keeps a field of whole numbers readable while typed: digits only, grouped. */
export function typeAmount(text: string): string {
  const digits = text
    .replace(/\D/g, "")
    .replace(/^0+(?=\d)/, "")
    .slice(0, 10);
  return digits === "" ? "" : formatAmount(Number(digits));
}

// ------------------------------------------------------ editing in the row

/** What the row of S-OFF-01 holds while a person edits it. */
export interface RowDraft {
  price: string;
  availability: OfferAvailability;
  leadDays: string;
}

export function rowDraftOf(
  offer: Pick<SupplierOffer, "price" | "availability" | "leadDays">,
): RowDraft {
  return {
    price: formatAmount(offer.price),
    availability: offer.availability,
    leadDays: String(offer.leadDays),
  };
}

/** «15 500 ₸ · В наличии · 0 дн.» — what a colleague left, after a conflict. */
export function nowValues(
  offer: Pick<SupplierOffer, "price" | "availability" | "leadDays">,
  t: Translate,
): string {
  return t("offers.nowValues", {
    price: formatAmount(offer.price),
    availability: t(offer.availability === "in_stock" ? "offers.inStock" : "offers.onOrder"),
    days: offer.leadDays,
  });
}

/** The fields a row changes (and «Отменить» sends back): only those that differ. */
export type RowFields = Pick<UpdateOfferBody, "price" | "availability" | "leadDays">;

export type RowCommit =
  | { kind: "none" }
  | { kind: "invalid"; field: "price" | "leadDays"; key: SupplierTextKey }
  | { kind: "save"; change: RowFields; previous: RowFields };

/**
 * What saving the row would send: only the fields that differ from the
 * offer, and the values to send back for «Отменить». A price or a term that
 * isn't a whole number, or «под заказ» without a term, is not sent — the
 * field says why. The bounds of the price and the term are the server's.
 */
export function rowCommit(
  offer: Pick<SupplierOffer, "price" | "availability" | "leadDays">,
  draft: RowDraft,
): RowCommit {
  const price = parseAmount(draft.price);
  if (price === null || price < 1) {
    return { kind: "invalid", field: "price", key: "offers.error.price" };
  }
  const leadDays = parseAmount(draft.leadDays);
  if (leadDays === null) {
    return { kind: "invalid", field: "leadDays", key: "offers.error.leadDays" };
  }
  if (draft.availability === "on_order" && leadDays === 0) {
    return { kind: "invalid", field: "leadDays", key: "offers.error.onOrderNeedsDays" };
  }
  const change: RowFields = {};
  const previous: RowFields = {};
  if (price !== offer.price) {
    change.price = price;
    previous.price = offer.price;
  }
  if (draft.availability !== offer.availability) {
    change.availability = draft.availability;
    previous.availability = offer.availability;
  }
  if (leadDays !== offer.leadDays) {
    change.leadDays = leadDays;
    previous.leadDays = offer.leadDays;
  }
  return Object.keys(change).length === 0 ? { kind: "none" } : { kind: "save", change, previous };
}

// ---------------------------------------------------------- the offer form

export type WarrantyKind = "none" | "months" | "text";

/** S-OFF-03 while a person fills it in: what the fields hold, as typed. */
export interface OfferForm {
  price: string;
  availability: OfferAvailability;
  leadDays: string;
  pickup: boolean;
  delivery: boolean;
  warranty: WarrantyKind;
  warrantyMonths: string;
  warrantyText: string;
  supplierSku: string;
  supplierName: string;
}

/**
 * The form of a new offer: in stock, today, pickup; «Доставка» starts as
 * the company's «доставка по умолчанию для новых предложений» (S-COMP-01).
 */
export function newOfferForm(deliveryByDefault: boolean): OfferForm {
  return {
    price: "",
    availability: "in_stock",
    leadDays: "0",
    pickup: true,
    delivery: deliveryByDefault,
    warranty: "none",
    warrantyMonths: "",
    warrantyText: "",
    supplierSku: "",
    supplierName: "",
  };
}

export function offerFormOf(offer: SupplierOffer): OfferForm {
  return {
    price: formatAmount(offer.price),
    availability: offer.availability,
    leadDays: String(offer.leadDays),
    pickup: offer.pickup,
    delivery: offer.delivery,
    warranty:
      offer.warrantyMonths !== null ? "months" : offer.warrantyText !== null ? "text" : "none",
    warrantyMonths: offer.warrantyMonths === null ? "" : String(offer.warrantyMonths),
    warrantyText: offer.warrantyText ?? "",
    supplierSku: offer.supplierSku ?? "",
    supplierName: offer.supplierName ?? "",
  };
}

/** The values of the form as the contract carries them. */
export interface OfferValues {
  price: number;
  availability: OfferAvailability;
  leadDays: number;
  pickup: boolean;
  delivery: boolean;
  warrantyMonths: number | null;
  warrantyText: string | null;
  supplierSku: string | null;
  supplierName: string | null;
}

export type FormCheck =
  { ok: true; values: OfferValues } | { ok: false; field: OfferField; key: SupplierTextKey };

const text = (value: string) => value.trim().replace(/\s+/g, " ") || null;

/**
 * The form as values, or the first field to fix: only what can't even be
 * sent (not a number, «под заказ» without a term, neither pickup nor
 * delivery). The bounds and the rest are the server's, shown on its answer.
 */
export function checkOfferForm(form: OfferForm): FormCheck {
  const price = parseAmount(form.price);
  if (price === null || price < 1) return { ok: false, field: "price", key: "offers.error.price" };
  const leadDays = parseAmount(form.leadDays);
  if (leadDays === null) return { ok: false, field: "leadDays", key: "offers.error.leadDays" };
  if (form.availability === "on_order" && leadDays === 0) {
    return { ok: false, field: "leadDays", key: "offers.error.onOrderNeedsDays" };
  }
  if (!form.pickup && !form.delivery) {
    return { ok: false, field: "pickup", key: "offers.error.pickupOrDelivery" };
  }
  let warrantyMonths: number | null = null;
  if (form.warranty === "months") {
    warrantyMonths = parseAmount(form.warrantyMonths);
    if (warrantyMonths === null || warrantyMonths < 1) {
      return { ok: false, field: "warrantyMonths", key: "offers.error.warrantyMonths" };
    }
  }
  const warrantyText = form.warranty === "text" ? text(form.warrantyText) : null;
  if (form.warranty === "text" && warrantyText === null) {
    return { ok: false, field: "warrantyText", key: "offers.error.warrantyText" };
  }
  return {
    ok: true,
    values: {
      price,
      availability: form.availability,
      leadDays,
      pickup: form.pickup,
      delivery: form.delivery,
      warrantyMonths,
      warrantyText,
      supplierSku: text(form.supplierSku),
      supplierName: text(form.supplierName),
    },
  };
}

/** The fields that differ from the offer — what a save of its card sends. */
export function changedValues(offer: SupplierOffer, values: OfferValues): Partial<OfferValues> {
  const changed: Partial<OfferValues> = {};
  for (const key of Object.keys(values) as (keyof OfferValues)[]) {
    if (values[key] !== offer[key]) (changed as Record<string, unknown>)[key] = values[key];
  }
  return changed;
}

/** «По этому предложению N активных заявок — их нужно выполнить», in the right form of the noun. */
export function activeOrdersWarningKey(lang: Lang, count: number): SupplierTextKey {
  switch (pluralForm(lang, count)) {
    case "one":
      return "offers.withdrawActive.one";
    case "few":
      return "offers.withdrawActive.few";
    default:
      return "offers.withdrawActive.many";
  }
}

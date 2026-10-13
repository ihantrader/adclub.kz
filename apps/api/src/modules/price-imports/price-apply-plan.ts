import type { PriceRowDecisionKind, PriceRowNotAppliedReason } from "@adclub/contracts";
import {
  offerTermsProblem,
  priceNameKey,
  sharpPriceChange,
  type OfferLimits,
  type OfferTerms,
  type ParsedPriceRow,
  type PriceRowKeyKind,
  type SupplierOfferType,
} from "@adclub/domain";
import type { PriceMatchSource } from "@adclub/contracts";
import { itemRefusal, type MatchItem } from "./price-match-items";
import type { PriceRowGroup } from "./schema";

/**
 * What applying a reviewed price list does to each row (TASK-047
 * requirement 4; ARCHITECTURE 12.1 step 7, 4.67): one pure function, so the
 * numbers of the button «Применить: обновить N · снять M · отправить на
 * добавление K» and the application itself can never disagree. The rules of
 * an offer are `offerTermsProblem` of the domain — the very check the
 * cabinet applies to an offer put by hand.
 */

/** A row of the review as the plan needs it. */
export interface PlanRow {
  rowNo: number;
  parsed: ParsedPriceRow;
  group: PriceRowGroup;
  source: PriceMatchSource | null;
  itemId: string | null;
  decision: PriceRowDecisionKind | null;
  decisionItemId: string | null;
  priceConfirmed: boolean;
  sendRequest: boolean | null;
  keyKind: PriceRowKeyKind;
  key: string;
}

/** The company's offer on an item now. */
export interface PlanOffer {
  id: string;
  status: "active" | "withdrawn" | "suspended";
  price: number;
  availability: "in_stock" | "on_order";
  leadDays: number;
  pickup: boolean;
  delivery: boolean;
  warrantyMonths: number | null;
  warrantyText: string | null;
  supplierSku: string | null;
  supplierRawName: string | null;
  withdrawnReason: string | null;
}

export interface PlanFacts {
  supplierType: SupplierOfferType;
  items: ReadonlyMap<string, MatchItem>;
  /** By item. */
  offers: ReadonlyMap<string, PlanOffer>;
  limits: OfferLimits;
  /** `price_change_threshold_percent`. */
  sharpPercent: number;
  /** The pickup point has an address: a new offer is picked up there. */
  pointHasAddress: boolean;
  /** «Доставка по умолчанию для новых предложений» of the company. */
  deliveryByDefault: boolean;
  /** `kind:key` of the company's requests still open: not sent again. */
  openRequests: ReadonlySet<string>;
  /** `kind:key` of the company's requests the administrator refused: not sent again unless asked. */
  rejectedRequests: ReadonlySet<string>;
}

/** The offer's fields after applying a row. */
export interface OfferChange {
  price: number;
  availability: "in_stock" | "on_order";
  leadDays: number;
  supplierSku: string | null;
  supplierRawName: string | null;
  status: "active" | "withdrawn" | "suspended";
  withdrawnReason: string | null;
}

export type RowAction =
  | { kind: "create"; itemId: string; price: number; terms: OfferTerms; change: OfferChange }
  | {
      kind: "update";
      itemId: string;
      offer: PlanOffer;
      change: OfferChange;
      returned: boolean;
      withdrawn: boolean;
    }
  | { kind: "unchanged"; itemId: string; offer: PlanOffer }
  | { kind: "request"; created: boolean }
  | { kind: "skipped"; unchecked: boolean }
  | { kind: "not_applied"; reason: PriceRowNotAppliedReason; itemId: string | null };

/** What the company's memory of the row's key becomes. */
export type Remember =
  | { decision: "item"; itemId: string; by: "supplier" | "auto" }
  | { decision: "skip" }
  | { decision: "absent" }
  | { touch: true }
  | null;

export interface RowPlan {
  row: PlanRow;
  action: RowAction;
  remember: Remember;
}

const REFUSAL_REASON = {
  unavailable: "item_unavailable",
  service_item: "service_item",
  supplier_type: "supplier_type",
} as const;

/**
 * «Отправить администратору» of a row not found: what the supplier chose;
 * by default on — off for a row skipped before and for one whose request
 * the administrator refused (the supplier sees why; it isn't sent again by
 * itself).
 */
export function sendsRequest(
  row: Pick<PlanRow, "sendRequest" | "source" | "decision">,
  refused: boolean,
): boolean {
  if (row.sendRequest !== null) return row.sendRequest;
  if (refused) return false;
  return row.decision === "not_in_catalog" || row.source !== "remembered_skip";
}

/**
 * A row of the cabinet's export (`item_id`, TASK-048) carries the catalog's
 * article and name where the offer has none of its own — the file shows
 * something in every cell. Coming back, such a cell is not the supplier's
 * own article or name: the offer keeps having none, so a file returned
 * unchanged changes nothing. A text the supplier did change is his.
 */
function exportedOwnTexts(
  row: PlanRow,
  item: MatchItem | undefined,
  offer: PlanOffer | undefined,
): ParsedPriceRow {
  const file = row.parsed;
  if (row.source !== "item_id" || !item || !offer) return file;
  const catalogArticle =
    offer.supplierSku === null &&
    file.articleNorm !== null &&
    item.articleNorm !== null &&
    file.articleNorm === item.articleNorm;
  const catalogName =
    offer.supplierRawName === null &&
    file.name !== null &&
    priceNameKey(file.name) === priceNameKey(item.name);
  if (!catalogArticle && !catalogName) return file;
  return {
    ...file,
    ...(catalogArticle && { article: null, articleNorm: null }),
    ...(catalogName && { name: null }),
  };
}

/** The item a row is applied to, `null` — none; `undefined` — the row isn't about an item. */
function finalItem(row: PlanRow): string | null | undefined {
  if (row.decision === "accept" || row.decision === "other") return row.decisionItemId;
  if (row.decision === null && row.group === "confident") return row.itemId;
  return undefined;
}

/** Every row, in the order of the file; a later row on an item already applied is `duplicate_item`. */
export function planRows(rows: readonly PlanRow[], facts: PlanFacts): RowPlan[] {
  const used = new Set<string>();
  const requested = new Set<string>();
  return [...rows]
    .sort((a, b) => a.rowNo - b.rowNo)
    .filter((row) => row.group !== "error")
    .map((row) => planRow(row, facts, used, requested));
}

function planRow(
  row: PlanRow,
  facts: PlanFacts,
  used: Set<string>,
  requested: Set<string>,
): RowPlan {
  const itemId = finalItem(row);
  if (itemId === undefined || itemId === null) {
    if (row.decision === "skip")
      return { row, action: { kind: "skipped", unchecked: false }, remember: { decision: "skip" } };
    const notFound =
      row.decision === "not_in_catalog" || (row.decision === null && row.group === "not_found");
    if (!notFound) {
      // «Нужно проверить» left without a decision.
      return {
        row,
        action: { kind: "skipped", unchecked: row.group === "review" },
        remember: null,
      };
    }
    const remembered = row.source === "remembered_skip" || row.source === "remembered_absent";
    // Not in the catalog — by AI, by the search, by the supplier: the next
    // price list doesn't search and ask again (an exact article still comes
    // first, and an item made from the request is remembered over this).
    const remember: Remember =
      row.decision === "not_in_catalog" || !remembered ? { decision: "absent" } : { touch: true };
    const key = `${row.keyKind}:${row.key}`;
    if (!sendsRequest(row, facts.rejectedRequests.has(key))) {
      // «Не отправлять» chosen now: the row is the supplier's to skip — the
      // next price list doesn't offer to send it again by default.
      const skip: Remember = row.sendRequest === false ? { decision: "skip" } : remember;
      return { row, action: { kind: "skipped", unchecked: false }, remember: skip };
    }
    const created = !facts.openRequests.has(key) && !requested.has(key);
    requested.add(key);
    return { row, action: { kind: "request", created }, remember };
  }
  const notApplied = (reason: PriceRowNotAppliedReason, remember: Remember = null): RowPlan => ({
    row,
    action: { kind: "not_applied", reason, itemId },
    remember,
  });
  if (used.has(itemId)) return notApplied("duplicate_item");
  const refusal = itemRefusal(facts.items.get(itemId), facts.supplierType);
  if (refusal !== null) return notApplied(REFUSAL_REASON[refusal]);
  used.add(itemId);
  const remember: Remember =
    row.decision === "accept" || row.decision === "other"
      ? { decision: "item", itemId, by: "supplier" }
      : row.source === "exact_article" || row.source === "item_id"
        ? { decision: "item", itemId, by: "auto" }
        : row.source === "mapping"
          ? { touch: true }
          : null;
  const file = exportedOwnTexts(row, facts.items.get(itemId), facts.offers.get(itemId));
  const price = file.price!;
  const offer = facts.offers.get(itemId);
  if (!offer) {
    if (file.availability === "out_of_stock") return notApplied("out_of_stock", remember);
    const terms: OfferTerms = {
      availability: file.availability ?? "in_stock",
      leadDays: file.leadDays ?? 0,
      pickup: facts.pointHasAddress,
      delivery: facts.deliveryByDefault,
      warrantyMonths: null,
      warrantyText: null,
    };
    const problem = offerTermsProblem(price, terms, {
      service: false,
      limits: facts.limits,
      pickupNeedsAddress: false,
    });
    if (problem) return notApplied(problem.code, remember);
    return {
      row,
      action: {
        kind: "create",
        itemId,
        price,
        terms,
        change: {
          price,
          availability: terms.availability,
          leadDays: terms.leadDays,
          supplierSku: file.article,
          supplierRawName: file.name,
          status: "active",
          withdrawnReason: null,
        },
      },
      remember,
    };
  }
  if (sharpPriceChange(offer.price, price, facts.sharpPercent) && !row.priceConfirmed) {
    return notApplied("price_confirmation_required", remember);
  }
  const outOfStock = file.availability === "out_of_stock";
  const fileAvailability = file.availability === "out_of_stock" ? null : file.availability;
  const availability = fileAvailability ?? offer.availability;
  const leadDays = outOfStock ? offer.leadDays : (file.leadDays ?? offer.leadDays);
  const problem = offerTermsProblem(
    price,
    {
      availability,
      leadDays,
      pickup: offer.pickup,
      delivery: offer.delivery,
      warrantyMonths: offer.warrantyMonths,
      warrantyText: offer.warrantyText,
    },
    { service: false, limits: facts.limits, pickupNeedsAddress: false },
  );
  if (problem) return notApplied(problem.code, remember);
  // «нет в наличии» withdraws an offer on sale; a withdrawn one in stock again comes back.
  const withdrawn = outOfStock && offer.status === "active";
  const returned = !outOfStock && offer.status === "withdrawn";
  const change: OfferChange = {
    price,
    availability,
    leadDays,
    supplierSku: file.article ?? offer.supplierSku,
    supplierRawName: file.name ?? offer.supplierRawName,
    status: withdrawn ? "withdrawn" : returned ? "active" : offer.status,
    withdrawnReason: withdrawn ? "out_of_stock_in_import" : returned ? null : offer.withdrawnReason,
  };
  const same =
    change.price === offer.price &&
    change.availability === offer.availability &&
    change.leadDays === offer.leadDays &&
    change.supplierSku === offer.supplierSku &&
    change.supplierRawName === offer.supplierRawName &&
    change.status === offer.status;
  if (same) return { row, action: { kind: "unchanged", itemId, offer }, remember };
  return { row, action: { kind: "update", itemId, offer, change, returned, withdrawn }, remember };
}

/** The numbers of the button and of the summary, by the plan. */
export function planNumbers(plans: readonly RowPlan[]) {
  let update = 0;
  let create = 0;
  let withdraw = 0;
  let request = 0;
  let unchecked = 0;
  let priceConfirmationRequired = 0;
  for (const { action } of plans) {
    if (action.kind === "update") {
      if (action.withdrawn) withdraw++;
      else update++;
    } else if (action.kind === "create") create++;
    else if (action.kind === "request" && action.created) request++;
    else if (action.kind === "skipped" && action.unchecked) unchecked++;
    else if (action.kind === "not_applied" && action.reason === "price_confirmation_required") {
      priceConfirmationRequired++;
    }
  }
  return { update, create, withdraw, request, unchecked, priceConfirmationRequired };
}

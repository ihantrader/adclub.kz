import type { IconName, Tone } from "@adclub/ui-core";
import type {
  CatalogEntryStatus,
  CatalogItemStatus,
  CatalogRequestStatus,
  CategoryStatus,
  ClubAccessGrantStatus,
  CompatibilityProposalStatus,
  CompatibilityRecordStatus,
  ItemAnalogStatus,
  ItemPhotoStatus,
  OrderStatusValue,
  PriceImportStatus,
  ReviewStatusValue,
  SubscriptionStatusValue,
  SupplierInvitationStatus,
  SupplierLeadStatusValue,
  VehicleImportStatus,
} from "@adclub/contracts";

/** The role of a status: the background and color of its badge and its icon (DESIGN 7.7, 7.8). */
export interface StatusRole {
  tone: Tone;
  icon: IconName;
}

const done: StatusRole = { tone: "success", icon: "circleCheck" };
const waits: StatusRole = { tone: "warning", icon: "alertTriangle" };
const pending: StatusRole = { tone: "neutral", icon: "clock" };
const working: StatusRole = { tone: "accent", icon: "progressCheck" };
const over: StatusRole = { tone: "neutral", icon: "archive" };
const failed: StatusRole = { tone: "danger", icon: "circleX" };
const ready: StatusRole = { tone: "success", icon: "package" };

/**
 * One map «status → role» for every status the contract knows (TASK-080,
 * X7): «Активна», «Применён» — success; «Новый», «Неполная», «Ждёт» —
 * warning; «В архиве», «Отменён» — neutral (`fill`); «Ошибка» — danger;
 * the statuses of an order — by their groups of DESIGN 7.8 (outcomes are
 * neutral, never red). Each kind is typed by its contract enum, so a new
 * status of the contract does not compile without its role; the unit test
 * walks the zod enums themselves.
 */
export const statusRoles = {
  order: {
    created: pending,
    term_proposed: waits,
    accepted: working,
    ready,
    completed: over,
    cancelled_by_user: over,
    declined_by_supplier: over,
    response_expired: over,
    reserve_expired: over,
    cancelled_by_admin: over,
    term_expired: over,
    no_show: over,
    visit_unresolved: over,
  } satisfies Record<OrderStatusValue, StatusRole>,
  supplierLead: {
    new: waits,
    contacted: working,
    meeting: working,
    contract_signed: working,
    onboarded: done,
    rejected: over,
  } satisfies Record<SupplierLeadStatusValue, StatusRole>,
  supplier: {
    active: done,
    paused: { tone: "warning", icon: "clock" },
    blocked: { tone: "danger", icon: "lock" },
  } satisfies Record<"active" | "paused" | "blocked", StatusRole>,
  review: {
    checking: pending,
    held: waits,
    published: done,
    text_rejected: over,
    hidden: over,
  } satisfies Record<ReviewStatusValue, StatusRole>,
  complaint: {
    new: waits,
    in_progress: working,
    resolved: done,
  } satisfies Record<"new" | "in_progress" | "resolved", StatusRole>,
  signal: {
    open: waits,
    acknowledged: working,
    closed: over,
  } satisfies Record<"open" | "acknowledged" | "closed", StatusRole>,
  vehicleImport: {
    parsing: pending,
    ready: working,
    applying: pending,
    applied: done,
    cancelled: over,
    failed,
  } satisfies Record<VehicleImportStatus, StatusRole>,
  priceImport: {
    parsing: pending,
    columns: waits,
    reading: pending,
    parsed: pending,
    matching: pending,
    review: waits,
    applying: pending,
    applied: done,
    failed,
    expired: over,
  } satisfies Record<PriceImportStatus, StatusRole>,
  catalogItem: {
    draft: waits,
    active: done,
    archived: over,
  } satisfies Record<CatalogItemStatus, StatusRole>,
  category: {
    active: done,
    hidden: { tone: "neutral", icon: "lock" },
    archived: over,
  } satisfies Record<CategoryStatus, StatusRole>,
  /** Attributes, options, brands, cities, the vehicle catalog: active or archived. */
  entry: {
    active: done,
    archived: over,
  } satisfies Record<CatalogEntryStatus, StatusRole>,
  photo: {
    proposed: waits,
    approved: done,
    rejected: over,
    deleted: over,
  } satisfies Record<ItemPhotoStatus, StatusRole>,
  analog: {
    proposed: waits,
    approved: done,
  } satisfies Record<ItemAnalogStatus, StatusRole>,
  catalogRequest: {
    new: waits,
    approved: done,
    rejected: over,
  } satisfies Record<CatalogRequestStatus, StatusRole>,
  compatibilityProposal: {
    pending: waits,
    approved: done,
    rejected: over,
  } satisfies Record<CompatibilityProposalStatus, StatusRole>,
  compatibilityRecord: {
    approved: done,
    archived: over,
  } satisfies Record<CompatibilityRecordStatus, StatusRole>,
  offer: {
    active: done,
    withdrawn: over,
    suspended: waits,
  } satisfies Record<"active" | "withdrawn" | "suspended", StatusRole>,
  clubAccessGrant: {
    active: done,
    expired: over,
    revoked: over,
    replaced: over,
  } satisfies Record<ClubAccessGrantStatus, StatusRole>,
  subscription: {
    active: done,
    grace: waits,
    past_due: waits,
    cancelled: working,
    expired_unconfirmed: waits,
    suspended: waits,
    expired: over,
  } satisfies Record<SubscriptionStatusValue, StatusRole>,
  invitation: {
    queued: pending,
    sent: done,
    failed,
    cancelled: over,
  } satisfies Record<SupplierInvitationStatus, StatusRole>,
  translation: {
    missing: waits,
    queued: pending,
    failed,
    outdated: waits,
  } satisfies Record<"missing" | "queued" | "failed" | "outdated", StatusRole>,
  member: {
    active: done,
    removed: over,
  } satisfies Record<"active" | "removed", StatusRole>,
} as const;

export type StatusKind = keyof typeof statusRoles;

/** The statuses of one kind. */
export type StatusOf<K extends StatusKind> = keyof (typeof statusRoles)[K] & string;

/** The role of a status; an unknown one (a newer server) is a neutral badge, never a crash. */
export function statusRole<K extends StatusKind>(
  kind: K,
  status: StatusOf<K> | string,
): StatusRole {
  const roles = statusRoles[kind] as Record<string, StatusRole>;
  return roles[status] ?? pending;
}

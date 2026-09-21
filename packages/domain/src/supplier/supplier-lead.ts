/**
 * The funnel of connection requests (PRODUCT 12.1; SCREENS A-SUP-01;
 * ARCHITECTURE 4.26). A request is worked through `new → contacted →
 * meeting → contract_signed`, ends `onboarded` (the supplier was created
 * from it) or `rejected` (with a reason), and a rejected one may be taken
 * back into work.
 */

export const supplierLeadStatuses = [
  "new",
  "contacted",
  "meeting",
  "contract_signed",
  "onboarded",
  "rejected",
] as const;

export type SupplierLeadStatus = (typeof supplierLeadStatuses)[number];

/** The statuses a request is worked in; an administrator moves it freely among them. */
export const supplierLeadWorkingStatuses = [
  "new",
  "contacted",
  "meeting",
  "contract_signed",
] as const satisfies readonly SupplierLeadStatus[];

export type SupplierLeadWorkingStatus = (typeof supplierLeadWorkingStatuses)[number];

export function isWorkingLeadStatus(
  status: SupplierLeadStatus,
): status is SupplierLeadWorkingStatus {
  return (supplierLeadWorkingStatuses as readonly SupplierLeadStatus[]).includes(status);
}

export type SupplierLeadTransition =
  | { allowed: true; reasonRequired: boolean }
  | {
      allowed: false;
      /**
       * `onboarded_only_by_onboarding` — only creating the supplier from
       * the request sets it; `final` — an onboarded request never moves;
       * `same` — the request already has this status.
       */
      refusal: "onboarded_only_by_onboarding" | "final" | "same";
    };

/**
 * Whether an administrator may move a request from `from` to `to` by hand
 * (the status route). Among the working statuses any move is allowed — a
 * call can lead straight to a contract, and a mistake can be corrected; to
 * `rejected` from any working status, with a reason; from `rejected` back
 * to a working status, with a reason. `onboarded` is set only by creating
 * the supplier (`canOnboardLead`) and is final.
 */
export function supplierLeadTransition(
  from: SupplierLeadStatus,
  to: SupplierLeadStatus,
): SupplierLeadTransition {
  if (from === to) {
    return { allowed: false, refusal: "same" };
  }
  if (from === "onboarded") {
    return { allowed: false, refusal: "final" };
  }
  if (to === "onboarded") {
    return { allowed: false, refusal: "onboarded_only_by_onboarding" };
  }
  // Rejecting and returning to work both need a reason.
  return { allowed: true, reasonRequired: to === "rejected" || from === "rejected" };
}

/** A supplier is created from a request only once the contract is signed. */
export function canOnboardLead(status: SupplierLeadStatus): boolean {
  return status === "contract_signed";
}

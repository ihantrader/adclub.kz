import type { SupplierCard } from "@adclub/contracts";
import type { SupplierTextKey } from "@adclub/i18n";

/**
 * The banners every page of the cabinet shows for the company's state
 * (SCREENS 6.0). One list, so a later state (the card not bound, T-SUP-02,
 * stage C) is one more entry here rather than one more condition in every
 * page. Pause and blocking never close the cabinet: orders and handing out
 * keep working.
 */
export interface CompanyBanner {
  kind: "blocked" | "paused_admin" | "paused_billing";
  tone: "warning" | "danger";
  text: SupplierTextKey;
}

export function companyBanners(card: Pick<SupplierCard, "state" | "pause">): CompanyBanner[] {
  if (card.state === "blocked") {
    return [{ kind: "blocked", tone: "danger", text: "banner.blocked" }];
  }
  if (card.state === "paused" && card.pause) {
    return card.pause.reason === "billing"
      ? [{ kind: "paused_billing", tone: "warning", text: "banner.pausedBilling" }]
      : [{ kind: "paused_admin", tone: "warning", text: "banner.pausedAdmin" }];
  }
  return [];
}

/** The «Состояние» line of S-COMP-01. */
export function companyStateText(card: Pick<SupplierCard, "state">): SupplierTextKey {
  switch (card.state) {
    case "blocked":
      return "company.stateBlocked";
    case "paused":
      return "company.statePaused";
    default:
      return "company.stateActive";
  }
}

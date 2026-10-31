import type { SupplierCard } from "@adclub/contracts";
import { supplierMayInvite } from "@adclub/domain";
import type { SupplierTextKey } from "@adclub/i18n";

/**
 * The banners every page of the cabinet shows for the company's state
 * (SCREENS 6.0). One list, so a state is one more entry here rather than one
 * more condition in every page. Pause and blocking never close the cabinet:
 * orders and handing out keep working.
 *
 * **The two pauses are shown apart** (TASK-042, ARCHITECTURE 4.77): the
 * administrator's (T-SUP-05) and the unpaid subscription's (T-SUP-01, with
 * «Оплатить») can hold at once, and each has its own banner; paying lifts
 * only the second. A blocked company is blocked first — the administrator's
 * pause adds nothing to it — but it can still pay, so its billing pause keeps
 * the banner with the button. «Карта не привязана» (T-SUP-02, D-041) is the
 * third: offers are prepared, but not on the showcase until a card is linked.
 */
export interface CompanyBanner {
  kind: "blocked" | "paused_admin" | "paused_billing" | "card_missing";
  tone: "warning" | "danger";
  text: SupplierTextKey;
  /** The button of the banner, which leads to «Подписка»: «Оплатить», «Привязать карту». */
  action?: "pay" | "link_card";
}

export function companyBanners(
  card: Pick<SupplierCard, "state" | "pauses">,
  cardMissing = false,
): CompanyBanner[] {
  const banners: CompanyBanner[] = [];
  if (card.state === "blocked") {
    banners.push({ kind: "blocked", tone: "danger", text: "banner.blocked" });
  } else if (card.pauses.admin) {
    banners.push({ kind: "paused_admin", tone: "warning", text: "banner.pausedAdmin" });
  }
  if (card.pauses.billing) {
    banners.push({
      kind: "paused_billing",
      tone: "warning",
      text: "banner.pausedBilling",
      action: "pay",
    });
  } else if (cardMissing) {
    banners.push({
      kind: "card_missing",
      tone: "warning",
      text: "offers.cardBanner",
      action: "link_card",
    });
  }
  return banners;
}

/**
 * Whether «Добавить сотрудника» is offered (D-070): a blocked company adds
 * no employees. Only what the page shows — the server refuses the request
 * itself (`SUPPLIER_BLOCKED`), even from a page opened before the blocking.
 */
export function canAddMembers(card: Pick<SupplierCard, "state">): boolean {
  return supplierMayInvite({ blocked: card.state === "blocked" });
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

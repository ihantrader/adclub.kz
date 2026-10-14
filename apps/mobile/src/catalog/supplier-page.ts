import type { SupplierProfileResponse } from "@adclub/contracts";
import { orderGate, type OrderGate } from "../orders/order-gate";

/**
 * M-CAT-09 «Поставщик: рейтинг и отзывы» (TASK-050): what the screen shows,
 * only from what the server said. The rating, «Проверенный партнёр» and the
 * shares come to every viewer; the name and the reviews — only when the
 * server shows the supplier (club access). Otherwise «Отзывы видят участники
 * клуба» leads where «Оформить» does (`orderGate`): a guest signs in, an
 * account without a name finishes the registration, a member without club
 * access sees the stand-in sheet.
 */

/** What stands in place of the list of reviews. */
export type SupplierReviewsView =
  /** The reviews of the supplier (`GET /suppliers/{id}/reviews`). */
  | { kind: "list"; supplierId: string }
  /** «Отзывы видят участники клуба» with the way in. */
  | { kind: "members-only"; action: Exclude<OrderGate, "checkout"> };

export function supplierReviewsView(
  profile: Pick<SupplierProfileResponse, "supplier" | "viewer">,
  session: "guest" | "signed_in",
  registrationCompleted: boolean | null,
): SupplierReviewsView {
  if (profile.supplier.kind === "visible") {
    return { kind: "list", supplierId: profile.supplier.id };
  }
  const gate = orderGate({ session, registrationCompleted, viewer: profile.viewer });
  // The server hid the supplier: whatever the gate thinks, this viewer has
  // no club access by its word.
  return { kind: "members-only", action: gate === "checkout" ? "club-access" : gate };
}

/** The name, or `null` — «Поставщик клуба» (T-CAT-06). */
export function supplierName(profile: Pick<SupplierProfileResponse, "supplier">): string | null {
  return profile.supplier.kind === "visible" ? profile.supplier.name : null;
}

/**
 * «Отвечает на N% заявок» / «Соблюдает сроки в N% случаев»: the percent of
 * the server (a whole number), or «Мало заявок для оценки» (`null`).
 */
export function shareText(
  percent: number | null,
  words: { share: (n: number) => string; fewOrders: string },
): string {
  return percent === null ? words.fewOrders : words.share(percent);
}

/** «октябрь 2026»: the month a review was published in (`YYYY-MM`, the server's). */
export function reviewMonthText(publishedMonth: string, locale: string): string {
  const [year = 0, month = 1] = publishedMonth.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  try {
    return date.toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  } catch {
    return publishedMonth;
  }
}

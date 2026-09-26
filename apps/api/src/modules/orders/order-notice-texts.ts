import type { OfferSnapshot, OrderFulfillment, OrderStatusValue } from "@adclub/contracts";
import { localDateTime } from "@adclub/domain";

/**
 * The values that go into the notices of orders to suppliers (SCREENS 8.5,
 * W-01…W-04; TASK-025) — in the recipient's own language, Kazakh or Russian
 * (PRODUCT 12.6). Pure functions: what a supplier reads is decided here and
 * checked by unit tests.
 *
 * The template's text is fixed by Meta's approval; only these values vary.
 * A value is one line: WhatsApp refuses a parameter with a line break, a tab
 * or four spaces in a row, so every value is collapsed to single spaces.
 *
 * **The Kazakh wording is a working draft** written by a non-native speaker,
 * like the templates themselves (ARCHITECTURE 4.35 I368): the length is
 * checked, the grammar is not — a native speaker checks it before the
 * templates are submitted to Meta.
 */

export type NoticeLang = "kk" | "ru";

/** An item's name is cut here: the notice is a pointer to the cabinet, not the card. */
const ITEM_MAX_LENGTH = 120;

/** One line, no runs of spaces, no control characters. */
export function oneLine(value: string): string {
  return value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cut(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max
    ? value
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

/** The item of the order as the snapshot keeps it, in the recipient's language, with its article. */
export function itemText(item: OfferSnapshot["item"], lang: NoticeLang): string {
  const name = oneLine(item.names[lang] ?? item.names.ru ?? item.names.kk ?? item.names.en ?? "");
  const article = item.article ? oneLine(item.article) : "";
  const text = article && !name.includes(article) ? `${name} ${article}`.trim() : name;
  return cut(text || article || "—", ITEM_MAX_LENGTH);
}

/** Whole tenge with a space between the thousands: «24 500». */
export function moneyText(amount: number): string {
  return String(Math.trunc(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

const FULFILLMENT: Record<OrderFulfillment, Record<NoticeLang, string>> = {
  pickup: { ru: "самовывоз", kk: "өзі алып кету" },
  delivery: { ru: "доставка", kk: "жеткізу" },
};

export function fulfillmentText(fulfillment: OrderFulfillment, lang: NoticeLang): string {
  return FULFILLMENT[fulfillment][lang];
}

/**
 * A moment in the time zone of the pickup point: «18:30» when it is today
 * there, «27.09 18:30» otherwise — the deadline of a notice read late at
 * night must not look like the same evening.
 */
export function momentText(at: Date, timeZone: string, now: Date): string {
  const moment = localDateTime(at, timeZone);
  const today = localDateTime(now, timeZone).date;
  const hours = String(Math.floor(moment.minutes / 60)).padStart(2, "0");
  const minutes = String(moment.minutes % 60).padStart(2, "0");
  const time = `${hours}:${minutes}`;
  if (moment.date === today) {
    return time;
  }
  const [, month, day] = moment.date.split("-");
  return `${day ?? ""}.${month ?? ""} ${time}`;
}

/** A Kazakhstan number as people write it: «+7 701 123 45 67» (another stays as stored). */
export function phoneText(phone: string): string {
  const match = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return match ? `+7 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : phone;
}

/**
 * The customer's name in W-02. A user has no name in the club yet — the
 * profile comes with EPIC-10 (4.31 I317) — and the approved template has a
 * place for it, so the place says so rather than stay empty.
 */
export const CUSTOMER_NAME_UNKNOWN: Record<NoticeLang, string> = {
  ru: "имя не указано",
  kk: "аты көрсетілмеген",
};

/** What the order is now, for W-03 «Заявка № {номер} уже {state}. Статус не изменён». */
export interface OrderStateFacts {
  status: OrderStatusValue;
  /** The employee who accepted or declined it, and when. */
  handledBy: string | null;
  handledAt: Date | null;
  timeZone: string;
}

export function orderStateText(order: OrderStateFacts, lang: NoticeLang, now: Date): string {
  const who = (verb: Record<NoticeLang, string>) =>
    order.handledBy && order.handledAt
      ? `${verb[lang]}: ${cut(oneLine(order.handledBy), 60)}, ${momentText(order.handledAt, order.timeZone, now)}`
      : verb[lang];
  switch (order.status) {
    case "accepted":
    case "ready":
      return who({ ru: "принята", kk: "қабылданған" });
    case "declined_by_supplier":
      return who({ ru: "отклонена", kk: "қабылданбаған" });
    case "completed":
      return lang === "kk" ? "берілген" : "выдана";
    case "cancelled_by_user":
      return lang === "kk" ? "клиент бас тартқан" : "отменена клиентом";
    case "response_expired":
    case "reserve_expired":
      return lang === "kk" ? "мерзімі өткен" : "истекла";
    case "created":
      return lang === "kk" ? "жауап күтуде" : "ждёт ответа";
  }
}

/** W-03 to an employee who is no longer one: nothing about the order, only that the door is shut. */
export const ACCESS_CLOSED_TEXT: Record<NoticeLang, string> = {
  ru: "недоступна: доступ к кабинету закрыт",
  kk: "қолжетімсіз: кабинетке кіру жабылған",
};

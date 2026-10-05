import type { OrderFulfillment } from "@adclub/contracts";
import type { NavigatorScreenParams } from "@react-navigation/native";
import type { CarColorId } from "../garage/car-color";
import type { CarDraft } from "../garage/car-picker";

/**
 * The screens of the app and what they take (TASK-027, TASK-028, TASK-028.A).
 *
 * One **root stack** holds the first run, the tabs and the steps of choosing
 * a car; the catalog and the garage have stacks of their own inside their
 * tabs (ARCHITECTURE 4.37 I384, 4.39). The steps sit in the root stack, above
 * the tabs, so they open over whichever tab asked for them, «назад» and
 * saving return to it, and the first run uses the very same screens.
 */

export type CatalogStackParams = {
  /** M-CAT-01. */
  "catalog-home": undefined;
  /**
   * M-CAT-10: the subcategories of a node. `title` is the name the previous
   * screen already showed, so the top bar does not read «Каталог» while the
   * screen slides in and the real name arrives with the data.
   */
  "catalog-node": { categoryId: string; title?: string };
  /** M-CAT-02: the items of a subcategory. */
  "catalog-items": { categoryId: string; title?: string };
  /**
   * M-CAT-07. `notice` — why the card was opened by «Повторить заказ»
   * instead of the checkout (TASK-030): the offer was withdrawn, or the
   * supplier is not taking orders now.
   */
  "catalog-item": {
    itemId: string;
    title?: string;
    notice?: "offer_withdrawn" | "supplier_unavailable";
  };
};

export type GarageStackParams = {
  /** M-GAR-01. */
  "garage-list": undefined;
  /** M-GAR-06. */
  "garage-car": { carId: string };
};

export type ProfileStackParams = {
  /** M-PRO-01. */
  "profile-home": undefined;
  /** M-PRO-02. */
  "profile-my-data": undefined;
  /** M-PRO-03. */
  "profile-devices": undefined;
};

export type TabParams = {
  catalog: NavigatorScreenParams<CatalogStackParams> | undefined;
  orders: undefined;
  garage: NavigatorScreenParams<GarageStackParams> | undefined;
  profile: NavigatorScreenParams<ProfileStackParams> | undefined;
};

export type TabName = keyof TabParams;

/**
 * One screen of the step-by-step choice of a car (M-GAR-03). A step is a
 * screen of the stack, so the system «назад» — the arrow, the edge swipe,
 * the Android button — returns to the previous step, one at a time.
 *
 * `draft` is what had been decided when this screen opened: plain ids and
 * labels, the whole of its state. The screen asks for the first level the
 * draft lacks, and a step that is asked next is a `push` of the same route
 * with the chosen value added — so going back is just the route underneath.
 */
export interface CarStepParams {
  /** Where the choice began: the first run ends with the car, the app returns where it came from. */
  origin: "first-run" | "app";
  /** A car of the garage being completed or edited. */
  carId?: string;
  draft: CarDraft;
}

/**
 * The final step (TASK-028.B, requirement 3): every level of `draft`, set or
 * not, plus the colour (D-063) — never itself a level of `CarDraft`, since it
 * is not part of the vehicle catalog and does not gate anything below it.
 * The screen this opens does not know whether a value here was chosen by
 * hand, taken automatically, or (TASK-057, later) read off a photographed
 * техпаспорт — it only shows what it is given and lets any of it be changed.
 */
export interface CarSummaryParams {
  origin: "first-run" | "app";
  carId?: string;
  draft: CarDraft;
  color: CarColorId | null;
}

/**
 * The sign-in flow (TASK-029, SCREENS M-AUTH-01…03), pushed above whichever
 * tab asked for it (`use-sign-in.ts`), exactly like the steps of choosing a
 * car — «назад» from the first screen and finishing both return to it.
 */
export type AuthStackParams = {
  /** M-AUTH-01. */
  "auth-phone": undefined;
  /**
   * M-AUTH-02. `channel` — which one the code was actually sent by (WhatsApp
   * unavailable falls back to SMS, T-AUTH-02); the rest is `requestLoginCode`'s
   * answer, so the screen doesn't send a second code just to learn them.
   */
  "auth-code": {
    phone: string;
    channel: "whatsapp" | "sms";
    codeLength: number;
    resendAvailableAt: string;
  };
  /** M-AUTH-03: the account exists (the code is verified) but has no name yet. */
  "auth-register": undefined;
};

/**
 * M-ORD-01 (TASK-030): the checkout of one offer of an item. The screen
 * loads the card of the item itself, so the price, the dates and the
 * supplier are the ones of now, not of the screen it came from. `preset` —
 * what «Повторить заказ» fills in from the finished order;
 * `previousPrice` — its price, to say «Цена изменилась».
 */
export interface CheckoutParams {
  itemId: string;
  offerId: string;
  preset?: { quantity: number; fulfillment: OrderFulfillment };
  previousPrice?: number;
}

/** The order screens (TASK-030). The code is never a parameter — it is read from the order or the copy. */
export type OrderStackParams = {
  /** M-ORD-01. */
  "order-checkout": CheckoutParams;
  /** M-ORD-03. */
  order: { orderId: string };
  /** M-ORD-04. */
  "order-qr": { orderId: string };
  /** M-ORD-02 «только просмотр» after M-START-03 (D-027): the copy, nothing that needs the server. */
  "orders-readonly": undefined;
};

export type RootParams = {
  /** M-START-04. */
  "first-run-city": undefined;
  /** M-START-05. */
  "first-run-car": undefined;
  tabs: NavigatorScreenParams<TabParams> | undefined;
  /** M-GAR-03. */
  "car-step": CarStepParams;
  /** M-GAR-03, final step. */
  "car-summary": CarSummaryParams;
} & AuthStackParams &
  OrderStackParams;

/** The id of the root navigator: `navigation.getParent(ROOT_NAVIGATOR)` finds it from any screen. */
export const ROOT_NAVIGATOR = "root";

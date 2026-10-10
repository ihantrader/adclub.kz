import type {
  ActiveOrder,
  OrderConfirmation,
  OrderFulfillment,
  OrderGivenOut,
  OnOrderTerm,
  OrderItemWithPhoto,
  OrderKind,
  OrderStatusValue,
  ServiceVisit,
  UserOrder,
  UserOrderStep,
} from "@adclub/contracts";
import { isActiveStatus } from "./order-status";

type PickupPoint = NonNullable<UserOrder["pickupPoint"]>;

/**
 * One order as the screens show it (M-ORD-03, M-ORD-04), whichever of the
 * two answers of the server it came from: the order itself
 * (`GET /orders/{id}`, with its course) or its entry in the saved copy
 * (`GET /active-orders`, without a network). Only fields are moved here —
 * nothing is worked out that the server did not say.
 */
export interface OrderView {
  id: string;
  number: number;
  status: OrderStatusValue;
  fulfillment: OrderFulfillment;
  quantity: number;
  unitPrice: number;
  total: number;
  /** With the item's photo of the catalog now (TASK-030.A); `null` — the placeholder. */
  item: OrderItemWithPhoto;
  supplier: { id: string; name: string; cityName: string; district: string | null };
  /** Only once the supplier accepted (D-026) — and only as the server gave it. */
  pickupPoint: PickupPoint | null;
  /** The code and the QR — only while the order is active, only for its user. */
  confirmation: OrderConfirmation | null;
  respondBy: string;
  reserveUntil: string | null;
  givenOut: OrderGivenOut | null;
  /** TASK-037: an item in stock or under order, and the term of the latter (`null` — in stock). */
  kind: OrderKind;
  onOrderTerm: OnOrderTerm | null;
  /** TASK-038: the car and the time of a visit for a service (`null` — goods). */
  serviceVisit: ServiceVisit | null;
  /** «Ход заявки»; `null` — the copy does not carry it (it is not needed without a network). */
  history: UserOrderStep[] | null;
  /** Accepted or ready: the code is to be shown, the QR may go full-screen. */
  awaitsReceipt: boolean;
  updatedAt: string;
  source: "server" | "copy";
}

export function orderViewOfServer(order: UserOrder): OrderView {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    fulfillment: order.fulfillment,
    quantity: order.quantity,
    unitPrice: order.unitPrice,
    total: order.total,
    item: order.item,
    supplier: order.supplier,
    pickupPoint: order.pickupPoint ?? null,
    // The server gives the code only while the order is active; a final
    // order with one would be a server mistake, and the code is not shown.
    confirmation: isActiveStatus(order.status) ? (order.confirmation ?? null) : null,
    respondBy: order.respondBy,
    reserveUntil: order.reserveUntil,
    givenOut: order.givenOut,
    kind: order.kind,
    onOrderTerm: order.onOrderTerm,
    serviceVisit: order.serviceVisit ?? null,
    history: order.history,
    awaitsReceipt: order.status === "accepted" || order.status === "ready",
    updatedAt: order.updatedAt,
    source: "server",
  };
}

export function orderViewOfCopy(order: ActiveOrder): OrderView {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    fulfillment: order.fulfillment,
    quantity: order.quantity,
    unitPrice: order.unitPrice,
    total: order.total,
    item: order.item,
    supplier: order.supplier,
    pickupPoint: order.pickupPoint ?? null,
    confirmation: order.confirmation,
    respondBy: order.respondBy,
    reserveUntil: order.reserveUntil,
    givenOut: null,
    // A copy saved by a version before TASK-037 has neither: an order in stock.
    kind: (order.kind as OrderKind | undefined) ?? "stock",
    onOrderTerm: (order.onOrderTerm as OnOrderTerm | null | undefined) ?? null,
    // A copy saved before TASK-038 has none.
    serviceVisit: (order.serviceVisit as ServiceVisit | null | undefined) ?? null,
    history: null,
    awaitsReceipt: order.awaitsReceipt,
    updatedAt: order.updatedAt,
    source: "copy",
  };
}

import type { SupplierState } from "../supplier/supplier-state";
import type { OrderAction } from "./order-machine";

/**
 * What an employee of a company may do to an order, given the state of the
 * company and the channel the move comes through (TASK-033.A; SCREENS 6.0;
 * ARCHITECTURE 4.51). **The one place this is decided**: the state machine
 * of the server asks it for every move of an employee, from the cabinet and
 * from the buttons of WhatsApp alike, and the cabinet hides the buttons by
 * the same table.
 *
 * - **Blocked** (SCREENS 6.0): the company looks at its orders and gives them
 *   out by the code or the QR — late too (PRODUCT 10.7: the customer came,
 *   the goods are in their hands); it no longer takes orders on, marks them
 *   ready or declines them.
 * - **Paused** (by the administrator or for the subscription) changes nothing
 *   here: the pause takes the offers off the showcase, the orders already
 *   placed are served to the end (PRODUCT 13, 14).
 * - The channel: the buttons of W-01 are «Подтвердить» and «Отказать» only;
 *   every other move of an employee is made in the cabinet.
 *
 * Looking at orders and finding one by its code are not moves: they are
 * open in every state.
 */

/** The channels an employee acts through. */
export const supplierOrderChannels = ["supplier_web", "whatsapp"] as const;

export type SupplierOrderChannel = (typeof supplierOrderChannels)[number];

/** The moves an employee makes (`orderActionActor` — `supplier`). */
export const supplierOrderMoves = [
  "accept",
  "decline",
  "mark_ready",
  "close",
  "close_late",
  // TASK-037: another term for an order under order — from the cabinet only
  // (S-ORD-04; W-01a has «Подтвердить срок» and «Отказать»).
  "propose_term",
  // TASK-038: another time of a service and a no-show — from the cabinet only
  // (W-01b has «Подтвердить время» and «Отказать»).
  "propose_time",
  "mark_no_show",
] as const satisfies readonly OrderAction[];

export type SupplierOrderMove = (typeof supplierOrderMoves)[number];

const channelMoves: Record<SupplierOrderChannel, readonly SupplierOrderMove[]> = {
  supplier_web: supplierOrderMoves,
  whatsapp: ["accept", "decline"],
};

/** What a blocked company still does: gives out what the customer came for. */
const blockedMoves: readonly SupplierOrderMove[] = ["close", "close_late"];

/**
 * `allowed`; `supplier_blocked` — the company is blocked and this move is not
 * one it keeps; `not_in_channel` — the channel has no such move (a button of
 * WhatsApp that marks an order ready does not exist).
 */
export type SupplierOrderMoveVerdict = "allowed" | "supplier_blocked" | "not_in_channel";

export function supplierOrderMoveVerdict(
  state: SupplierState,
  action: OrderAction,
  channel: SupplierOrderChannel,
): SupplierOrderMoveVerdict {
  if (!(channelMoves[channel] as readonly OrderAction[]).includes(action)) {
    return "not_in_channel";
  }
  if (state === "blocked" && !(blockedMoves as readonly OrderAction[]).includes(action)) {
    return "supplier_blocked";
  }
  return "allowed";
}

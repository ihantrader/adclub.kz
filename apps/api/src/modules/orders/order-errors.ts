import type {
  OrderDuplicateActiveDetails,
  OrderPriceChangedDetails,
  OrderStateConflictDetails,
} from "@adclub/contracts";
import { ApiException } from "../../common/errors";

/**
 * Contract errors of orders (ARCHITECTURE 4.31). None of them carries the
 * confirmation code, the QR or a phone number — not in the message, not in
 * `details`.
 */

export function notFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "No such order");
}

export function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

export function subscriptionRequired(): ApiException {
  return new ApiException(
    403,
    "SUBSCRIPTION_REQUIRED",
    "Only members of the club order: club access is needed",
  );
}

/**
 * 403 `REGISTRATION_INCOMPLETE` (TASK-029, ARCHITECTURE 4.41): the account
 * has no name and consent yet (SCREENS M-AUTH-03) — checked before club
 * access, since a name is more fundamental than a subscription: without one
 * the account isn't a club member at all, whatever its subscription is.
 */
export function registrationIncomplete(): ApiException {
  return new ApiException(
    403,
    "REGISTRATION_INCOMPLETE",
    "Finish registration (a name and the phone-share consent) before ordering",
  );
}

/**
 * 403 `SUPPLIER_BLOCKED` (TASK-033.A, ARCHITECTURE 4.51): a blocked company
 * looks at its orders and gives them out by the code, nothing more
 * (SCREENS 6.0; the rule — `supplierOrderMoveVerdict`).
 */
export function supplierBlocked(): ApiException {
  return new ApiException(
    403,
    "SUPPLIER_BLOCKED",
    "The company is blocked by the club administrator: orders can be viewed and given out by the code, not accepted, marked ready or declined",
  );
}

export function offerUnavailable(): ApiException {
  return new ApiException(
    409,
    "ORDER_OFFER_UNAVAILABLE",
    "The offer isn't available any more: look at the other offers of the item",
  );
}

export function kindNotSupported(): ApiException {
  return new ApiException(
    409,
    "ORDER_KIND_NOT_SUPPORTED",
    "This action is not one of an order of this kind",
  );
}

/** TASK-038: a no-show is marked from the time of the visit on, not before. */
export function noShowTooEarly(visitAt: Date): ApiException {
  return new ApiException(
    409,
    "ORDER_NO_SHOW_TOO_EARLY",
    "The time of the visit has not come yet: a no-show is marked from it on",
    { details: { visitAt: visitAt.toISOString() } },
  );
}

export function fulfillmentUnavailable(): ApiException {
  return new ApiException(
    409,
    "ORDER_FULFILLMENT_UNAVAILABLE",
    "The offer doesn't give this way to get the item",
  );
}

export function priceChanged(expectedPrice: number, currentPrice: number): ApiException {
  const details: OrderPriceChangedDetails = { expectedPrice, currentPrice };
  return new ApiException(409, "ORDER_PRICE_CHANGED", "The price of the offer changed", {
    details,
  });
}

export function duplicateActive(existingOrderId: string, number: number): ApiException {
  const details: OrderDuplicateActiveDetails = { existingOrderId, number };
  return new ApiException(
    409,
    "ORDER_DUPLICATE_ACTIVE",
    "There is an active order on this offer already: open it, or confirm another one",
    { details },
  );
}

export function idempotencyMismatch(): ApiException {
  return new ApiException(
    409,
    "ORDER_IDEMPOTENCY_MISMATCH",
    "This key was used for another order: make a new key for a new order",
  );
}

export function stateConflict(details: OrderStateConflictDetails): ApiException {
  return new ApiException(
    409,
    "ORDER_STATE_CONFLICT",
    "The order is no longer where the action expected it; nothing changed",
    { details },
  );
}

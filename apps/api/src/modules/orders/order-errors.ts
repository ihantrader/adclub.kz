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
    "Orders of items under order come later; this offer can't be ordered yet",
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

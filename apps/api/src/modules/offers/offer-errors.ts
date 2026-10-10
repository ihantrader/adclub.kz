import type {
  OfferExistsDetails,
  OfferNotApplicableDetails,
  OfferStateDetails,
  OfferStatusValue,
  OfferVersionConflictDetails,
  OfferWarrantyContactsDetails,
} from "@adclub/contracts";
import { ApiException } from "../../common/errors";

/** Contract errors of offers (ARCHITECTURE 4.28). */

export function notFound(what: string): ApiException {
  return new ApiException(404, "NOT_FOUND", `No such ${what}`);
}

/**
 * `bounds` — the working range of a price or a term (settings, TASK-018
 * I281), so the cabinet names it in its own language (TASK-032).
 */
export function validationError(
  path: string,
  message: string,
  bounds?: { min: number; max: number },
): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, {
    details: [{ path, message, ...bounds }],
  });
}

export function offerExists(existingOfferId: string, status: OfferStatusValue): ApiException {
  const details: OfferExistsDetails = { existingOfferId, status };
  return new ApiException(
    409,
    "OFFER_EXISTS",
    status === "withdrawn"
      ? "The company already has an offer on this item, withdrawn: return it to sale instead"
      : "The company already has an offer on this item",
    { details },
  );
}

export function versionConflict(currentVersion: number): ApiException {
  const details: OfferVersionConflictDetails = { currentVersion };
  return new ApiException(
    409,
    "OFFER_VERSION_CONFLICT",
    "The offer was changed by someone else; reload it and decide again",
    { details },
  );
}

export function offerState(status: OfferStatusValue, action: "withdraw" | "return"): ApiException {
  const details: OfferStateDetails = { status };
  return new ApiException(
    409,
    "OFFER_STATE",
    action === "withdraw" ? "The offer isn't on sale" : "The offer isn't withdrawn",
    { details },
  );
}

export function pickupNeedsAddress(): ApiException {
  return new ApiException(
    409,
    "OFFER_PICKUP_NEEDS_ADDRESS",
    "Pickup needs the address of the pickup point: fill it in on the company card first",
  );
}

export function notApplicable(
  supplierType: OfferNotApplicableDetails["supplierType"],
  itemType: OfferNotApplicableDetails["itemType"],
): ApiException {
  const details: OfferNotApplicableDetails = { supplierType, itemType };
  return new ApiException(
    409,
    "OFFER_NOT_APPLICABLE",
    supplierType === "goods"
      ? "The company offers goods only: it puts no offers on services"
      : "The company offers services only: it puts no offers on goods",
    { details },
  );
}

export function itemUnavailable(): ApiException {
  return new ApiException(
    409,
    "OFFER_ITEM_UNAVAILABLE",
    "The item is no longer active in the catalog: the offer stays, but can't go back on sale",
  );
}

export function warrantyContacts(found: OfferWarrantyContactsDetails["found"]): ApiException {
  const details: OfferWarrantyContactsDetails = { found };
  return new ApiException(
    400,
    "OFFER_WARRANTY_CONTACTS",
    "The company's name and contacts don't go in the warranty: a user sees them once the order is accepted. Remove the phone, link or e-mail",
    { details },
  );
}

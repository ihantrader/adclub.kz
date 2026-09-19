import type {
  CatalogAnalogInvalidDetails,
  CatalogBrandSpellingTakenDetails,
  CatalogItemDuplicateDetails,
  CatalogLanguage,
  CatalogNameTakenDetails,
  CatalogOrderConflictDetails,
  CatalogValueRejection,
  CatalogValuesRejectedDetails,
  CatalogVersionConflictDetails,
} from "@adclub/contracts";
import { ApiException } from "../../common/errors";

/** Contract errors of the catalog structure (ARCHITECTURE 4.15). */

export function notFound(what: string): ApiException {
  return new ApiException(404, "NOT_FOUND", `No such ${what}`);
}

export function versionConflict(currentVersion: number): ApiException {
  const details: CatalogVersionConflictDetails = { currentVersion };
  return new ApiException(
    409,
    "CATALOG_VERSION_CONFLICT",
    "It was changed by someone else; reload it and decide again",
    { details },
  );
}

export function codeTaken(): ApiException {
  return new ApiException(409, "CATALOG_CODE_TAKEN", "This code is already used");
}

export function nameTaken(lang: CatalogLanguage, conflictingId: string): ApiException {
  const details: CatalogNameTakenDetails = { lang, conflictingId };
  return new ApiException(
    409,
    "CATALOG_NAME_TAKEN",
    "A neighbour already has this name (case is ignored)",
    { details },
  );
}

export function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, {
    details: [{ path, message }],
  });
}

export function depthExceeded(): ApiException {
  return new ApiException(
    400,
    "CATALOG_DEPTH_EXCEEDED",
    "A subcategory can't have subcategories: there are two levels only",
  );
}

export function kindMismatch(): ApiException {
  return new ApiException(
    400,
    "CATALOG_KIND_MISMATCH",
    "A subcategory is of the same kind as its node, and a kind never changes",
  );
}

export function levelImmutable(): ApiException {
  return new ApiException(
    400,
    "CATALOG_LEVEL_IMMUTABLE",
    "A node stays a node and a subcategory stays a subcategory",
  );
}

export function parentArchived(): ApiException {
  return new ApiException(
    409,
    "CATALOG_PARENT_ARCHIVED",
    "The node is archived: restore it or choose another one first",
  );
}

export function notSubcategory(): ApiException {
  return new ApiException(400, "CATALOG_NOT_SUBCATEGORY", "Only a subcategory has attributes");
}

export function attributeTypeImmutable(): ApiException {
  return new ApiException(
    400,
    "CATALOG_ATTRIBUTE_TYPE_IMMUTABLE",
    "The value type of an attribute never changes: archive it and create another one",
  );
}

export function orderMismatch(): ApiException {
  return new ApiException(
    409,
    "CATALOG_ORDER_MISMATCH",
    "The new order must name every sibling exactly once; reload and try again",
  );
}

export function orderConflict(currentOrder: readonly string[]): ApiException {
  const details: CatalogOrderConflictDetails = { currentOrder: [...currentOrder] };
  return new ApiException(
    409,
    "CATALOG_ORDER_CONFLICT",
    "The order was changed by someone else; reload it and decide again",
    { details },
  );
}

// ------------------------------------------------------------ items (TASK-011)

export function brandSpellingTaken(spelling: string, conflictingBrandId: string): ApiException {
  const details: CatalogBrandSpellingTakenDetails = { spelling, conflictingBrandId };
  return new ApiException(
    409,
    "CATALOG_BRAND_SPELLING_TAKEN",
    "Another brand already has this name or spelling (case and spaces are ignored)",
    { details },
  );
}

export function brandArchived(): ApiException {
  return new ApiException(
    409,
    "CATALOG_BRAND_ARCHIVED",
    "The brand is archived: restore it or choose another one",
  );
}

export function categoryArchived(): ApiException {
  return new ApiException(
    409,
    "CATALOG_CATEGORY_ARCHIVED",
    "The subcategory (or its node) is archived and takes no items",
  );
}

/**
 * The unique key refused a brand's spelling or an item's article twice, and
 * both times the row that took it was gone by the time it was looked for
 * (the other change was rolled back or changed it again meanwhile;
 * TASK-011.A): nothing was written, repeating the request decides it.
 */
export function uniqueRace(): ApiException {
  return new ApiException(
    409,
    "CONFLICT",
    "Another change took the same name or article at the same moment; repeat the request",
    { retryable: true },
  );
}

export function itemDuplicate(existingItemId: string): ApiException {
  const details: CatalogItemDuplicateDetails = { existingItemId };
  return new ApiException(409, "CATALOG_ITEM_DUPLICATE", "This item already exists", { details });
}

export function itemTypeImmutable(): ApiException {
  return new ApiException(
    400,
    "CATALOG_ITEM_TYPE_IMMUTABLE",
    "The type of an item never changes: create another item instead",
  );
}

export function itemHasAnalogs(): ApiException {
  return new ApiException(
    409,
    "CATALOG_ITEM_HAS_ANALOGS",
    "An item with analogs stays in its subcategory: remove the links first",
  );
}

export function valuesRejected(rejections: CatalogValueRejection[]): ApiException {
  const details: CatalogValuesRejectedDetails = { rejections };
  const conflict = rejections.some((rejection) => rejection.reason === "conflict");
  return new ApiException(
    conflict ? 409 : 400,
    "CATALOG_VALUES_REJECTED",
    conflict
      ? "Some values were changed by someone else meanwhile; nothing was written"
      : "Some values can't be written; nothing was written",
    { details },
  );
}

export function analogInvalid(reason: CatalogAnalogInvalidDetails["reason"]): ApiException {
  const details: CatalogAnalogInvalidDetails = { reason };
  const messages: Record<CatalogAnalogInvalidDetails["reason"], string> = {
    self: "An item is not its own analog",
    not_part: "Only parts are linked as analogs",
    other_category: "Analogs are parts of one subcategory",
    archived: "An archived item takes no new links",
  };
  return new ApiException(400, "CATALOG_ANALOG_INVALID", messages[reason], { details });
}

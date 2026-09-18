import type {
  CatalogLanguage,
  CatalogNameTakenDetails,
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

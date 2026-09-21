import type {
  VehicleDuplicateDetails,
  VehicleEntity,
  VehicleImportFileInvalidDetails,
  VehicleImportStateDetails,
  VehicleImportStatus,
  VehicleReferenceArchivedDetails,
  VehicleVersionConflictDetails,
  VehicleYearsInvalidDetails,
} from "@adclub/contracts";
import { ApiException } from "../../common/errors";

/** Contract errors of the vehicle catalog (ARCHITECTURE 4.24). */

export function notFound(what: string): ApiException {
  return new ApiException(404, "NOT_FOUND", `No such ${what}`);
}

export function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

export function versionConflict(currentVersion: number): ApiException {
  const details: VehicleVersionConflictDetails = { currentVersion };
  return new ApiException(
    409,
    "VEHICLE_VERSION_CONFLICT",
    "It was changed by someone else; reload it and decide again",
    { details },
  );
}

const DUPLICATE_MESSAGES: Record<VehicleEntity, string> = {
  option: "An option of this list already has this code or name (case is ignored)",
  make: "Another make already has this name or spelling (case and spaces are ignored)",
  model: "Another model of this make already has this name or spelling",
  generation: "The model already has a generation with this name (case is ignored)",
  engine: "Another engine already has this code or spelling (case and spaces are ignored)",
  modification:
    "The generation already has a modification with this body, engine, transmission, drive and years",
};

export function duplicate(
  entity: VehicleEntity,
  existingId: string,
  spelling: string | null = null,
): ApiException {
  const details: VehicleDuplicateDetails = { entity, existingId, spelling };
  return new ApiException(409, "VEHICLE_DUPLICATE", DUPLICATE_MESSAGES[entity], { details });
}

export function parentArchived(what: string): ApiException {
  return new ApiException(
    409,
    "VEHICLE_PARENT_ARCHIVED",
    `The ${what} is archived: restore it or choose another one first`,
  );
}

export function referenceArchived(field: string): ApiException {
  const details: VehicleReferenceArchivedDetails = { field };
  return new ApiException(
    409,
    "VEHICLE_REFERENCE_ARCHIVED",
    "An archived record can't be chosen: restore it or choose another one",
    { details },
  );
}

export function yearsInvalid(details: VehicleYearsInvalidDetails): ApiException {
  const messages: Record<VehicleYearsInvalidDetails["reason"], string> = {
    order: "The last year is before the first one",
    outside_generation: "The years of a modification must lie within its generation's",
    modifications_outside: "The new years leave out some modifications of the generation",
  };
  return new ApiException(400, "VEHICLE_YEARS_INVALID", messages[details.reason], { details });
}

export function importFileInvalid(
  reason: VehicleImportFileInvalidDetails["reason"],
  message: string,
  extra: Partial<Omit<VehicleImportFileInvalidDetails, "reason">> = {},
): ApiException {
  const details: VehicleImportFileInvalidDetails = {
    reason,
    detected: extra.detected ?? null,
    columns: extra.columns ?? [],
    line: extra.line ?? null,
    limit: extra.limit ?? null,
  };
  return new ApiException(400, "VEHICLE_IMPORT_FILE_INVALID", message, { details });
}

export function importState(status: VehicleImportStatus, message: string): ApiException {
  const details: VehicleImportStateDetails = { status };
  return new ApiException(409, "VEHICLE_IMPORT_STATE", message, { details });
}

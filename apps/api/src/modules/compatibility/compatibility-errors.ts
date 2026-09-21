import {
  compatibilityConditionsInvalidReasonSchema,
  compatibilityVehicleInvalidReasonSchema,
  type CompatibilityConditionsInvalidDetails,
  type CompatibilityDuplicateDetails,
  type CompatibilityProposalStateDetails,
  type CompatibilityProposalStatus,
  type CompatibilityVehicleInvalidDetails,
  type CompatibilityVersionConflictDetails,
} from "@adclub/contracts";
import type { z } from "zod";
import { ApiException } from "../../common/errors";

/** Contract errors of compatibility (ARCHITECTURE 4.25). */

type ConditionsReason = z.infer<typeof compatibilityConditionsInvalidReasonSchema>;
type VehicleReason = z.infer<typeof compatibilityVehicleInvalidReasonSchema>;

const CONDITIONS_MESSAGES: Record<ConditionsReason, string> = {
  not_found: "No such record in the vehicle catalog",
  model_of_other_make: "The model is of another make",
  generation_of_other_model: "The generation is of another model",
  years_order: "The last year is before the first one",
  years_outside_generation: "The years are outside the years of the generation",
};

const VEHICLE_MESSAGES: Record<VehicleReason, string> = {
  not_found: "No such record in the vehicle catalog",
  make_required: "The car needs at least a make (or a model, a generation, a modification)",
  model_of_other_make: "The model is of another make",
  generation_of_other_model: "The generation is of another model",
  modification_mismatch: "The level differs from the one of the modification",
  year_outside: "The year is outside the years of the generation or the modification",
};

export function notFound(what: string): ApiException {
  return new ApiException(404, "NOT_FOUND", `No such ${what}`);
}

export function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

export function conditionsInvalid(reason: ConditionsReason, field: string): ApiException {
  const details: CompatibilityConditionsInvalidDetails = { reason, field };
  return new ApiException(400, "COMPATIBILITY_CONDITIONS_INVALID", CONDITIONS_MESSAGES[reason], {
    details,
  });
}

export function vehicleInvalid(reason: VehicleReason, field: string): ApiException {
  const details: CompatibilityVehicleInvalidDetails = { reason, field };
  return new ApiException(400, "COMPATIBILITY_VEHICLE_INVALID", VEHICLE_MESSAGES[reason], {
    details,
  });
}

export function versionConflict(currentVersion: number): ApiException {
  const details: CompatibilityVersionConflictDetails = { currentVersion };
  return new ApiException(
    409,
    "COMPATIBILITY_VERSION_CONFLICT",
    "It was changed by someone else; reload it and decide again",
    { details },
  );
}

export function duplicate(existingId: string): ApiException {
  const details: CompatibilityDuplicateDetails = { existingId };
  return new ApiException(
    409,
    "COMPATIBILITY_DUPLICATE",
    "The item already has an approved record with these conditions",
    { details },
  );
}

export function notApplicable(): ApiException {
  return new ApiException(
    409,
    "COMPATIBILITY_NOT_APPLICABLE",
    "Compatibility is kept for parts and products, not for services",
  );
}

export function itemArchived(): ApiException {
  return new ApiException(409, "COMPATIBILITY_ITEM_ARCHIVED", "The item is archived");
}

export function notAnalog(): ApiException {
  return new ApiException(
    409,
    "COMPATIBILITY_NOT_ANALOG",
    "Compatibility is copied only from an analog of the item",
  );
}

export function proposalState(status: CompatibilityProposalStatus): ApiException {
  const details: CompatibilityProposalStateDetails = { status };
  return new ApiException(
    409,
    "COMPATIBILITY_PROPOSAL_STATE",
    "The proposal was already reviewed",
    {
      details,
    },
  );
}

export function proposalDuplicate(): ApiException {
  return new ApiException(
    409,
    "COMPATIBILITY_PROPOSAL_DUPLICATE",
    "The company already waits on the same proposal for this item",
  );
}

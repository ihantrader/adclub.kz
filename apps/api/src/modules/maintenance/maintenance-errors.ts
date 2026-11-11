import {
  MAINTENANCE_PLAN_ITEMS_MAX,
  type MaintenanceNotReadyDetails,
  type MaintenancePlanStateDetails,
} from "@adclub/contracts";
import { ApiException } from "../../common/errors";

/** Contract errors of maintenance plans (ARCHITECTURE 4.84). */

export function notFound(what: string): ApiException {
  return new ApiException(404, "NOT_FOUND", `No such ${what}`);
}

export function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

export function versionConflict(currentVersion: number): ApiException {
  return new ApiException(
    409,
    "MAINTENANCE_VERSION_CONFLICT",
    "It was changed by someone else; reload it and decide again",
    { details: { currentVersion } },
  );
}

export function activeExists(existingPlanId: string): ApiException {
  return new ApiException(
    409,
    "MAINTENANCE_PLAN_ACTIVE_EXISTS",
    "The area already has an active plan; archive it (or change the area) first",
    { details: { existingPlanId } },
  );
}

export function notReady(details: MaintenanceNotReadyDetails): ApiException {
  return new ApiException(
    409,
    "MAINTENANCE_PLAN_NOT_READY",
    "Every element must be confirmed and lead to the catalog before the plan is activated",
    { details },
  );
}

export function planState(message: string): ApiException {
  return new ApiException(409, "MAINTENANCE_PLAN_STATE", message);
}

/** The last active element of an active plan stays: clients would get an empty plan (TASK-061.A). */
export function lastElement(): ApiException {
  return new ApiException(
    409,
    "MAINTENANCE_PLAN_STATE",
    "The last element of an active plan is not removed; archive the plan instead",
    { details: { reason: "last_active_element" } satisfies MaintenancePlanStateDetails },
  );
}

/** A plan holds at most `MAINTENANCE_PLAN_ITEMS_MAX` elements that are not archived. */
export function itemsLimit(): ApiException {
  return new ApiException(
    409,
    "MAINTENANCE_PLAN_STATE",
    `A plan holds at most ${String(MAINTENANCE_PLAN_ITEMS_MAX)} elements`,
    { details: { reason: "items_limit" } satisfies MaintenancePlanStateDetails },
  );
}

export function draftInProgress(): ApiException {
  return new ApiException(
    409,
    "MAINTENANCE_DRAFT_IN_PROGRESS",
    "AI is already making a draft of this area; wait for it",
  );
}

export function targetInvalid(
  reason: "category" | "attribute" | "option" | "item",
  field: string,
): ApiException {
  const messages = {
    category: "No such active subcategory of this kind",
    attribute: "Not an active filter of the subcategory, or a condition of another type",
    option: "Not a variant of the characteristic",
    item: "No such active item of this kind",
  } as const;
  return new ApiException(400, "MAINTENANCE_TARGET_INVALID", messages[reason], {
    details: { reason, field },
  });
}

export function scopeInvalid(
  reason: "not_found" | "model_of_other_make" | "generation_of_other_model",
  field: string,
): ApiException {
  const messages = {
    not_found: "No such record in the vehicle catalog",
    model_of_other_make: "The model is of another make",
    generation_of_other_model: "The generation is of another model",
  } as const;
  return new ApiException(400, "MAINTENANCE_SCOPE_INVALID", messages[reason], {
    details: { reason, field },
  });
}

export function aiUnavailable(): ApiException {
  return new ApiException(
    503,
    "SERVICE_UNAVAILABLE",
    "AI could not make the draft now; try again later",
    { retryable: true },
  );
}

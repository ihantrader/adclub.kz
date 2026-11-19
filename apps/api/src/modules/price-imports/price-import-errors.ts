import type {
  PriceImportFailure,
  PriceImportFileInvalidDetails,
  PriceImportFileProblem,
  PriceImportPhotoInvalidDetails,
  PricePhotoProblem,
  PriceImportStateDetails,
  PriceImportStatus,
} from "@adclub/contracts";
import { ApiException } from "../../common/errors";

/**
 * A problem of the file itself (TASK-046 requirement 1): found at the
 * upload it is a 400 and nothing is stored; found by the worker it is the
 * `failure` of the import — the same reasons and words either way.
 */
export class PriceFileError extends Error {
  constructor(
    readonly reason: PriceImportFileProblem,
    message: string,
    readonly extra: { detected?: string; limit?: number; line?: number } = {},
  ) {
    super(message);
    this.name = "PriceFileError";
  }

  details(): PriceImportFileInvalidDetails {
    return {
      reason: this.reason,
      detected: this.extra.detected ?? null,
      limit: this.extra.limit ?? null,
      line: this.extra.line ?? null,
    };
  }

  failure(): PriceImportFailure {
    return this.details();
  }

  toApiException(): ApiException {
    return new ApiException(400, "PRICE_IMPORT_FILE_INVALID", this.message, {
      details: this.details(),
    });
  }
}

export function notFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "No such price list upload");
}

export function importState(status: PriceImportStatus, message: string): ApiException {
  const details: PriceImportStateDetails = { status, appliedBy: null, appliedAt: null };
  return new ApiException(409, "PRICE_IMPORT_STATE", message, { details });
}

/** A page can't be taken again: the import's files are gone after their retention (TASK-064.A). */
export function filesDeleted(): ApiException {
  return new ApiException(
    409,
    "PRICE_IMPORT_FILES_DELETED",
    "The photos of this upload were removed after their retention; upload the price list again",
  );
}

export function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, {
    details: [{ path, message }],
  });
}

/** A photographed page that can't be taken, by its number (`page: null` — the request; TASK-064). */
export function photoInvalid(
  page: number | null,
  reason: PricePhotoProblem,
  limit: number | null = null,
): ApiException {
  const details: PriceImportPhotoInvalidDetails = { page, reason, limit };
  return new ApiException(
    400,
    "PRICE_IMPORT_PHOTO_INVALID",
    page === null
      ? `The photos can't be taken: ${reason}`
      : `Page ${String(page)} can't be taken: ${reason}`,
    { details },
  );
}

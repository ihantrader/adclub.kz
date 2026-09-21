import type {
  CityDuplicateDetails,
  SupplierBinTakenDetails,
  SupplierLeadStateDetails,
  SupplierStateDetails,
  SupplierVersionConflictDetails,
} from "@adclub/contracts";
import { checkKzBin, normalizeKzMobilePhone } from "@adclub/domain";
import { sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import type { AuditActorRecord } from "../audit";
import type { AuthenticatedSession } from "../identity";

/** Who changes cities, requests and suppliers: an administrator or the operator command (the dev seed). */
export type SupplierAdminActor = Extract<
  AuditActorRecord,
  { role: "admin" } | { role: "operator" }
>;

/** A cabinet session acting for its own company (its schedule). */
export type SupplierSelfActor = Extract<AuditActorRecord, { role: "supplier" }>;

export function supplierSelfActor(session: AuthenticatedSession): SupplierSelfActor {
  if (!session.supplierId || !session.supplierMemberId) {
    throw new Error("A supplier route reached without a company");
  }
  return {
    role: "supplier",
    accountId: session.accountId,
    supplierId: session.supplierId,
    memberId: session.supplierMemberId,
  };
}

export function adminIdOf(actor: SupplierAdminActor): string | null {
  return actor.role === "admin" ? actor.adminId : null;
}

/**
 * Changes of the city directory take this transaction lock: the checks
 * that span rows (a name free among all cities, the order) can't race;
 * the unique keys of the database stay the last line.
 */
export const CITY_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('city_directory'))`;

/** One БИН at a time: two suppliers can't be created with it at once (the unique key is the last line). */
export function binLock(bin: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${`supplier_bin:${bin}`}))`;
}

// ------------------------------------------------------------------ errors

export function notFound(what: string): ApiException {
  return new ApiException(404, "NOT_FOUND", `No such ${what}`);
}

export function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

export function cityVersionConflict(currentVersion: number): ApiException {
  const details: SupplierVersionConflictDetails = { currentVersion };
  return new ApiException(
    409,
    "CITY_VERSION_CONFLICT",
    "The city was changed by someone else; reload it and decide again",
    { details },
  );
}

export function supplierVersionConflict(currentVersion: number): ApiException {
  const details: SupplierVersionConflictDetails = { currentVersion };
  return new ApiException(
    409,
    "SUPPLIER_VERSION_CONFLICT",
    "It was changed by someone else; reload it and decide again",
    { details },
  );
}

export function cityDuplicate(details: CityDuplicateDetails): ApiException {
  return new ApiException(
    409,
    "CITY_DUPLICATE",
    details.field === "code"
      ? "Another city already has this code"
      : "Another city already has this name (case is ignored)",
    { details },
  );
}

export function cityArchived(field: string): ApiException {
  return new ApiException(
    409,
    "CITY_ARCHIVED",
    "The city is archived: restore it or choose another one",
    { details: { field } },
  );
}

export function binTaken(existingSupplierId: string): ApiException {
  const details: SupplierBinTakenDetails = { existingSupplierId };
  return new ApiException(409, "SUPPLIER_BIN_TAKEN", "A supplier with this БИН already exists", {
    details,
  });
}

export function leadState(details: SupplierLeadStateDetails): ApiException {
  const messages: Record<SupplierLeadStateDetails["refusal"], string> = {
    same: "The request already has this status",
    onboarded_only_by_onboarding:
      "A request becomes onboarded only when the supplier is created from it",
    final: "An onboarded request doesn't change any more",
    contract_not_signed: "A supplier is created only from a request with a signed contract",
  };
  return new ApiException(409, "SUPPLIER_LEAD_STATE", messages[details.refusal], { details });
}

export function supplierStateConflict(refusal: SupplierStateDetails["refusal"]): ApiException {
  const messages: Record<SupplierStateDetails["refusal"], string> = {
    not_paused: "The supplier isn't paused",
    not_blocked: "The supplier isn't blocked",
    not_verified: "The supplier isn't a verified partner",
    already_blocked: "The supplier is already blocked",
  };
  const details: SupplierStateDetails = { refusal };
  return new ApiException(409, "SUPPLIER_STATE", messages[refusal], { details });
}

// ------------------------------------------------------------- normalizing

/** A Kazakhstan mobile number as `+77XXXXXXXXX`, or a validation error on `field`. */
export function kzPhone(field: string, input: string): string {
  const phone = normalizeKzMobilePhone(input);
  if (!phone) {
    throw validationError(field, "Must be a Kazakhstan mobile number, e.g. +7 701 123 45 67");
  }
  return phone;
}

/** A БИН (or ИИН) of 12 digits with a valid check digit, or a validation error on `field`. */
export function kzBin(field: string, input: string): string {
  const checked = checkKzBin(input);
  if (!checked.ok) {
    throw validationError(
      field,
      checked.reason === "format"
        ? "Must be 12 digits"
        : "Not a valid БИН: the check digit doesn't match",
    );
  }
  return checked.bin;
}

/** Whether the runtime knows the IANA time zone. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function timeZoneOf(field: string, input: string): string {
  if (!isKnownTimeZone(input)) {
    throw validationError(field, "Not a known time zone, e.g. Asia/Almaty");
  }
  return input;
}

/** Today's date (`YYYY-MM-DD`) in a time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // `en-CA` formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The same date `years` later (`YYYY-MM-DD`; 29 February becomes 28 in a common year). */
export function yearsLater(date: string, years: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year + years, month - 1, day));
  if (target.getUTCMonth() !== month - 1) {
    target.setUTCDate(0);
  }
  return target.toISOString().slice(0, 10);
}

/** Records the fields that differ into `before`/`after` (the action journal keeps only those). */
export class Changes {
  readonly before: Record<string, unknown> = {};
  readonly after: Record<string, unknown> = {};

  note(field: string, was: unknown, now: unknown): void {
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      this.before[field] = was;
      this.after[field] = now;
    }
  }

  get empty(): boolean {
    return Object.keys(this.after).length === 0;
  }

  has(field: string): boolean {
    return field in this.after;
  }
}

export function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

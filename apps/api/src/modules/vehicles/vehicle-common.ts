import { sql } from "drizzle-orm";
import type { AuditActorRecord } from "../audit";
import { normalizeText } from "../catalog";
import { validationError } from "./vehicle-errors";

export { normalizeText };
export { decodeCursor, encodeCursor, TIME_POSITION } from "../catalog";

/** Who changes the vehicle catalog: an administrator, or the operator command (the dev seed). */
export type VehicleActor = Extract<AuditActorRecord, { role: "admin" } | { role: "operator" }>;

/**
 * Every change of the vehicle catalog — an administrator's and an
 * import's — takes this one transaction lock (ARCHITECTURE 4.24). Changes
 * are rare, and serialized the checks that span rows (a spelling free
 * among all makes, years within the generation, a parent not archived,
 * the same modification not twice) can't race; the unique keys and
 * triggers of the database stay the last line. Client reads never take it.
 */
export const VEHICLE_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('vehicle_catalog'))`;

/**
 * A spelling as uniqueness sees it: case and whitespace don't matter
 * (`GEELY Auto` = `geelyauto`), as for brands (ARCHITECTURE 4.17 I158).
 */
export function spellingKey(text: string): string {
  return normalizeText(text).toLowerCase().replace(/\s+/gu, "");
}

/** A name as uniqueness among neighbours sees it: case doesn't matter, spaces do. */
export function nameKey(text: string): string {
  return normalizeText(text).toLowerCase();
}

export interface Spellings {
  name: string;
  aliases: string[];
}

/** Normalized, none of them the same as another (case and spaces ignored). */
export function spellingsOf(name: string, aliases: readonly string[]): Spellings {
  const normalizedName = normalizeText(name);
  const seen = new Set([spellingKey(normalizedName)]);
  const unique: string[] = [];
  for (const [index, alias] of aliases.entries()) {
    const text = normalizeText(alias);
    const key = spellingKey(text);
    if (seen.has(key)) {
      throw validationError(
        `aliases.${index}`,
        "The spelling repeats the name or another spelling (case and spaces are ignored)",
      );
    }
    seen.add(key);
    unique.push(text);
  }
  return { name: normalizedName, aliases: unique };
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

/** `null` stays `null`; a stored `numeric` comes back as a string. */
export function decimal(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Whether a modification's years lie within its generation's. */
export function withinYears(
  inner: { yearFrom: number; yearTo: number | null },
  outer: { yearFrom: number; yearTo: number | null },
): boolean {
  if (inner.yearFrom < outer.yearFrom) {
    return false;
  }
  if (outer.yearTo === null) {
    return true;
  }
  return inner.yearTo !== null && inner.yearTo <= outer.yearTo;
}

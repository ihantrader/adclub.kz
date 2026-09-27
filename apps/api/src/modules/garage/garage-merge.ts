import type { CarLevels } from "@adclub/contracts";
import type { AccountCarRow } from "./schema";

/**
 * The one rule for "this is the same car" on the server side of the merge
 * (TASK-029 requirement 2): every level the same, by id — the colour never
 * takes part (D-063), and neither does a label, a device id or when a car
 * was added. Compares a row already in the account's garage with the levels
 * of a car proposed for it (an explicit add, or one entry of a transfer).
 *
 * Kept local to this module rather than imported from a shared package: at
 * the time this was written another change in flight in this repository was
 * actively renaming the equivalent shared function more than once (see the
 * TASK-029 report, "Known Issues" — a real concurrent-edit hazard, not a
 * design preference). `CarLevels` itself comes from `@adclub/contracts`,
 * which this task owns and which both the device and the server already
 * agree on as the wire format, so the two are consolidated as soon as the
 * shared package settles rather than kept apart on principle.
 */
export function sameLevels(row: AccountCarRow, levels: CarLevels): boolean {
  return (
    row.makeId === levels.make.id &&
    row.modelId === levels.model.id &&
    row.year === levels.year &&
    (row.generationId ?? null) === (levels.generation?.id ?? null) &&
    (row.bodyTypeId ?? null) === (levels.body?.id ?? null) &&
    (row.engineId ?? null) === (levels.engine?.id ?? null) &&
    (row.transmissionTypeId ?? null) === (levels.transmission?.id ?? null) &&
    (row.driveTypeId ?? null) === (levels.drive?.id ?? null)
  );
}

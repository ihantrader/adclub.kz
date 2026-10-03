import type { CarLevels } from "@adclub/contracts";
import { carIdentity, sameCarIdentity, type CarIdentity } from "@adclub/domain";
import type { AccountCarRow } from "./schema";

/**
 * A row of the account's garage as the rule of «the same car» sees it. This is
 * only a change of shape — the rule is `@adclub/domain`'s `sameCarIdentity`,
 * the very one the device's garage decides duplicates by (ARCHITECTURE 4.41
 * I447). `CarIdentity` is keyed by every level of the rule, so a level added
 * there fails to compile here until the row says where it keeps it.
 */
export function rowIdentity(row: AccountCarRow): CarIdentity {
  return {
    make: row.makeId,
    model: row.modelId,
    year: row.year,
    generation: row.generationId,
    body: row.bodyTypeId,
    engine: row.engineId,
    transmission: row.transmissionTypeId,
    drive: row.driveTypeId,
  };
}

/**
 * Is a car proposed for the garage (an explicit add, or one entry of a
 * transfer) the one a row already holds: every level the same by id, the
 * colour, labels and dates not counting (D-063).
 */
export function sameLevels(row: AccountCarRow, levels: CarLevels): boolean {
  return sameCarIdentity(rowIdentity(row), carIdentity(levels));
}

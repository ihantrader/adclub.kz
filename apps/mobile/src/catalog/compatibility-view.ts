import type { CompatibilityItemResult, CompatibilityLevel } from "@adclub/contracts";
import type { Compatibility } from "@adclub/ui-core";

/**
 * What the app shows about compatibility (SCREENS «Правила совместимости»,
 * DESIGN 7.8) — **read off the server's answer, never computed here**.
 *
 * The single evaluator lives on the server (D-029, ARCHITECTURE 4.25): it
 * says which mark to show (`mark`), which levels of the car are missing
 * (`missing`), whether a list shows the item at all (`listed`) and whether
 * an item opened directly needs a warning (`requiresConfirmation`). This
 * module only turns those fields into a design-system mark and the text to
 * put next to it. There is no table of rules, no guessing from
 * `hasCompatibility`, and nothing that could disagree with the server.
 */

export type CompatibilityView =
  /** No mark: a universal subcategory, or no car chosen (the server said so). */
  | { kind: "none" }
  | { kind: "fits" }
  /** «Уточните {параметр}» and «Дополнить автомобиль». */
  | { kind: "needsDetails"; level: CompatibilityLevel | null }
  | { kind: "doesNotFit" }
  | { kind: "notSpecified" };

export function compatibilityView(result: CompatibilityItemResult): CompatibilityView {
  switch (result.mark) {
    case "fits":
      return { kind: "fits" };
    case "needs_details":
      return { kind: "needsDetails", level: result.missing[0] ?? null };
    case "does_not_fit":
      return { kind: "doesNotFit" };
    case "not_specified":
      return { kind: "notSpecified" };
    default:
      // `null`, and any value a newer server may add (ARCHITECTURE 7.4).
      return { kind: "none" };
  }
}

/** The icon and colour of DESIGN 7.8 for a view. */
export function compatibilityMarkOf(view: CompatibilityView): Compatibility | null {
  switch (view.kind) {
    case "fits":
      return "fits";
    case "needsDetails":
      return "missingParameter";
    case "doesNotFit":
      return "doesNotFit";
    case "notSpecified":
      return "unknown";
    default:
      return null;
  }
}

/** The level named in «Уточните {параметр}»; the engine is the usual one. */
export const COMPATIBILITY_LEVEL_TEXT = {
  make: "car.level.make",
  model: "car.level.model",
  generation: "car.level.generation",
  body: "car.level.body",
  engine: "car.level.engine",
  transmission: "car.level.transmission",
  drive: "car.level.drive",
  year: "car.level.year",
} as const satisfies Record<CompatibilityLevel, string>;

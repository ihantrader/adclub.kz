import type { ShowcaseAttributeFilter } from "@adclub/contracts";
import {
  MAINTENANCE_KM_MAX,
  MAINTENANCE_KM_MIN,
  MAINTENANCE_MONTHS_MAX,
  MAINTENANCE_MONTHS_MIN,
  maintenanceIntervalsProblem,
} from "@adclub/domain";
import type { MaintenanceDraftOutput } from "../ai";
import type { NewElement } from "./maintenance-plans.service";

/**
 * What an AI draft becomes against the catalog (TASK-061 requirement 3):
 * a subcategory by its code — of goods for a part, of services for a
 * service — and conditions by the codes of its active filters and their
 * variants. A code the catalog has not is dropped and said in the element's
 * note (`unmapped: …`); an element whose subcategory is unknown keeps no rule
 * at all and can't be confirmed until the administrator gives it one.
 * Intervals outside 1 000…120 000 km and 1…120 months are dropped; an element
 * left with no interval is dropped whole. Everything AI gives is `proposed`.
 */

export interface DraftCatalogAttribute {
  id: string;
  code: string;
  type: "enum" | "number" | "bool" | "text";
  options: readonly { id: string; code: string }[];
}

export interface DraftCatalogCategory {
  id: string;
  code: string;
  kind: "goods" | "services";
  attributes: readonly DraftCatalogAttribute[];
}

export interface MappedDraft {
  elements: NewElement[];
  /** Elements dropped whole: no usable interval, or no title. */
  dropped: number;
  /** Elements kept without a rule (their subcategory is not in the catalog). */
  unmapped: number;
}

const NOTE_MAX = 200;
const TITLE_MAX = 120;

function within(value: number | null, min: number, max: number): number | null {
  return value !== null && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function note(parts: readonly string[]): string | null {
  if (parts.length === 0) return null;
  const text = `unmapped: ${parts.join("; ")}`;
  return text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1)}…` : text;
}

export function mapDraft(
  output: MaintenanceDraftOutput,
  categories: readonly DraftCatalogCategory[],
): MappedDraft {
  const byCode = new Map(categories.map((category) => [category.code, category]));
  const elements: NewElement[] = [];
  let dropped = 0;
  let unmapped = 0;
  for (const proposed of output.items) {
    const title = proposed.title
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, TITLE_MAX);
    const intervalKm = within(proposed.intervalKm, MAINTENANCE_KM_MIN, MAINTENANCE_KM_MAX);
    const intervalMonths = within(
      proposed.intervalMonths,
      MAINTENANCE_MONTHS_MIN,
      MAINTENANCE_MONTHS_MAX,
    );
    const firstKm =
      intervalKm !== null &&
      proposed.firstKm !== null &&
      proposed.firstKm >= 1 &&
      proposed.firstKm < intervalKm
        ? proposed.firstKm
        : null;
    const intervals = { intervalKm, intervalMonths, firstKm, firstMonths: null };
    if (!title || maintenanceIntervalsProblem(intervals) !== null) {
      dropped += 1;
      continue;
    }
    const kind = proposed.kind;
    const wantedKind = kind === "part" ? "goods" : "services";
    const notes: string[] = [];
    const category = proposed.categoryCode ? byCode.get(proposed.categoryCode) : undefined;
    let target: NewElement["target"] = null;
    if (!category || category.kind !== wantedKind) {
      notes.push(
        [proposed.categoryCode, proposed.suggestedCategory].filter(Boolean).join(" — ") ||
          "подкатегория не названа",
      );
      unmapped += 1;
    } else {
      const attributes: ShowcaseAttributeFilter[] = [];
      for (const condition of proposed.conditions) {
        const definition = category.attributes.find((entry) => entry.code === condition.attribute);
        const said = `${condition.attribute}=${condition.options.join(",") || [condition.min, condition.max, condition.value].filter((value) => value !== null).join("…")}`;
        if (!definition || attributes.some((entry) => entry.attributeId === definition.id)) {
          notes.push(said);
          continue;
        }
        if (definition.type === "enum") {
          const optionIds = condition.options.flatMap((code) => {
            const option = definition.options.find((entry) => entry.code === code);
            if (!option) notes.push(`${condition.attribute}=${code}`);
            return option ? [option.id] : [];
          });
          if (optionIds.length > 0)
            attributes.push({ attributeId: definition.id, optionIds: [...new Set(optionIds)] });
        } else if (
          definition.type === "number" &&
          (condition.min !== null || condition.max !== null)
        ) {
          const [min, max] = [condition.min, condition.max];
          if (min !== null && max !== null && min > max) {
            notes.push(said);
            continue;
          }
          attributes.push({
            attributeId: definition.id,
            ...(min === null ? {} : { min }),
            ...(max === null ? {} : { max }),
          });
        } else if (definition.type === "bool" && condition.value !== null) {
          attributes.push({ attributeId: definition.id, value: condition.value });
        } else {
          notes.push(said);
        }
      }
      target = { kind: "category", categoryId: category.id, attributes };
    }
    elements.push({
      kind,
      title: { ru: title },
      ...intervals,
      serviceCodes: proposed.serviceCodes
        .map((code) =>
          code
            .replace(/[\p{Cc},]/gu, "")
            .trim()
            .slice(0, 20),
        )
        .filter(Boolean)
        .slice(0, 12),
      target,
      quantity: within(proposed.quantity, 1, 100),
      note: note(notes),
      status: "proposed",
    });
  }
  return { elements, dropped, unmapped };
}

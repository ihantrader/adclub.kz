import type { CategoryAttribute, ShowcaseAttributeFilter } from "@adclub/contracts";

/**
 * The filters of M-CAT-03 as state and as a query (TASK-028 requirement 2).
 *
 * Nothing here is hard-coded per category: the sections come from the
 * description the server gives (`GET /catalog/categories/{id}/attributes`),
 * and the values are handed straight back to the list. «Показать N позиций»
 * is the `total` of the server's answer, never a count made here.
 */

export type AvailabilityFilter = "in_stock" | "on_order";
export type ReceivingFilter = "pickup" | "delivery";

export type AttributeFilterValue =
  | { kind: "options"; optionIds: string[] }
  | { kind: "range"; min: number | null; max: number | null }
  | { kind: "boolean"; value: boolean };

export interface FilterState {
  availability: AvailabilityFilter | null;
  receiving: ReceivingFilter | null;
  onlyMyCity: boolean;
  brandIds: string[];
  /** By attribute id, in the order of the category's description. */
  attributes: Record<string, AttributeFilterValue>;
}

export const EMPTY_FILTERS: FilterState = {
  availability: null,
  receiving: null,
  onlyMyCity: false,
  brandIds: [],
  attributes: {},
};

function isEmptyValue(value: AttributeFilterValue): boolean {
  if (value.kind === "options") return value.optionIds.length === 0;
  if (value.kind === "range") return value.min === null && value.max === null;
  return false;
}

function withAttribute(
  state: FilterState,
  attributeId: string,
  value: AttributeFilterValue | null,
): FilterState {
  const attributes = { ...state.attributes };
  if (value === null || isEmptyValue(value)) delete attributes[attributeId];
  else attributes[attributeId] = value;
  return { ...state, attributes };
}

export function toggleOption(
  state: FilterState,
  attributeId: string,
  optionId: string,
): FilterState {
  const current = state.attributes[attributeId];
  const selected = current?.kind === "options" ? current.optionIds : [];
  const optionIds = selected.includes(optionId)
    ? selected.filter((id) => id !== optionId)
    : [...selected, optionId];
  return withAttribute(state, attributeId, { kind: "options", optionIds });
}

export function setRange(
  state: FilterState,
  attributeId: string,
  range: { min: number | null; max: number | null },
): FilterState {
  return withAttribute(state, attributeId, { kind: "range", ...range });
}

export function setBoolean(
  state: FilterState,
  attributeId: string,
  value: boolean | null,
): FilterState {
  return withAttribute(state, attributeId, value === null ? null : { kind: "boolean", value });
}

export function toggleBrand(state: FilterState, brandId: string): FilterState {
  const brandIds = state.brandIds.includes(brandId)
    ? state.brandIds.filter((id) => id !== brandId)
    : [...state.brandIds, brandId];
  return { ...state, brandIds };
}

/** The number next to «Фильтры»: every section that is set counts once. */
export function filterCount(state: FilterState): number {
  return (
    (state.availability ? 1 : 0) +
    (state.receiving ? 1 : 0) +
    (state.onlyMyCity ? 1 : 0) +
    (state.brandIds.length > 0 ? 1 : 0) +
    Object.values(state.attributes).filter((value) => !isEmptyValue(value)).length
  );
}

export function hasFilters(state: FilterState): boolean {
  return filterCount(state) > 0;
}

/**
 * A range whose bounds the user swapped («от 10 до 2») is sent the right way
 * round: the server refuses `min > max`, and an error message about it would
 * tell the user nothing they can act on.
 */
function orderedRange(min: number | null, max: number | null) {
  if (min !== null && max !== null && min > max) return { min: max, max: min };
  return { min, max };
}

/**
 * The filters exactly as the query string carries them: brands separated by
 * commas and the attribute filters as one JSON parameter (a query string
 * holds only scalars, ARCHITECTURE 4.29 I291).
 */
export interface FilterQuery {
  availability?: AvailabilityFilter;
  receiving?: ReceivingFilter;
  onlyMyCity?: "true";
  brandIds?: string;
  attributes?: string;
}

/**
 * The filters as the list route takes them. An attribute that is no longer
 * an active filterable attribute of the category (archived since the screen
 * was opened) is left out here as well as ignored by the server.
 */
export function filtersToQuery(
  state: FilterState,
  attributes: readonly CategoryAttribute[],
): FilterQuery {
  const filterable = new Set(
    attributes.filter((attribute) => attribute.isFilterable).map((attribute) => attribute.id),
  );
  const parsed: ShowcaseAttributeFilter[] = [];
  for (const [attributeId, value] of Object.entries(state.attributes)) {
    if (!filterable.has(attributeId) || isEmptyValue(value)) continue;
    if (value.kind === "options") {
      parsed.push({ attributeId, optionIds: value.optionIds });
    } else if (value.kind === "boolean") {
      parsed.push({ attributeId, value: value.value });
    } else {
      const { min, max } = orderedRange(value.min, value.max);
      parsed.push({
        attributeId,
        ...(min === null ? {} : { min }),
        ...(max === null ? {} : { max }),
      });
    }
  }
  return {
    ...(state.availability ? { availability: state.availability } : {}),
    ...(state.receiving ? { receiving: state.receiving } : {}),
    ...(state.onlyMyCity ? { onlyMyCity: "true" as const } : {}),
    ...(state.brandIds.length > 0 ? { brandIds: state.brandIds.join(",") } : {}),
    ...(parsed.length > 0 ? { attributes: JSON.stringify(parsed) } : {}),
  };
}

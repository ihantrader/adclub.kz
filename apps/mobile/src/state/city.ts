import type { ClientCity } from "@adclub/contracts";

/**
 * The city of the app — one value (SCREENS 5.1): either a city of the
 * server's list or "the whole of Kazakhstan". The name is kept next to the
 * id so the catalog header and the profile have something to show before
 * `/cities` answers (and when it never does).
 */
export type CitySelection =
  { kind: "all" } | { kind: "city"; id: string; code: string; name: string };

export interface CityState {
  selection: CitySelection;
  /** Whether the user has already chosen (or confirmed) a city. */
  chosen: boolean;
  /**
   * Whether the city was ever detected by geolocation. The city is detected
   * once and never automatically again (SCREENS 5.1) — the button in
   * M-CITY-01 stays available, but nothing detects by itself.
   */
  detected: boolean;
}

export const INITIAL_CITY_STATE: CityState = {
  selection: { kind: "all" },
  chosen: false,
  detected: false,
};

export function parseCityState(raw: unknown): CityState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const selection = parseSelection(value.selection);
  if (!selection) return null;
  return {
    selection,
    chosen: value.chosen === true,
    detected: value.detected === true,
  };
}

function parseSelection(raw: unknown): CitySelection | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === "all") return { kind: "all" };
  if (
    value.kind === "city" &&
    typeof value.id === "string" &&
    typeof value.code === "string" &&
    typeof value.name === "string"
  ) {
    return { kind: "city", id: value.id, code: value.code, name: value.name };
  }
  return null;
}

export function selectionOf(city: ClientCity): CitySelection {
  return { kind: "city", id: city.id, code: city.code, name: city.name.text };
}

/** The `cityId` of a catalog request; `undefined` — the whole of Kazakhstan. */
export function cityIdOf(selection: CitySelection): string | undefined {
  return selection.kind === "city" ? selection.id : undefined;
}

/**
 * The name shown in the header and the profile; "the whole of Kazakhstan"
 * has no name of its own, so the caller passes its label.
 */
export function cityLabel(selection: CitySelection, allLabel: string): string {
  return selection.kind === "city" ? selection.name : allLabel;
}

/**
 * Keeps the stored city in step with the list from the server: a renamed
 * city takes its new name (the list is localised, so this also follows a
 * change of the interface language), and a city that is no longer in the
 * list becomes "the whole of Kazakhstan" — it was archived, and a request
 * with its id would answer nothing.
 */
export function reconcileCity(state: CityState, cities: readonly ClientCity[]): CityState {
  const current = state.selection;
  if (current.kind !== "city") return state;
  const match = cities.find((city) => city.id === current.id);
  if (!match) return { ...state, selection: { kind: "all" } };
  const name = match.name.text;
  if (name === current.name && match.code === current.code) return state;
  return { ...state, selection: selectionOf(match) };
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/ё/g, "е");
}

/**
 * Finds the city of a geolocation answer in the server's list: by code and
 * by name in any of the three languages (the reverse geocoder answers in
 * the device's locale, which is not necessarily the interface language).
 * Nothing matched — the caller falls back to "the whole of Kazakhstan"
 * (SCREENS 5.1: an unknown city leads to the list with it selected).
 */
export function matchDetectedCity(
  detected: readonly (string | null | undefined)[],
  cities: readonly ClientCity[],
): ClientCity | null {
  const names = detected.filter((name): name is string => Boolean(name?.trim())).map(normalize);
  if (names.length === 0) return null;

  for (const name of names) {
    const match = cities.find(
      (city) => normalize(city.code) === name || normalize(city.name.text) === name,
    );
    if (match) return match;
  }
  // "Almaty city", "г. Алматы", "Astana, Kazakhstan": the city name inside a longer answer.
  for (const name of names) {
    const match = cities.find((city) => {
      const cityName = normalize(city.name.text);
      return cityName.length >= 3 && (name.includes(cityName) || cityName.includes(name));
    });
    if (match) return match;
  }
  return null;
}

/** Search inside the sheet: by name and by code, from any position. */
export function filterCities(cities: readonly ClientCity[], query: string): ClientCity[] {
  const search = normalize(query);
  if (search === "") return [...cities];
  return cities.filter(
    (city) => normalize(city.name.text).includes(search) || normalize(city.code).includes(search),
  );
}

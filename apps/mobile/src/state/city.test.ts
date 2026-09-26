import type { ClientCity } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  cityIdOf,
  cityLabel,
  filterCities,
  INITIAL_CITY_STATE,
  matchDetectedCity,
  parseCityState,
  reconcileCity,
  selectionOf,
  type CityState,
} from "./city";

function city(code: string, name: string): ClientCity {
  return {
    id: `id-${code}`,
    code,
    name: { text: name, isFallback: false },
    timeZone: "Asia/Almaty",
  };
}

const CITIES = [city("almaty", "Алматы"), city("astana", "Астана"), city("oral", "Орал")];

describe("city selection", () => {
  it("starts as the whole of Kazakhstan, not chosen and not detected", () => {
    expect(INITIAL_CITY_STATE).toEqual({
      selection: { kind: "all" },
      chosen: false,
      detected: false,
    });
    expect(cityIdOf(INITIAL_CITY_STATE.selection)).toBeUndefined();
    expect(cityLabel(INITIAL_CITY_STATE.selection, "Весь Казахстан")).toBe("Весь Казахстан");
  });

  it("carries the id and the name of a chosen city", () => {
    const selection = selectionOf(CITIES[0]!);
    expect(cityIdOf(selection)).toBe("id-almaty");
    expect(cityLabel(selection, "Весь Казахстан")).toBe("Алматы");
  });
});

describe("parseCityState", () => {
  it("reads what the app wrote", () => {
    const state: CityState = { selection: selectionOf(CITIES[1]!), chosen: true, detected: true };
    expect(parseCityState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("rejects anything unusable, so the default applies", () => {
    expect(parseCityState(null)).toBeNull();
    expect(parseCityState("almaty")).toBeNull();
    expect(parseCityState({ selection: { kind: "city", id: 7 } })).toBeNull();
    expect(parseCityState({ chosen: true })).toBeNull();
  });
});

describe("reconcileCity", () => {
  it("takes the current name of the city (a rename, another interface language)", () => {
    const stored: CityState = {
      selection: { kind: "city", id: "id-oral", code: "oral", name: "Уральск" },
      chosen: true,
      detected: false,
    };
    expect(reconcileCity(stored, CITIES).selection).toEqual(selectionOf(CITIES[2]!));
  });

  it("falls back to the whole of Kazakhstan when the city is gone from the list", () => {
    const stored: CityState = {
      selection: { kind: "city", id: "id-archived", code: "archived", name: "Кентау" },
      chosen: true,
      detected: true,
    };
    expect(reconcileCity(stored, CITIES)).toEqual({
      selection: { kind: "all" },
      chosen: true,
      detected: true,
    });
  });

  it("leaves the whole of Kazakhstan and an unchanged city alone", () => {
    expect(reconcileCity(INITIAL_CITY_STATE, CITIES)).toBe(INITIAL_CITY_STATE);
    const stored: CityState = { selection: selectionOf(CITIES[0]!), chosen: true, detected: false };
    expect(reconcileCity(stored, CITIES)).toBe(stored);
  });
});

describe("matchDetectedCity", () => {
  it("matches a name, whatever the case and the spacing", () => {
    expect(matchDetectedCity(["алматы"], CITIES)?.code).toBe("almaty");
    expect(matchDetectedCity(["  Астана  "], CITIES)?.code).toBe("astana");
  });

  it("matches the code a geocoder may answer in Latin", () => {
    expect(matchDetectedCity(["Almaty"], CITIES)?.code).toBe("almaty");
  });

  it("finds the city inside a longer answer", () => {
    expect(matchDetectedCity(["г. Алматы"], CITIES)?.code).toBe("almaty");
    expect(matchDetectedCity([null, "Астана, Казахстан"], CITIES)?.code).toBe("astana");
  });

  it("takes the first field that matches", () => {
    expect(matchDetectedCity(["Алматинская область", "Алматы"], CITIES)?.code).toBe("almaty");
  });

  it("returns null for a city that is not in the list, and for nothing at all", () => {
    expect(matchDetectedCity(["Кентау"], CITIES)).toBeNull();
    expect(matchDetectedCity([null, undefined, "  "], CITIES)).toBeNull();
    expect(matchDetectedCity(["Алматы"], [])).toBeNull();
  });
});

describe("filterCities", () => {
  it("returns every city for an empty query", () => {
    expect(filterCities(CITIES, "  ")).toHaveLength(3);
  });

  it("searches by name and by code, from any position", () => {
    expect(filterCities(CITIES, "ста").map((c) => c.code)).toEqual(["astana"]);
    expect(filterCities(CITIES, "ORAL").map((c) => c.code)).toEqual(["oral"]);
    expect(filterCities(CITIES, "мат").map((c) => c.code)).toEqual(["almaty"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterCities(CITIES, "Париж")).toEqual([]);
  });
});

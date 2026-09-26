import { describe, expect, it } from "vitest";
import {
  addCar,
  carParameters,
  carTitle,
  findDuplicate,
  INITIAL_GARAGE,
  missingLevels,
  newCarId,
  parseGarage,
  primaryCar,
  removeCar,
  replaceCar,
  sameCar,
  setPrimary,
  type GarageCar,
} from "./garage";

function car(overrides: Partial<GarageCar> = {}): GarageCar {
  return {
    id: "car-1",
    make: { id: "make-geely", label: "Geely" },
    model: { id: "model-atlas", label: "Atlas" },
    year: 2023,
    generation: { id: "gen-2", label: "II (FX11)" },
    body: { id: "body-suv", label: "Внедорожник" },
    engine: { id: "engine-jlh", label: "JLH-4G20TD" },
    transmission: { id: "tr-at", label: "Автомат" },
    drive: { id: "drive-awd", label: "Полный" },
    modificationId: "mod-1",
    addedAt: "2026-09-26T10:00:00.000Z",
    ...overrides,
  };
}

describe("the same car", () => {
  it("compares every level, not the device id", () => {
    expect(sameCar(car(), car({ id: "car-2", addedAt: "2026-01-01T00:00:00.000Z" }))).toBe(true);
  });

  it("tells two cars apart by any level, including an empty one", () => {
    expect(sameCar(car(), car({ year: 2022 }))).toBe(false);
    expect(sameCar(car(), car({ engine: null }))).toBe(false);
    expect(sameCar(car(), car({ model: { id: "model-coolray", label: "Coolray" } }))).toBe(false);
  });

  it("ignores the modification id — it is derived, not chosen", () => {
    expect(sameCar(car(), car({ modificationId: null }))).toBe(true);
  });

  it("finds the duplicate a garage already holds, never the car itself", () => {
    const garage = addCar(INITIAL_GARAGE, car());
    expect(findDuplicate(garage, car({ id: "car-2" }))?.id).toBe("car-1");
    expect(findDuplicate(garage, car())).toBeUndefined();
  });
});

describe("the garage", () => {
  it("makes the first car the main one and leaves the next ones alone", () => {
    const one = addCar(INITIAL_GARAGE, car());
    expect(one.primaryId).toBe("car-1");
    const two = addCar(one, car({ id: "car-2" }));
    expect(two.primaryId).toBe("car-1");
    expect(primaryCar(two)?.id).toBe("car-1");
  });

  it("changes the main car only to a car it holds", () => {
    const garage = addCar(addCar(INITIAL_GARAGE, car()), car({ id: "car-2" }));
    expect(setPrimary(garage, "car-2").primaryId).toBe("car-2");
    expect(setPrimary(garage, "car-404")).toBe(garage);
  });

  it("hands the main role to the next car when the main one is deleted", () => {
    const garage = setPrimary(addCar(addCar(INITIAL_GARAGE, car()), car({ id: "car-2" })), "car-1");
    const left = removeCar(garage, "car-1");
    expect(left.cars.map((item) => item.id)).toEqual(["car-2"]);
    expect(left.primaryId).toBe("car-2");
    expect(removeCar(left, "car-2")).toEqual({ version: 1, cars: [], primaryId: null });
  });

  it("replaces a car in place, keeping the main one", () => {
    const garage = addCar(INITIAL_GARAGE, car());
    const filled = replaceCar(garage, car({ engine: { id: "engine-2", label: "JLH-3G15TD" } }));
    expect(filled.cars[0]?.engine?.label).toBe("JLH-3G15TD");
    expect(filled.primaryId).toBe("car-1");
  });

  it("names a car and its parameters for the screen", () => {
    expect(carTitle(car())).toBe("Geely Atlas 2023");
    expect(carTitle(car({ year: null }))).toBe("Geely Atlas");
    expect(carParameters(car())).toEqual(["JLH-4G20TD", "Автомат", "Полный", "Внедорожник"]);
    expect(
      carParameters(car({ engine: null, transmission: null, drive: null, body: null })),
    ).toEqual([]);
  });

  it("lists what is still missing, in the order the steps ask for it", () => {
    expect(missingLevels(car())).toEqual([]);
    expect(missingLevels(car({ engine: null, year: null }))).toEqual(["year", "engine"]);
  });

  it("makes ids that do not collide inside one garage", () => {
    const a = newCarId(1_700_000_000_000, () => 0.1);
    const b = newCarId(1_700_000_000_000, () => 0.9);
    expect(a).not.toBe(b);
    expect(a.startsWith("car-")).toBe(true);
  });
});

describe("what a device may have stored", () => {
  it("reads back what it wrote", () => {
    const stored = addCar(INITIAL_GARAGE, car());
    expect(parseGarage(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("refuses a format it does not know, so the app starts with an empty garage", () => {
    expect(parseGarage(null)).toBeNull();
    expect(parseGarage({ cars: [] })).toBeNull();
    expect(parseGarage({ version: 2, cars: [] })).toBeNull();
  });

  it("drops a car without the two levels a car cannot exist without", () => {
    const parsed = parseGarage({
      version: 1,
      cars: [{ id: "car-1", make: { id: "m", label: "Geely" } }, JSON.parse(JSON.stringify(car()))],
      primaryId: "car-1",
    });
    expect(parsed?.cars).toHaveLength(1);
    // The main car pointed at the dropped one: the surviving car takes over.
    expect(parsed?.primaryId).toBe("car-1");
  });
});

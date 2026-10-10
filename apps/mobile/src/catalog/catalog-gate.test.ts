import { describe, expect, it } from "vitest";
import {
  addCar,
  INITIAL_GARAGE,
  removeCar,
  setPrimary,
  type GarageCar,
  type GarageState,
} from "../garage/garage";
import { catalogEntry } from "./catalog-gate";

function car(id: string, model = "Atlas"): GarageCar {
  return {
    id,
    make: { id: "make-1", label: "Geely" },
    model: { id: `model-${model}`, label: model },
    year: 2023,
    generation: null,
    body: null,
    engine: null,
    transmission: null,
    drive: null,
    modificationId: null,
    color: null,
    vin: null,
    plate: null,
    document: null,
    addedAt: "2026-09-26T10:00:00.000Z",
  };
}

describe("the catalog opens only with a car (D-062)", () => {
  it("asks for a car while the garage is empty — no catalog at all", () => {
    expect(catalogEntry(INITIAL_GARAGE)).toEqual({ kind: "needs-car" });
  });

  it("opens the catalog for the first car as soon as it is added", () => {
    const garage = addCar(INITIAL_GARAGE, car("car-1"));
    expect(catalogEntry(garage)).toEqual({ kind: "open", car: car("car-1") });
  });

  it("opens the catalog for the main car of a garage with several", () => {
    const garage = setPrimary(
      addCar(addCar(INITIAL_GARAGE, car("car-1")), car("car-2", "Coolray")),
      "car-2",
    );
    const entry = catalogEntry(garage);
    expect(entry.kind).toBe("open");
    expect(entry.kind === "open" && entry.car.id).toBe("car-2");
  });

  it("follows the main car when another one is chosen, without a new garage", () => {
    const two = addCar(addCar(INITIAL_GARAGE, car("car-1")), car("car-2", "Coolray"));
    const before = catalogEntry(two);
    const after = catalogEntry(setPrimary(two, "car-2"));
    expect(before.kind === "open" && before.car.id).toBe("car-1");
    expect(after.kind === "open" && after.car.id).toBe("car-2");
  });

  it("asks for a car again after the last one is deleted — no restart needed", () => {
    const one = addCar(INITIAL_GARAGE, car("car-1"));
    expect(catalogEntry(one).kind).toBe("open");
    expect(catalogEntry(removeCar(one, "car-1"))).toEqual({ kind: "needs-car" });
  });

  it("keeps the catalog open when the main car is deleted but another remains", () => {
    const two = addCar(addCar(INITIAL_GARAGE, car("car-1")), car("car-2", "Coolray"));
    const entry = catalogEntry(removeCar(two, "car-1"));
    expect(entry.kind === "open" && entry.car.id).toBe("car-2");
  });

  it("never shows «add a car» to a garage that has cars, even if the main one is unnamed", () => {
    const broken: GarageState = {
      version: 1,
      cars: [car("car-1")],
      primaryId: "a-car-that-was-deleted",
    };
    const entry = catalogEntry(broken);
    expect(entry.kind === "open" && entry.car.id).toBe("car-1");
  });
});

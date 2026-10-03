import type { AccountCar } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { fromAccountCar, garageStateFromAccountCars, toWireLevels } from "./account-cars";

function accountCar(overrides: Partial<AccountCar> = {}): AccountCar {
  return {
    id: "5b7d6a5e-0000-4000-8000-000000000001",
    make: { id: "make-geely", label: "Geely" },
    model: { id: "model-atlas", label: "Atlas" },
    year: 2023,
    generation: null,
    body: null,
    engine: null,
    transmission: null,
    drive: null,
    modificationId: null,
    color: "white",
    isPrimary: false,
    createdAt: "2026-10-03T10:00:00.000Z",
    updatedAt: "2026-10-03T10:00:00.000Z",
    ...overrides,
  };
}

describe("the account's garage on the device", () => {
  it("keeps the order the cars were added in, though the server lists the newest first", () => {
    const state = garageStateFromAccountCars([
      accountCar({ id: "c", createdAt: "2026-10-03T10:00:03.000Z" }),
      accountCar({ id: "b", createdAt: "2026-10-03T10:00:02.000Z" }),
      accountCar({ id: "a", createdAt: "2026-10-03T10:00:01.000Z" }),
    ]);
    expect(state.cars.map((car) => car.id)).toEqual(["a", "b", "c"]);
  });

  it("makes the account's primary car the device's, or the first one when none is marked", () => {
    const marked = garageStateFromAccountCars([
      accountCar({ id: "a", createdAt: "2026-10-03T10:00:01.000Z" }),
      accountCar({ id: "b", createdAt: "2026-10-03T10:00:02.000Z", isPrimary: true }),
    ]);
    expect(marked.primaryId).toBe("b");
    const unmarked = garageStateFromAccountCars([
      accountCar({ id: "b", createdAt: "2026-10-03T10:00:02.000Z" }),
      accountCar({ id: "a", createdAt: "2026-10-03T10:00:01.000Z" }),
    ]);
    expect(unmarked.primaryId).toBe("a");
    expect(garageStateFromAccountCars([])).toEqual({ version: 1, cars: [], primaryId: null });
  });

  it("carries the colour and the levels over, and sends only the levels", () => {
    const car = fromAccountCar(accountCar({ color: "red", year: 2021 }));
    expect(car).toMatchObject({ color: "red", year: 2021, addedAt: "2026-10-03T10:00:00.000Z" });
    expect(Object.keys(toWireLevels(car)).sort()).toEqual(
      ["body", "drive", "engine", "generation", "make", "model", "transmission", "year"].sort(),
    );
  });
});

import { carLevelsSchema, type CarLevels } from "@adclub/contracts";
import { CAR_IDENTITY_LEVELS, sameCarCases, type SameCarCaseCar } from "@adclub/domain";
import { describe, expect, it } from "vitest";
import { rowIdentity, sameLevels } from "./garage-merge";
import type { AccountCarRow } from "./schema";

function row(overrides: Partial<AccountCarRow> = {}): AccountCarRow {
  return {
    id: "row-1",
    accountId: "account-1",
    makeId: "make-1",
    makeLabel: "Geely",
    modelId: "model-1",
    modelLabel: "Atlas",
    year: 2023,
    generationId: "gen-1",
    generationLabel: "II",
    bodyTypeId: "body-1",
    bodyTypeLabel: "Кроссовер",
    engineId: "engine-1",
    engineLabel: "2.0T",
    transmissionTypeId: "trans-1",
    transmissionTypeLabel: "Автомат",
    driveTypeId: "drive-1",
    driveTypeLabel: "Полный",
    modificationId: null,
    color: "white",
    vin: null,
    plate: null,
    documentStatus: null,
    documentAt: null,
    idempotencyKey: null,
    isPrimary: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function levels(overrides: Partial<CarLevels> = {}): CarLevels {
  return {
    make: { id: "make-1", label: "Geely" },
    model: { id: "model-1", label: "Atlas" },
    year: 2023,
    generation: { id: "gen-1", label: "II" },
    body: { id: "body-1", label: "Кроссовер" },
    engine: { id: "engine-1", label: "2.0T" },
    transmission: { id: "trans-1", label: "Автомат" },
    drive: { id: "drive-1", label: "Полный" },
    ...overrides,
  };
}

/** A row of the account's garage holding the car of a shared case (what the server keeps of it). */
function rowOfCase(car: SameCarCaseCar): AccountCarRow {
  return row({
    makeId: car.make.id,
    makeLabel: car.make.label,
    modelId: car.model.id,
    modelLabel: car.model.label,
    year: car.year,
    generationId: car.generation?.id ?? null,
    generationLabel: car.generation?.label ?? null,
    bodyTypeId: car.body?.id ?? null,
    bodyTypeLabel: car.body?.label ?? null,
    engineId: car.engine?.id ?? null,
    engineLabel: car.engine?.label ?? null,
    transmissionTypeId: car.transmission?.id ?? null,
    transmissionTypeLabel: car.transmission?.label ?? null,
    driveTypeId: car.drive?.id ?? null,
    driveTypeLabel: car.drive?.label ?? null,
    color: car.color as AccountCarRow["color"],
  });
}

/** The same car as the contract carries it to the server. */
function levelsOfCase(car: SameCarCaseCar): CarLevels {
  return {
    make: car.make,
    model: car.model,
    year: car.year,
    generation: car.generation,
    body: car.body,
    engine: car.engine,
    transmission: car.transmission,
    drive: car.drive,
  };
}

/**
 * The cases are the ones the app's garage is held to as well
 * (`apps/mobile/src/garage/garage.test.ts` runs the same `sameCarCases()`
 * through its own `sameCar` over `GarageCar`s): each side must answer what
 * the case says, so the two cannot come to differ without one of them failing.
 */
describe("one rule of «the same car» for the device and the server (ARCHITECTURE 4.41 I447)", () => {
  for (const { name, a, b, same } of sameCarCases()) {
    it(`the server answers ${String(same)} when ${name}`, () => {
      // A row already in the account's garage against a car sent to it…
      expect(sameLevels(rowOfCase(a), levelsOfCase(b))).toBe(same);
      // …and the other way about: the rule has no favourite side.
      expect(sameLevels(rowOfCase(b), levelsOfCase(a))).toBe(same);
    });
  }

  it("holds the contract to the levels of the rule: a level the contract gained is a level the rule must hear of", () => {
    expect(Object.keys(carLevelsSchema.shape).sort()).toEqual([...CAR_IDENTITY_LEVELS].sort());
  });

  it("keeps a row's identity to the levels of the rule", () => {
    expect(Object.keys(rowIdentity(row())).sort()).toEqual([...CAR_IDENTITY_LEVELS].sort());
  });
});

describe("sameLevels", () => {
  it("is true for identical levels", () => {
    expect(sameLevels(row(), levels())).toBe(true);
  });

  it("is true even when labels differ (the catalog renamed something)", () => {
    expect(sameLevels(row(), levels({ make: { id: "make-1", label: "GEELY Auto" } }))).toBe(true);
  });

  it("ignores colour entirely — it is not part of CarLevels", () => {
    expect(sameLevels(row({ color: "red" }), levels())).toBe(true);
  });

  it("is false when the make differs", () => {
    expect(sameLevels(row(), levels({ make: { id: "make-2", label: "Chery" } }))).toBe(false);
  });

  it("is false when the year differs", () => {
    expect(sameLevels(row(), levels({ year: 2024 }))).toBe(false);
  });

  it("is false when one has an engine and the other does not", () => {
    expect(sameLevels(row({ engineId: null, engineLabel: null }), levels())).toBe(false);
  });

  it("is true for two cars with only make and model known", () => {
    const minimalRow = row({
      year: null,
      generationId: null,
      generationLabel: null,
      bodyTypeId: null,
      bodyTypeLabel: null,
      engineId: null,
      engineLabel: null,
      transmissionTypeId: null,
      transmissionTypeLabel: null,
      driveTypeId: null,
      driveTypeLabel: null,
    });
    const minimalLevels = levels({
      year: null,
      generation: null,
      body: null,
      engine: null,
      transmission: null,
      drive: null,
    });
    expect(sameLevels(minimalRow, minimalLevels)).toBe(true);
  });
});

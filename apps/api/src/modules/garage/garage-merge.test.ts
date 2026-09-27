import type { CarLevels } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { sameLevels } from "./garage-merge";
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

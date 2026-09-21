import { describe, expect, it } from "vitest";
import {
  buildReport,
  commitRow,
  emptySnapshot,
  identityKey,
  newSeenRows,
  placeholderIds,
  planRow,
  type ImportSnapshot,
  type PlannedRow,
  type RowValues,
} from "./import-plan";

/**
 * The check of import rows against a catalog in memory (TASK-014
 * requirement 3, edge cases): the same function writes the report and
 * applies the rows, so its rules are tested here once.
 */

const ids = {
  sedan: "o-sedan",
  crossover: "o-crossover",
  cabrio: "o-cabrio",
  dct: "o-dct",
  at: "o-at",
  fwd: "o-fwd",
  awd: "o-awd",
  petrol: "o-petrol",
  diesel: "o-diesel",
  geely: "m-geely",
  oldMake: "m-old",
  coolray: "md-coolray",
  atlas: "md-atlas",
  coolrayI: "g-coolray-i",
  atlasI: "g-atlas-i",
  engine15: "e-15",
  engineOld: "e-old",
  existing: "mod-1",
  archived: "mod-2",
};

function catalog(): ImportSnapshot {
  const snapshot = emptySnapshot();
  const option = (
    kind: "body" | "transmission" | "drive" | "fuel",
    keys: string[],
    id: string,
    status: "active" | "archived" = "active",
  ) => {
    for (const key of keys) {
      snapshot.options.get(kind)!.set(key, { id, status });
    }
  };
  option("body", ["sedan", "седан"], ids.sedan);
  option("body", ["crossover", "кроссовер"], ids.crossover);
  option("body", ["cabrio"], ids.cabrio, "archived");
  option("transmission", ["dct", "робот (dct)"], ids.dct);
  option("transmission", ["at"], ids.at);
  option("drive", ["fwd", "передний"], ids.fwd);
  option("drive", ["awd"], ids.awd);
  option("fuel", ["petrol", "бензин"], ids.petrol);
  option("fuel", ["diesel"], ids.diesel);
  snapshot.makes.set("geely", { id: ids.geely, status: "active" });
  snapshot.makes.set("джили", { id: ids.geely, status: "active" });
  snapshot.makes.set("oldmake", { id: ids.oldMake, status: "archived" });
  snapshot.models.set(`${ids.geely}|coolray`, { id: ids.coolray, status: "active" });
  snapshot.models.set(`${ids.geely}|atlas`, { id: ids.atlas, status: "active" });
  snapshot.generations.set(`${ids.coolray}|i (sx11)`, {
    id: ids.coolrayI,
    status: "active",
    yearFrom: 2019,
    yearTo: null,
  });
  snapshot.generations.set(`${ids.atlas}|i (nl-3)`, {
    id: ids.atlasI,
    status: "active",
    yearFrom: 2016,
    yearTo: 2022,
  });
  snapshot.engines.set("jlh-3g15td", {
    id: ids.engine15,
    status: "active",
    fuelId: ids.petrol,
    displacementL: 1.5,
    powerHp: 177,
  });
  snapshot.engines.set("old-1", {
    id: ids.engineOld,
    status: "archived",
    fuelId: ids.petrol,
    displacementL: 2,
    powerHp: null,
  });
  snapshot.modifications.set(
    identityKey({
      generationId: ids.coolrayI,
      bodyTypeId: ids.crossover,
      engineId: ids.engine15,
      transmissionTypeId: ids.dct,
      driveTypeId: ids.fwd,
      yearFrom: 2020,
      yearTo: null,
    }),
    { id: ids.existing, status: "active", market: "kz" },
  );
  snapshot.modifications.set(
    identityKey({
      generationId: ids.atlasI,
      bodyTypeId: ids.crossover,
      engineId: ids.engine15,
      transmissionTypeId: ids.at,
      driveTypeId: ids.awd,
      yearFrom: 2018,
      yearTo: 2022,
    }),
    { id: ids.archived, status: "archived", market: "kz" },
  );
  return snapshot;
}

const coolray: RowValues = {
  make: "Geely",
  model: "Coolray",
  generation: "I (SX11)",
  body: "crossover",
  engine_code: "JLH-3G15TD",
  transmission: "dct",
  drive: "fwd",
  year_from: "2020",
  year_to: "",
  market: "kz",
};

/** Plans rows in order the way the report is made. */
function planAll(rows: RowValues[], snapshot = catalog()): PlannedRow[] {
  const seen = newSeenRows();
  return rows.map((values, index) => {
    const rowNumber = index + 2;
    const plan = planRow(values, snapshot, seen);
    commitRow(rowNumber, values, plan, placeholderIds(rowNumber, plan.needs), snapshot, seen);
    return { rowNumber, plan };
  });
}

const codes = (row: PlannedRow) => row.plan.reasons.map((reason) => reason.code);

describe("planning import rows", () => {
  it("finds the same modification unchanged, and updates it when only the market differs", () => {
    const [same, other] = planAll([coolray, { ...coolray, market: "GLOBAL", year_to: "" }]);
    expect(same!.plan).toMatchObject({
      action: "unchanged",
      resolved: { modificationId: ids.existing },
    });
    // The second row is the same modification: a duplicate of row 2 in this file.
    expect(codes(other!)).toEqual(["duplicate_in_file"]);
    const [updated] = planAll([{ ...coolray, market: "global" }]);
    expect(updated!.plan).toMatchObject({
      action: "update",
      resolved: { modificationId: ids.existing, market: "global" },
    });
  });

  it("matches a make whatever its case, spaces and spelling («GEELY», «Джили»)", () => {
    const [upper, cyrillic] = planAll([
      { ...coolray, make: "GEELY", market: "global" },
      { ...coolray, make: "Джили", body: "sedan" },
    ]);
    expect(upper!.plan.action).toBe("update");
    expect(cyrillic!.plan).toMatchObject({ action: "create", needs: {} });
  });

  it("creates what a row needs and lets later rows use it, listing it in the report", () => {
    const planned = planAll([
      {
        ...coolray,
        make: "Haval",
        model: "Jolion",
        generation: "I",
        generation_year_from: "2020",
        engine_code: "GW4B15A",
        engine_fuel: "бензин",
        engine_displacement_l: "1,5",
        engine_power_hp: "143",
        year_from: "2021",
      },
      {
        ...coolray,
        make: "HAVAL",
        model: "jolion",
        generation: "i",
        engine_code: "gw4b15a",
        drive: "awd",
        year_from: "2021",
      },
    ]);
    expect(planned.map((row) => row.plan.action)).toEqual(["create", "create"]);
    expect(planned[0]!.plan.needs).toEqual({
      make: { name: "Haval" },
      model: { name: "Jolion" },
      generation: { name: "I", yearFrom: 2020, yearTo: null },
      engine: { code: "GW4B15A", fuelId: ids.petrol, displacementL: 1.5, powerHp: 143 },
    });
    expect(planned[1]!.plan.needs).toEqual({});
    const report = buildReport(planned);
    expect(report).toMatchObject({
      create: 2,
      update: 0,
      unchanged: 0,
      rejected: 0,
      newMakes: [{ row: 2, name: "Haval" }],
      newModels: [{ row: 2, make: "Haval", name: "Jolion" }],
      newGenerations: [{ row: 2, make: "Haval", model: "Jolion", name: "I", yearFrom: 2020 }],
      newEngines: [{ row: 2, code: "GW4B15A" }],
    });
  });

  it("rejects an unknown or archived option instead of creating one", () => {
    const [unknown, archived] = planAll([
      { ...coolray, body: "пикап" },
      { ...coolray, body: "cabrio" },
    ]);
    expect(unknown!.plan.reasons).toEqual([
      expect.objectContaining({ code: "unknown_option", column: "body" }),
    ]);
    expect(codes(archived!)).toEqual(["archived_reference"]);
  });

  it("rejects years outside the generation, and a still-made modification of an ended one", () => {
    const [outside, open] = planAll([
      { ...coolray, model: "Atlas", generation: "I (NL-3)", year_from: "2021", year_to: "2024" },
      { ...coolray, model: "Atlas", generation: "I (NL-3)", year_from: "2018" },
    ]);
    expect(codes(outside!)).toEqual(["years_outside_generation"]);
    expect(codes(open!)).toEqual(["years_outside_generation"]);
  });

  it("rejects a row of a generation that doesn't exist unless it gives the generation's years", () => {
    const [missing, created] = planAll([
      { ...coolray, generation: "II" },
      { ...coolray, generation: "II", generation_year_from: "2023", year_from: "2024" },
    ]);
    expect(codes(missing!)).toEqual(["generation_not_found"]);
    expect(created!.plan).toMatchObject({
      action: "create",
      needs: { generation: { name: "II", yearFrom: 2023, yearTo: null } },
    });
  });

  it("rejects generation years that differ from the catalog's or an earlier row's", () => {
    const [catalogYears, first, second] = planAll([
      { ...coolray, generation_year_from: "2018" },
      { ...coolray, generation: "II", generation_year_from: "2023", year_from: "2024" },
      {
        ...coolray,
        generation: "II",
        generation_year_from: "2022",
        year_from: "2024",
        drive: "awd",
      },
    ]);
    expect(codes(catalogYears!)).toEqual(["generation_years_mismatch"]);
    expect(first!.plan.action).toBe("create");
    expect(second!.plan.reasons[0]).toMatchObject({
      code: "generation_years_mismatch",
      message: expect.stringContaining("row 3") as unknown,
    });
  });

  it("never changes an existing engine: other values are a mismatch; a new engine needs its fuel", () => {
    const [power, fuel, archived, noFuel] = planAll([
      { ...coolray, engine_power_hp: "150", market: "global" },
      { ...coolray, engine_fuel: "diesel", market: "global" },
      { ...coolray, engine_code: "OLD-1", body: "sedan" },
      { ...coolray, engine_code: "NEW-2", body: "sedan" },
    ]);
    expect(power!.plan.reasons).toEqual([
      expect.objectContaining({ code: "engine_mismatch", column: "engine_power_hp" }),
    ]);
    expect(fuel!.plan.reasons).toEqual([
      expect.objectContaining({ code: "engine_mismatch", column: "engine_fuel" }),
    ]);
    expect(codes(archived!)).toEqual(["archived_reference"]);
    expect(codes(noFuel!)).toEqual(["engine_fuel_required"]);
  });

  it("accepts a row without optional values and one that agrees with the engine it names", () => {
    const [agreeing] = planAll([
      {
        ...coolray,
        engine_displacement_l: "1.50",
        engine_power_hp: "177",
        engine_fuel: "Бензин",
        market: "global",
      },
    ]);
    expect(agreeing!.plan.action).toBe("update");
  });

  it("rejects a row that matches an archived modification, and one of an archived make", () => {
    const [archivedModification, archivedMake] = planAll([
      {
        ...coolray,
        model: "Atlas",
        generation: "I (NL-3)",
        transmission: "at",
        drive: "awd",
        year_from: "2018",
        year_to: "2022",
      },
      { ...coolray, make: "Old make" },
    ]);
    expect(codes(archivedModification!)).toEqual(["matches_archived"]);
    // The archived make has no such generation either: both are said.
    expect(archivedMake!.plan.reasons).toEqual([
      expect.objectContaining({ code: "archived_reference", column: "make" }),
      expect.objectContaining({ code: "generation_not_found", column: "generation" }),
    ]);
  });

  it("names every malformed value of a row at once", () => {
    const [row] = planAll([
      {
        ...coolray,
        make: "",
        year_from: "20x0",
        year_to: "1999",
        market: "ru",
        engine_power_hp: "1.5",
        engine_displacement_l: "abc",
        body: "x".repeat(101),
      },
    ]);
    expect(row!.plan.reasons.map((reason) => `${reason.code}:${reason.column}`).sort()).toEqual(
      [
        "invalid_market:market",
        "invalid_number:engine_displacement_l",
        "invalid_number:engine_power_hp",
        "invalid_year:year_from",
        "missing_value:make",
        "too_long:body",
      ].sort(),
    );
  });

  it("rejects the end before the start and a row that doesn't fit the header", () => {
    const seen = newSeenRows();
    expect(planRow(null, catalog(), seen).reasons[0]).toMatchObject({ code: "wrong_field_count" });
    const [row] = planAll([{ ...coolray, year_from: "2022", year_to: "2021" }]);
    expect(codes(row!)).toEqual(["year_order"]);
  });

  it("finds a row repeated with other case and spaces as a duplicate, even a rejected one", () => {
    const [first, second] = planAll([
      { ...coolray, body: "пикап" },
      { ...coolray, body: "  ПИКАП ", make: "geely" },
    ]);
    expect(codes(first!)).toEqual(["unknown_option"]);
    expect(codes(second!)).toEqual(["duplicate_in_file"]);
  });

  it("counts the report and keeps the first rejected rows with their reasons", () => {
    const planned = planAll([
      coolray,
      { ...coolray, body: "пикап" },
      { ...coolray, body: "sedan" },
    ]);
    expect(buildReport(planned)).toMatchObject({
      create: 1,
      unchanged: 1,
      rejected: 1,
      rejectedRows: [{ row: 3, reasons: [expect.objectContaining({ code: "unknown_option" })] }],
    });
  });
});

import type {
  VehicleGenerationSummary,
  VehicleModificationView,
  VehicleNamed,
} from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  applyOption,
  canSaveDraft,
  carToDraft,
  carYears,
  chosenLevels,
  clearFrom,
  draftToCar,
  EMPTY_DRAFT,
  EMPTY_PICKER_DATA,
  filterOptions,
  generationsForYear,
  levelsClearedBy,
  narrowModifications,
  pickerStage,
  resetBelow,
  resolveStage,
  type CarDraft,
  type PickerData,
} from "./car-picker";

const CURRENT_YEAR = 2026;
const STILL_MADE = "по настоящее время";

function make(id: string, name: string, aliases: string[] = []): VehicleNamed {
  return { id, name, aliases };
}

function generation(
  id: string,
  name: string,
  yearFrom: number,
  yearTo: number | null,
): VehicleGenerationSummary {
  return { id, name, yearFrom, yearTo };
}

function option(id: string, name: string) {
  return { id, code: id, name: { text: name, isFallback: false } };
}

function modification(
  id: string,
  parts: {
    body: string;
    engine: string;
    transmission: string;
    drive: string;
    yearFrom?: number;
    yearTo?: number | null;
  },
): VehicleModificationView {
  return {
    id,
    bodyType: option(`body-${parts.body}`, parts.body),
    engine: {
      id: `engine-${parts.engine}`,
      code: parts.engine,
      displacementL: 1.5,
      powerHp: 150,
      fuel: option("fuel-petrol", "Бензин"),
    },
    transmissionType: option(`tr-${parts.transmission}`, parts.transmission),
    driveType: option(`drive-${parts.drive}`, parts.drive),
    yearFrom: parts.yearFrom ?? 2023,
    yearTo: parts.yearTo ?? null,
    market: "kz",
  };
}

function stage(draft: CarDraft, data: Partial<PickerData>) {
  return pickerStage({
    draft,
    data: { ...EMPTY_PICKER_DATA, ...data },
    currentYear: CURRENT_YEAR,
    stillMade: STILL_MADE,
  });
}

const GEELY = make("make-geely", "Geely", ["Джили"]);
const ATLAS = make("model-atlas", "Atlas");
const COOLRAY = make("model-coolray", "Coolray");
const GEN_I = generation("gen-1", "I (NL-3)", 2016, 2022);
const GEN_II = generation("gen-2", "II (FX11)", 2021, null);

describe("the order of the steps", () => {
  it("asks for the data of a step before the step", () => {
    expect(stage(EMPTY_DRAFT, {})).toEqual({ kind: "load", data: "makes" });
    const withMake = applyOption(EMPTY_DRAFT, "make", { id: GEELY.id, label: GEELY.name });
    expect(stage(withMake, { makes: [GEELY] })).toEqual({ kind: "load", data: "models" });
  });

  it("asks for a make when there is more than one", () => {
    const result = stage(EMPTY_DRAFT, { makes: [GEELY, make("make-chery", "Chery")] });
    expect(result).toMatchObject({ kind: "choose", step: "make" });
  });

  it("takes the only option of a step by itself", () => {
    const result = stage(EMPTY_DRAFT, { makes: [GEELY] });
    expect(result).toEqual({
      kind: "auto",
      step: "make",
      option: { id: GEELY.id, label: "Geely", aliases: ["Джили"] },
    });
  });

  it("offers the years of every generation of the model, newest first", () => {
    const draft = { ...EMPTY_DRAFT, make: pick(GEELY), model: pick(ATLAS) };
    const result = stage(draft, { makes: [GEELY], models: [ATLAS], generations: [GEN_I, GEN_II] });
    expect(result).toMatchObject({ kind: "choose", step: "year" });
    if (result.kind !== "choose") throw new Error("expected a choice");
    expect(result.options[0]?.label).toBe(String(CURRENT_YEAR));
    expect(result.options.map((item) => item.id)).toContain("2016");
  });
});

describe("the generation", () => {
  it("is asked only when the year falls into two of them", () => {
    const base = { ...EMPTY_DRAFT, make: pick(GEELY), model: pick(ATLAS) };
    const data = { makes: [GEELY], models: [ATLAS], generations: [GEN_I, GEN_II] };

    // 2021 belongs to both — the step is shown.
    const overlap = stage({ ...base, year: 2021 }, data);
    expect(overlap).toMatchObject({ kind: "choose", step: "generation" });
    if (overlap.kind !== "choose") throw new Error("expected a choice");
    expect(overlap.options.map((item) => item.id)).toEqual(["gen-1", "gen-2"]);
    expect(overlap.options[0]?.hint).toBe("2016 — 2022");
    expect(overlap.options[1]?.hint).toBe(`2021 — ${STILL_MADE}`);

    // 2023 belongs to one — it is taken without asking.
    expect(stage({ ...base, year: 2023 }, data)).toMatchObject({
      kind: "auto",
      step: "generation",
      option: { id: "gen-2" },
    });
  });

  it("stops after the model when the catalog has no generations at all", () => {
    const draft = { ...EMPTY_DRAFT, make: pick(GEELY), model: pick(ATLAS) };
    expect(stage(draft, { makes: [GEELY], models: [ATLAS], generations: [] })).toEqual({
      kind: "done",
    });
  });

  it("lists the generations of a year", () => {
    expect(generationsForYear([GEN_I, GEN_II], 2021).map((item) => item.id)).toEqual([
      "gen-1",
      "gen-2",
    ]);
    expect(generationsForYear([GEN_I, GEN_II], 2024).map((item) => item.id)).toEqual(["gen-2"]);
    expect(generationsForYear([GEN_I, GEN_II], null)).toHaveLength(2);
  });

  it("counts the years of a still-made generation up to this year", () => {
    expect(carYears([generation("g", "I", 2024, null)], 2026)).toEqual([2026, 2025, 2024]);
    expect(carYears([], 2026)).toEqual([]);
  });
});

describe("body, engine, transmission and drive", () => {
  const MODS = [
    modification("m1", {
      body: "Внедорожник",
      engine: "JLH-4G20TD",
      transmission: "Автомат",
      drive: "Полный",
    }),
    modification("m2", {
      body: "Внедорожник",
      engine: "JLH-4G20TD",
      transmission: "Автомат",
      drive: "Передний",
    }),
    modification("m3", {
      body: "Внедорожник",
      engine: "JLH-3G15TD",
      transmission: "Робот",
      drive: "Передний",
    }),
  ];
  const base: CarDraft = {
    ...EMPTY_DRAFT,
    make: pick(GEELY),
    model: pick(ATLAS),
    year: 2024,
    generation: { id: GEN_II.id, label: GEN_II.name },
  };
  const data = {
    makes: [GEELY],
    models: [ATLAS],
    generations: [GEN_I, GEN_II],
    modifications: MODS,
  };

  it("loads the modifications once the generation is known", () => {
    expect(stage(base, { ...data, modifications: null })).toEqual({
      kind: "load",
      data: "modifications",
    });
  });

  it("takes the only body by itself and then asks for the engine", () => {
    expect(stage(base, data)).toMatchObject({ kind: "auto", step: "body" });
    const withBody = applyOption(base, "body", { id: "body-Внедорожник", label: "Внедорожник" });
    const engines = stage(withBody, data);
    expect(engines).toMatchObject({ kind: "choose", step: "engine" });
    if (engines.kind !== "choose") throw new Error("expected a choice");
    expect(engines.options.map((item) => item.label)).toEqual(["JLH-4G20TD", "JLH-3G15TD"]);
    expect(engines.options[0]?.hint).toBe("1.5 л · 150 л. с. · Бензин");
  });

  it("narrows the next step by what is already chosen", () => {
    const draft: CarDraft = {
      ...base,
      body: { id: "body-Внедорожник", label: "Внедорожник" },
      engine: { id: "engine-JLH-4G20TD", label: "JLH-4G20TD" },
      transmission: { id: "tr-Автомат", label: "Автомат" },
    };
    const drives = stage(draft, data);
    expect(drives).toMatchObject({ kind: "choose", step: "drive" });
    if (drives.kind !== "choose") throw new Error("expected a choice");
    expect(drives.options.map((item) => item.label)).toEqual(["Полный", "Передний"]);
  });

  it("ignores a year no modification covers instead of leaving an empty step", () => {
    const rows = narrowModifications(MODS, { ...base, year: 1999 });
    expect(rows).toHaveLength(3);
  });

  it("stops when every level is chosen", () => {
    const draft: CarDraft = {
      ...base,
      body: { id: "body-Внедорожник", label: "Внедорожник" },
      engine: { id: "engine-JLH-3G15TD", label: "JLH-3G15TD" },
      transmission: { id: "tr-Робот", label: "Робот" },
      drive: { id: "drive-Передний", label: "Передний" },
    };
    expect(stage(draft, data)).toEqual({ kind: "done" });
    expect(
      draftToCar(draft, { id: "car-1", addedAt: "2026-09-26T10:00:00.000Z", modifications: MODS })
        ?.modificationId,
    ).toBe("m3");
  });

  it("leaves the modification unknown while the levels name more than one", () => {
    const draft: CarDraft = { ...base, body: { id: "body-Внедорожник", label: "Внедорожник" } };
    expect(
      draftToCar(draft, { id: "car-1", addedAt: "2026-09-26T10:00:00.000Z", modifications: MODS })
        ?.modificationId,
    ).toBeNull();
  });
});

describe("changing a step that was already answered", () => {
  const draft: CarDraft = {
    make: pick(GEELY),
    model: pick(ATLAS),
    year: 2024,
    generation: { id: "gen-2", label: "II" },
    body: { id: "body-suv", label: "Внедорожник" },
    engine: { id: "engine-1", label: "JLH-4G20TD" },
    transmission: { id: "tr-at", label: "Автомат" },
    drive: { id: "drive-awd", label: "Полный" },
  };

  it("names what a change of the model would clear", () => {
    expect(levelsClearedBy(draft, "model")).toEqual([
      "year",
      "generation",
      "body",
      "engine",
      "transmission",
      "drive",
    ]);
    expect(levelsClearedBy(draft, "year")).toEqual([
      "generation",
      "body",
      "engine",
      "transmission",
      "drive",
    ]);
    expect(levelsClearedBy(draft, "drive")).toEqual([]);
  });

  it("clears everything below the step it changes", () => {
    const changed = applyOption(draft, "model", { id: COOLRAY.id, label: COOLRAY.name });
    expect(changed.model?.label).toBe("Coolray");
    expect(changed.year).toBeNull();
    expect(changed.engine).toBeNull();
    expect(changed.make?.label).toBe("Geely");

    const year = applyOption(draft, "year", { id: "2019", label: "2019" });
    expect(year.year).toBe(2019);
    expect(year.generation).toBeNull();
    expect(year.transmission).toBeNull();
  });

  it("clears the step itself when a parameter is filled in again", () => {
    const cleared = clearFrom(draft, "engine");
    expect(cleared.engine).toBeNull();
    expect(cleared.transmission).toBeNull();
    expect(cleared.body?.label).toBe("Внедорожник");
    expect(resetBelow(draft, "engine").engine?.label).toBe("JLH-4G20TD");
  });

  it("shows what has been chosen so far", () => {
    expect(chosenLevels(draft).map((item) => item.label)).toEqual([
      "Geely",
      "Atlas",
      "2024",
      "II",
      "Внедорожник",
      "JLH-4G20TD",
      "Автомат",
      "Полный",
    ]);
  });

  it("turns a stored car back into a draft", () => {
    const car = draftToCar(draft, {
      id: "car-1",
      addedAt: "2026-09-26T10:00:00.000Z",
      modifications: [],
    });
    expect(car).not.toBeNull();
    if (!car) throw new Error("expected a car");
    expect(carToDraft(car)).toEqual(draft);
  });
});

describe("taking every single option at once", () => {
  const ONE_MOD = [
    modification("m1", {
      body: "Внедорожник",
      engine: "JLH-4G20TD",
      transmission: "Автомат",
      drive: "Полный",
      yearFrom: 2023,
    }),
  ];

  function resolve(draft: CarDraft, data: Partial<PickerData>) {
    return resolveStage({
      draft,
      data: { ...EMPTY_PICKER_DATA, ...data },
      currentYear: CURRENT_YEAR,
      stillMade: STILL_MADE,
    });
  }

  it("stops at the first answer of the server it does not have yet", () => {
    const step = resolve(EMPTY_DRAFT, { makes: [GEELY] });
    expect(step.draft.make?.label).toBe("Geely");
    expect(step.stage).toEqual({ kind: "load", data: "models" });
  });

  it("walks every single-option step down to the drive in one go", () => {
    const resolved = resolve(
      { ...EMPTY_DRAFT, make: pick(GEELY), model: pick(ATLAS), year: 2024 },
      { makes: [GEELY], models: [ATLAS], generations: [GEN_II], modifications: ONE_MOD },
    );
    expect(resolved.stage).toEqual({ kind: "done" });
    expect(resolved.draft.generation?.label).toBe("II (FX11)");
    expect(resolved.draft.engine?.label).toBe("JLH-4G20TD");
    expect(resolved.draft.drive?.label).toBe("Полный");
  });

  it("never loops on data that offers nothing", () => {
    const resolved = resolve(
      { ...EMPTY_DRAFT, make: pick(GEELY), model: pick(ATLAS) },
      { makes: [GEELY], models: [ATLAS], generations: [] },
    );
    expect(resolved.stage).toEqual({ kind: "done" });
    expect(resolved.draft.year).toBeNull();
  });
});

describe("saving as it is", () => {
  it("needs the make and the model and nothing else", () => {
    expect(canSaveDraft(EMPTY_DRAFT)).toBe(false);
    expect(canSaveDraft({ ...EMPTY_DRAFT, make: pick(GEELY) })).toBe(false);
    expect(canSaveDraft({ ...EMPTY_DRAFT, make: pick(GEELY), model: pick(ATLAS) })).toBe(true);
    expect(
      draftToCar(
        { ...EMPTY_DRAFT, make: pick(GEELY), model: pick(ATLAS) },
        { id: "car-1", addedAt: "2026-09-26T10:00:00.000Z", modifications: [] },
      ),
    ).toMatchObject({ year: null, engine: null, modificationId: null });
  });
});

describe("search inside a step", () => {
  it("matches the label and the other spellings of the catalog", () => {
    const options = [
      { id: "1", label: "Geely", aliases: ["Джили"] },
      { id: "2", label: "Chery" },
    ];
    expect(filterOptions(options, "джил").map((item) => item.id)).toEqual(["1"]);
    expect(filterOptions(options, "ery").map((item) => item.id)).toEqual(["2"]);
    expect(filterOptions(options, "  ")).toHaveLength(2);
  });
});

function pick(value: VehicleNamed) {
  return { id: value.id, label: value.name };
}

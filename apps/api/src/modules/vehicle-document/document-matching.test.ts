import type { VehicleGenerationSummary, VehicleModificationView } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  matchColor,
  matchEngines,
  matchGeneration,
  matchNamed,
  modelTexts,
  splitMakeModel,
} from "./document-matching";
import { documentFields, documentKind } from "./vehicle-document.service";

const MAKES = [
  { id: "geely", name: "Geely", aliases: ["Geely Auto", "Джили"] },
  { id: "chery", name: "Chery", aliases: ["Чери"] },
];

const MODELS = [
  { id: "coolray", name: "Coolray", aliases: ["Кулрей"] },
  { id: "atlas", name: "Atlas", aliases: ["Атлас"] },
  { id: "atlas-pro", name: "Atlas Pro", aliases: ["Атлас Про"] },
];

const GENERATIONS: VehicleGenerationSummary[] = [
  { id: "atlas-1", name: "I (NL-3)", yearFrom: 2016, yearTo: 2022 },
  { id: "atlas-2", name: "II (FX11)", yearFrom: 2023, yearTo: null },
];

function modification(
  id: string,
  engine: { id: string; code: string; displacementL: number | null },
  yearFrom: number,
  yearTo: number | null,
): VehicleModificationView {
  const option = { id: "o", code: "o", name: { text: "x", isFallback: false } };
  return {
    id,
    bodyType: option,
    engine: { ...engine, powerHp: null, fuel: option },
    transmissionType: option,
    driveType: option,
    yearFrom,
    yearTo,
    market: "kz",
  } as unknown as VehicleModificationView;
}

describe("make and model by the catalog's spellings", () => {
  it("finds a make by any spelling, case and spaces aside («ДЖИЛИ» → Geely)", () => {
    expect(matchNamed(["GEELY"], MAKES)).toMatchObject({
      status: "exact",
      value: { id: "geely", label: "Geely" },
    });
    expect(matchNamed(["ДЖИЛИ"], MAKES).value?.id).toBe("geely");
    expect(matchNamed(["geely auto"], MAKES).value?.id).toBe("geely");
  });

  it("does not take a make the catalog does not have: not found, the text stays for «Распознали „…“»", () => {
    expect(matchNamed(["TOYOTA"], MAKES)).toEqual({
      status: "not_found",
      value: null,
      candidates: [],
    });
    expect(matchNamed([null], MAKES).status).toBe("not_found");
  });

  it("tells «Atlas» from «Atlas Pro» exactly", () => {
    expect(matchNamed(["ATLAS"], MODELS).value?.id).toBe("atlas");
    expect(matchNamed(["ATLAS PRO"], MODELS).value?.id).toBe("atlas-pro");
  });

  it("offers a model the text begins with as a candidate, never takes it by itself", () => {
    const found = matchNamed(["COOLRAY SX11"], MODELS);
    expect(found.status).toBe("candidates");
    expect(found.candidates.map((candidate) => candidate.id)).toEqual(["coolray"]);
  });

  it("reads a model that repeats the make in front of it", () => {
    expect(modelTexts("GEELY", "GEELY COOLRAY")).toEqual(["GEELY COOLRAY", "COOLRAY"]);
    expect(matchNamed(modelTexts("GEELY", "GEELY COOLRAY"), MODELS).value?.id).toBe("coolray");
  });

  it("splits «Марка, модель» that came back whole in the make", () => {
    expect(splitMakeModel("GEELY COOLRAY", null)).toEqual({ make: "GEELY", model: "COOLRAY" });
    expect(splitMakeModel("GEELY", "COOLRAY")).toEqual({ make: "GEELY", model: "COOLRAY" });
    expect(splitMakeModel("GEELY", null)).toEqual({ make: "GEELY", model: null });
  });
});

describe("generation by the year", () => {
  it("takes the one generation the year falls into", () => {
    expect(matchGeneration(GENERATIONS, 2023)).toMatchObject({
      status: "exact",
      value: { id: "atlas-2" },
    });
    expect(matchGeneration(GENERATIONS, 2018).value?.id).toBe("atlas-1");
  });

  it("offers both when the years of two generations overlap", () => {
    const overlapping = [
      ...GENERATIONS,
      { id: "x", name: "Restyle", yearFrom: 2020, yearTo: 2023 },
    ];
    expect(matchGeneration(overlapping, 2023).status).toBe("candidates");
  });

  it("chooses nothing for a year outside every generation, or without a year", () => {
    expect(matchGeneration(GENERATIONS, 2010).status).toBe("not_found");
    expect(matchGeneration(GENERATIONS, null).status).toBe("not_found");
  });
});

describe("engines by the size", () => {
  const MODIFICATIONS = [
    modification("m1", { id: "e15", code: "JLH-3G15TD", displacementL: 1.5 }, 2019, null),
    modification("m2", { id: "e15b", code: "BHE15-EFZ", displacementL: 1.5 }, 2021, null),
    modification("m3", { id: "e20", code: "JLH-4G20TD", displacementL: 2.0 }, 2019, null),
    modification("m4", { id: "e15", code: "JLH-3G15TD", displacementL: 1.5 }, 2019, 2020),
    modification("m5", { id: "eold", code: "OLD-15", displacementL: 1.5 }, 2010, 2015),
  ];

  it("offers the 1.5 l engines of the year for 1477 cm³, once each", () => {
    const found = matchEngines(MODIFICATIONS, 2024, 1477);
    expect(found.status).toBe("candidates");
    expect(found.candidates).toEqual([
      { id: "e15", label: "JLH-3G15TD" },
      { id: "e15b", label: "BHE15-EFZ" },
    ]);
  });

  it("stays a candidate even when only one engine fits — the certificate has no code", () => {
    expect(matchEngines(MODIFICATIONS, 2024, 1969)).toMatchObject({
      status: "candidates",
      candidates: [{ id: "e20" }],
    });
  });

  it("asks the step as usual without a size or a fit", () => {
    expect(matchEngines(MODIFICATIONS, 2024, null).status).toBe("not_found");
    expect(matchEngines(MODIFICATIONS, 2024, 3500).status).toBe("not_found");
  });
});

describe("colour of the fixed list (D-063)", () => {
  it.each([
    ["БЕЛЫЙ", "white"],
    ["белый перламутр", "white"],
    ["ЧЁРНЫЙ", "black"],
    ["ТЕМНО-СИНИЙ", "darkBlue"],
    ["синий", "blue"],
    ["СЕРЕБРИСТЫЙ МЕТАЛЛИК", "silver"],
    ["СВЕТЛО-СЕРЫЙ", "gray"],
    ["АҚ", "white"],
    ["Қара", "black"],
    ["вишневый", "burgundy"],
    ["Blue", "blue"],
  ])("%s → %s", (text, id) => {
    expect(matchColor(text)).toBe(id);
  });

  it("is no colour of the list for anything else", () => {
    expect(matchColor("ХАМЕЛЕОН")).toBeNull();
    expect(matchColor(null)).toBeNull();
    expect(matchColor("АҚШЫЛ")).toBeNull();
  });
});

describe("the answer of the model, checked", () => {
  const read = {
    documentKind: "kz_registration" as const,
    make: " GEELY ",
    model: "COOLRAY",
    year: 2024,
    vin: "l6t7844z0rn001234",
    plate: "777 abc 02",
    engineVolumeCc: 1477,
    color: "СЕРЫЙ",
  };

  it("keeps a VIN and a plate that are ones, compact and in upper case", () => {
    expect(documentFields(read, 2026)).toEqual({
      make: "GEELY",
      model: "COOLRAY",
      year: 2024,
      vin: "L6T7844Z0RN001234",
      plate: "777ABC02",
      engineVolumeCc: 1477,
      color: "СЕРЫЙ",
    });
  });

  it("leaves a VIN with O in it and a foreign plate empty — never a guess", () => {
    const fields = documentFields({ ...read, vin: "L6T7844Z0RNOO1234", plate: "А123ВС77" }, 2026);
    expect(fields.vin).toBeNull();
    expect(fields.plate).toBeNull();
  });

  it("drops a year of the future and a size that can't be an engine", () => {
    const fields = documentFields({ ...read, year: 2031, engineVolumeCc: 12 }, 2026);
    expect(fields.year).toBeNull();
    expect(fields.engineVolumeCc).toBeNull();
  });

  it("tells the person a certificate nothing could be read from is unreadable", () => {
    const empty = { ...read, make: null, model: null, vin: null, plate: null };
    expect(documentKind(empty, documentFields(empty, 2026))).toBe("unreadable");
    expect(documentKind(read, documentFields(read, 2026))).toBe("kz_registration");
  });

  it("calls a picture that is no document another document, and another document — that", () => {
    const none = { ...read, make: null, model: null, vin: null, plate: null };
    expect(
      documentKind({ ...none, documentKind: "not_document" }, documentFields(none, 2026)),
    ).toBe("other_document");
    expect(
      documentKind({ ...none, documentKind: "other_document" }, documentFields(none, 2026)),
    ).toBe("other_document");
  });
});

import type { VehicleDocumentResponse } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT } from "./car-picker";
import {
  checkDocumentFields,
  confirmationMerge,
  recognitionFailureOf,
  recognitionResultFailure,
  recognitionStart,
  stillRecognized,
  unplacedText,
  withSuggestions,
} from "./document-flow";
import type { GarageCar } from "./garage";

const NONE = { status: "not_found" as const, value: null, candidates: [] };

function answer(overrides: Partial<VehicleDocumentResponse> = {}): VehicleDocumentResponse {
  return {
    result: "kz_registration",
    fields: {
      make: "GEELY",
      model: "COOLRAY",
      year: 2024,
      vin: "L6T7844Z0RN001234",
      plate: "777ABC02",
      engineVolumeCc: 1477,
      color: "СЕРЫЙ",
    },
    match: {
      make: { status: "exact", value: { id: "geely", label: "Geely" }, candidates: [] },
      model: { status: "exact", value: { id: "coolray", label: "Coolray" }, candidates: [] },
      generation: {
        status: "exact",
        value: { id: "sx11", label: "I (SX11)" },
        candidates: [{ id: "sx11", label: "I (SX11)" }],
      },
      engine: {
        status: "candidates",
        value: null,
        candidates: [
          { id: "e15", label: "JLH-3G15TD" },
          { id: "e15b", label: "BHE15-EFZ" },
        ],
      },
      color: { status: "exact", value: "gray" },
    },
    documentProof: "vd1.proof",
    attempts: { scope: "guest", remaining: 2, limit: 3 },
    ...overrides,
  };
}

describe("a recognised certificate in the steps (M-GAR-05)", () => {
  it("chooses make, model, year and the one generation; the engines are to choose among", () => {
    const { draft, recognition } = recognitionStart(answer());
    expect(draft).toEqual({
      ...EMPTY_DRAFT,
      make: { id: "geely", label: "Geely" },
      model: { id: "coolray", label: "Coolray" },
      year: 2024,
      generation: { id: "sx11", label: "I (SX11)" },
    });
    expect(recognition.engineIds).toEqual(["e15", "e15b"]);
    expect(recognition.color).toBe("gray");
    expect(recognition.proof).toBe("vd1.proof");
  });

  it("leaves a make the catalog lacks empty and names it on its step; nothing below is chosen", () => {
    const { draft, recognition } = recognitionStart(
      answer({
        fields: { ...answer().fields, make: "TOYOTA", model: "CAMRY" },
        match: { ...answer().match, make: NONE, model: NONE, generation: NONE, engine: NONE },
      }),
    );
    expect(draft).toEqual(EMPTY_DRAFT);
    expect(unplacedText(recognition, "make", draft)).toBe("TOYOTA");
    expect(
      unplacedText(recognition, "model", { ...draft, make: { id: "toyota", label: "Toyota" } }),
    ).toBe("CAMRY");
  });

  it("keeps the generation open when the year is outside every one, and suggests the year", () => {
    const { draft, recognition } = recognitionStart(
      answer({ match: { ...answer().match, generation: NONE, engine: NONE } }),
    );
    expect(draft.year).toBe(2024);
    expect(draft.generation).toBeNull();
    expect(unplacedText(recognition, "engine", draft)).toBe("1477 см³");
  });

  it("puts suggestions first on a step and marks them, dropping nothing", () => {
    const { recognition } = recognitionStart(answer());
    const options = [
      { id: "e20", label: "JLH-4G20TD" },
      { id: "e15b", label: "BHE15-EFZ" },
      { id: "e15", label: "JLH-3G15TD" },
    ];
    const { options: ordered, suggested } = withSuggestions(recognition, "engine", options);
    expect(ordered.map((option) => option.id)).toEqual(["e15b", "e15", "e20"]);
    expect([...suggested]).toEqual(["e15", "e15b"]);
    expect(withSuggestions(undefined, "engine", options).suggested.size).toBe(0);
  });

  it("marks a level «распознано» only while it holds what was read", () => {
    const { draft, recognition } = recognitionStart(answer());
    expect(stillRecognized(recognition, draft, "make")).toBe(true);
    expect(stillRecognized(recognition, draft, "year")).toBe(true);
    expect(stillRecognized(recognition, { ...draft, year: 2023 }, "year")).toBe(false);
    expect(stillRecognized(recognition, draft, "engine")).toBe(false);
  });
});

describe("VIN and plate on the final step (T-GAR-07)", () => {
  it("takes them in any writing and keeps them as the server will", () => {
    expect(checkDocumentFields(" l6t7844z0rn001234 ", "777 abc 02")).toEqual({
      vin: "L6T7844Z0RN001234",
      plate: "777ABC02",
      errors: {},
    });
    expect(checkDocumentFields("", "")).toEqual({ vin: null, plate: null, errors: {} });
  });

  it("says what is wrong", () => {
    expect(checkDocumentFields("L6T7844Z0RN00123", "").errors).toEqual({ vin: "vin_length" });
    expect(checkDocumentFields("L6T7844Z0RNO01234", "А123ВС77").errors).toEqual({
      vin: "vin_characters",
      plate: "plate",
    });
  });
});

describe("«Подтвердить техпаспортом» (M-GAR-06)", () => {
  const car = {
    vin: null,
    plate: "777ABC02",
  } as unknown as GarageCar;

  it("fills what is empty and asks about what differs", () => {
    expect(confirmationMerge(car, answer().fields)).toEqual({
      fill: { vin: "L6T7844Z0RN001234" },
      conflicts: [],
    });
    expect(confirmationMerge({ ...car, plate: "111AAA01" }, answer().fields).conflicts).toEqual([
      { field: "plate", current: "111AAA01", read: "777ABC02" },
    ]);
  });
});

describe("states of M-GAR-04", () => {
  it("reads every failure the screen has a state for", () => {
    expect(recognitionFailureOf({ code: "NETWORK_ERROR" })).toBe("offline");
    expect(recognitionFailureOf({ code: "RATE_LIMITED" })).toBe("limit");
    expect(recognitionFailureOf({ code: "VEHICLE_DOCUMENT_UNAVAILABLE" })).toBe("unavailable");
    expect(recognitionFailureOf({ code: "VEHICLE_DOCUMENT_INVALID" })).toBe("invalid");
    expect(recognitionFailureOf(new Error("anything"))).toBe("unavailable");
    expect(recognitionResultFailure(answer({ result: "other_document" }))).toBe("other_document");
    expect(recognitionResultFailure(answer({ result: "unreadable" }))).toBe("not_readable");
    expect(recognitionResultFailure(answer())).toBeNull();
  });
});

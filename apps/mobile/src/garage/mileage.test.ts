import { describe, expect, it } from "vitest";
import { toTransferBody } from "./account-cars";
import { addCar, INITIAL_GARAGE, parseGarage, type GarageCar } from "./garage";
import {
  dashboardOutcome,
  formatKm,
  lowerThanLast,
  MileageLowerError,
  withGuestMileage,
} from "./mileage";

function car(overrides: Partial<GarageCar> = {}): GarageCar {
  return {
    id: "car-1",
    make: { id: "make-1", label: "Geely" },
    model: { id: "model-1", label: "Atlas" },
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
    mileage: null,
    addedAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-11-10T08:00:00.000Z");

describe("a guest's mileage on the device (TASK-058)", () => {
  const garage = addCar(INITIAL_GARAGE, car());

  it("keeps a reading from a photo with what the photo read", () => {
    const next = withGuestMileage(
      garage,
      "car-1",
      { valueKm: 45_250, source: "photo", recognizedKm: 45_200, recognitionId: "x" },
      false,
      NOW,
    );
    expect(next.cars[0]!.mileage).toEqual({
      valueKm: 45_250,
      source: "photo",
      recordedAt: NOW.toISOString(),
      recognizedKm: 45_200,
    });
  });

  it("asks about a lower reading, takes it once confirmed, and changes nothing for the same one", () => {
    const first = withGuestMileage(
      garage,
      "car-1",
      { valueKm: 45_200, source: "text" },
      false,
      NOW,
    );
    expect(withGuestMileage(first, "car-1", { valueKm: 45_200, source: "text" }, false, NOW)).toBe(
      first,
    );
    let refused: unknown;
    try {
      withGuestMileage(first, "car-1", { valueKm: 30_000, source: "text" }, false, NOW);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(MileageLowerError);
    expect(lowerThanLast(refused)).toBe(45_200);
    const confirmed = withGuestMileage(
      first,
      "car-1",
      { valueKm: 30_000, source: "text" },
      true,
      NOW,
    );
    expect(confirmed.cars[0]!.mileage?.valueKm).toBe(30_000);
  });

  it("reads the server's refusal the same way", () => {
    expect(lowerThanLast({ code: "GARAGE_MILEAGE_LOWER", details: { lastKm: 32_000 } })).toBe(
      32_000,
    );
    expect(lowerThanLast({ code: "NOT_FOUND" })).toBeNull();
  });

  it("survives the device's storage and goes with the transfer", () => {
    const next = withGuestMileage(
      garage,
      "car-1",
      { valueKm: 45_200, source: "photo", recognizedKm: 45_200 },
      false,
      NOW,
    );
    const stored = parseGarage(JSON.parse(JSON.stringify(next)));
    expect(stored?.cars[0]!.mileage?.valueKm).toBe(45_200);
    // A garage stored before TASK-058 has no reading at all.
    expect(
      parseGarage({ version: 1, cars: [{ ...car(), mileage: undefined }] })?.cars[0]!.mileage,
    ).toBeNull();
    expect(toTransferBody(next).cars[0]!.mileage).toEqual({
      valueKm: 45_200,
      source: "photo",
      recordedAt: NOW.toISOString(),
      recognizedKm: 45_200,
    });
    expect(toTransferBody(garage).cars[0]).not.toHaveProperty("mileage");
  });
});

describe("the photo of the dashboard", () => {
  const attempts = { scope: "guest" as const, remaining: 2, limit: 3 };

  it("gives a reading to check, in kilometres, saying when the panel counted miles", () => {
    expect(
      dashboardOutcome({
        kind: "dashboard",
        mileageKm: 45_202,
        unit: "mi",
        confidence: 0.9,
        tripMeterSeen: false,
        recognitionId: "r",
        attempts,
      }),
    ).toEqual({ kind: "read", km: 45_202, miles: true, recognitionId: "r" });
  });

  it("gives nothing to check for what is not a dashboard or can't be read", () => {
    for (const kind of ["not_dashboard", "unreadable"] as const) {
      expect(
        dashboardOutcome({
          kind,
          mileageKm: null,
          unit: null,
          confidence: 0.5,
          tripMeterSeen: false,
          recognitionId: null,
          attempts,
        }),
      ).toEqual({ kind: "not_read" });
    }
  });

  it("formats the kilometres with a narrow space between thousands", () => {
    expect(formatKm(45_200)).toBe("45\u202f200");
    expect(formatKm(7)).toBe("7");
  });
});

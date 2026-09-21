import { describe, expect, it } from "vitest";
import { errorCodeSchema } from "./error";
import { apiRoutes } from "./routes";
import {
  createVehicleGenerationBodySchema,
  createVehicleModificationBodySchema,
  createVehicleOptionBodySchema,
  vehicleImportColumns,
  vehicleImportRequiredColumns,
  vehicleModificationListQuerySchema,
} from "./vehicles";

const ID = "4f2a1b3c-5d6e-4f70-8a91-b2c3d4e5f607";

describe("vehicle catalog contract (TASK-014)", () => {
  it("takes a reference list option with Russian required and a stable code", () => {
    expect(
      createVehicleOptionBodySchema.safeParse({
        kind: "body",
        code: "sedan",
        names: { ru: "Седан" },
      }).success,
    ).toBe(true);
    expect(
      createVehicleOptionBodySchema.safeParse({
        kind: "body",
        code: "Sedan",
        names: { ru: "Седан" },
      }).success,
    ).toBe(false);
    expect(
      createVehicleOptionBodySchema.safeParse({
        kind: "colour",
        code: "red",
        names: { ru: "Красный" },
      }).success,
    ).toBe(false);
  });

  it("keeps years within 1900–2100 and an open end allowed", () => {
    const base = { modelId: ID, name: "I" };
    expect(createVehicleGenerationBodySchema.safeParse({ ...base, yearFrom: 2019 }).success).toBe(
      true,
    );
    expect(
      createVehicleGenerationBodySchema.safeParse({ ...base, yearFrom: 2019, yearTo: null })
        .success,
    ).toBe(true);
    expect(createVehicleGenerationBodySchema.safeParse({ ...base, yearFrom: 1899 }).success).toBe(
      false,
    );
    expect(
      createVehicleModificationBodySchema.safeParse({
        generationId: ID,
        bodyTypeId: ID,
        engineId: ID,
        transmissionTypeId: ID,
        driveTypeId: ID,
        yearFrom: 2020,
        market: "ru",
      }).success,
    ).toBe(false);
  });

  it("coerces list filters from the query string", () => {
    expect(vehicleModificationListQuerySchema.parse({ year: "2021", limit: "10" })).toMatchObject({
      year: 2021,
      limit: 10,
    });
  });

  it("names the import columns, the required ones among them", () => {
    for (const column of vehicleImportRequiredColumns) {
      expect(vehicleImportColumns).toContain(column);
    }
    expect(vehicleImportRequiredColumns).not.toContain("engine_power_hp");
  });

  it("serves the admin routes to the admin context only and the choice to everyone", () => {
    const routes = Object.values(apiRoutes);
    const admin = routes.filter((route) => route.path.startsWith("/admin/vehicles"));
    expect(admin.length).toBe(31);
    expect(admin.every((route) => "contexts" in route && route.contexts.join() === "admin")).toBe(
      true,
    );
    const client = routes.filter((route) => route.path.startsWith("/vehicles"));
    expect(client.map((route) => route.operationId)).toEqual([
      "getVehicleMakes",
      "getVehicleMakeModels",
      "getVehicleModelGenerations",
      "getVehicleGenerationModifications",
    ]);
    expect(client.every((route) => !("auth" in route))).toBe(true);
    expect(apiRoutes.uploadVehicleImport.upload.contentTypes).toContain("text/csv");
  });

  it("adds the vehicle error codes", () => {
    for (const code of [
      "VEHICLE_VERSION_CONFLICT",
      "VEHICLE_DUPLICATE",
      "VEHICLE_PARENT_ARCHIVED",
      "VEHICLE_REFERENCE_ARCHIVED",
      "VEHICLE_YEARS_INVALID",
      "VEHICLE_IMPORT_FILE_INVALID",
      "VEHICLE_IMPORT_STATE",
    ]) {
      expect(errorCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});

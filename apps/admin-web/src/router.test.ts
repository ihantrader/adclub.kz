import { describe, expect, it } from "vitest";
import {
  locationOf,
  menuOf,
  settingHistoryPath,
  vehicleGenerationPath,
  vehicleImportPath,
  vehicleMakePath,
  vehicleModelPath,
  withQuery,
} from "./router";

describe("admin addresses", () => {
  it("knows every page by its address, with and without a trailing slash", () => {
    expect(locationOf("/").route).toBe("home");
    expect(locationOf("/signals/").route).toBe("signals");
    expect(locationOf("/settings").route).toBe("settings");
    expect(locationOf("/settings/client").route).toBe("clientPolicy");
    expect(locationOf("/settings/cities").route).toBe("cities");
    expect(locationOf("/audit").route).toBe("audit");
    expect(locationOf("/security").route).toBe("security");
    expect(locationOf("/catalog").route).toBe("catalog");
    expect(locationOf("/unknown").route).toBeNull();
  });

  it("knows the levels of the vehicle catalog and its imports by their ids (TASK-035.B)", () => {
    const id = "0b6c9f1e-2a3d-4c5b-8e7f-9a0b1c2d3e4f";
    expect(locationOf("/vehicles").route).toBe("vehicles");
    expect(locationOf("/vehicles/engines").route).toBe("vehicleEngines");
    expect(locationOf("/vehicles/options").route).toBe("vehicleOptions");
    expect(locationOf("/vehicles/imports").route).toBe("vehicleImports");
    expect(locationOf(vehicleMakePath(id))).toMatchObject({ route: "vehicleMake", id });
    expect(locationOf(vehicleModelPath(id))).toMatchObject({ route: "vehicleModel", id });
    expect(locationOf(`/vehicles/generations/${id.toUpperCase()}`)).toMatchObject({
      route: "vehicleGeneration",
      id,
    });
    expect(locationOf(vehicleImportPath(id))).toMatchObject({ route: "vehicleImport", id });
    expect(vehicleGenerationPath(id, "x")).toBe(`/vehicles/generations/${id}?highlight=x`);
    expect(locationOf("/vehicles/makes/not-an-id").route).toBeNull();
    for (const route of [
      "vehicleEngines",
      "vehicleOptions",
      "vehicleImports",
      "vehicleMake",
      "vehicleModel",
      "vehicleGeneration",
      "vehicleImport",
    ] as const) {
      expect(menuOf(route)).toBe("vehicles");
    }
  });

  it("reads the history of one setting by its key, and nothing that isn't a key", () => {
    expect(locationOf(settingHistoryPath("supplier_response_hours"))).toMatchObject({
      route: "settingHistory",
      id: "supplier_response_hours",
    });
    expect(locationOf("/settings/Bad-Key/history").route).toBeNull();
    expect(menuOf("settingHistory")).toBe("settings");
    expect(menuOf("cities")).toBe("settings");
  });

  it("keeps the filters of a list in the query, without the empty ones", () => {
    expect(withQuery("/audit", { action: "setting.changed", from: "", to: null })).toBe(
      "/audit?action=setting.changed",
    );
    expect(locationOf("/signals", "?kind=whatsapp_outage").query.get("kind")).toBe(
      "whatsapp_outage",
    );
  });
});

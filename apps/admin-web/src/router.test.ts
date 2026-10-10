import { describe, expect, it } from "vitest";
import {
  locationOf,
  menuOf,
  orderExtensionsPath,
  orderPath,
  settingHistoryPath,
  supplierLeadPath,
  supplierNewPath,
  supplierPath,
  userPath,
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

  it("knows the suppliers' pages: the list, the funnel, a request, a new one, a card on a tab (TASK-036)", () => {
    const id = "0b6c9f1e-2a3d-4c5b-8e7f-9a0b1c2d3e4f";
    expect(locationOf("/suppliers").route).toBe("suppliers");
    expect(locationOf("/suppliers/leads").route).toBe("supplierLeads");
    expect(locationOf("/suppliers/new").route).toBe("supplierNew");
    expect(locationOf(supplierLeadPath(id))).toMatchObject({ route: "supplierLead", id });
    expect(locationOf(supplierPath(id))).toMatchObject({ route: "supplier", id });
    expect(supplierPath(id, "members")).toBe(`/suppliers/${id}?tab=members`);
    expect(supplierPath(id, "profile")).toBe(`/suppliers/${id}`);
    expect(supplierNewPath(id)).toBe(`/suppliers/new?leadId=${id}`);
    expect(supplierNewPath()).toBe("/suppliers/new");
    expect(locationOf("/suppliers/not-an-id").route).toBeNull();
    for (const route of ["supplierLeads", "supplierNew", "supplier", "supplierLead"] as const) {
      expect(menuOf(route)).toBe("suppliers");
    }
  });

  it("knows the orders and the users: lists, cards on a tab, the extension, the no-shows (TASK-036.B)", () => {
    const id = "0b6c9f1e-2a3d-4c5b-8e7f-9a0b1c2d3e4f";
    expect(locationOf("/orders").route).toBe("orders");
    expect(locationOf("/orders/extensions").route).toBe("orderExtensions");
    expect(locationOf(orderPath(id))).toMatchObject({ route: "order", id });
    expect(orderExtensionsPath("2026-10-07T08:00:00.000Z")).toBe(
      "/orders/extensions?from=2026-10-07T08%3A00%3A00.000Z",
    );
    expect(locationOf("/users").route).toBe("users");
    expect(locationOf("/users/no-shows").route).toBe("userNoShows");
    expect(locationOf(userPath(id))).toMatchObject({ route: "user", id });
    expect(userPath(id, "access")).toBe(`/users/${id}?tab=access`);
    expect(userPath(id, "profile")).toBe(`/users/${id}`);
    expect(locationOf("/orders/not-an-id").route).toBeNull();
    for (const route of ["order", "orderExtensions"] as const) expect(menuOf(route)).toBe("orders");
    for (const route of ["user", "userNoShows"] as const) expect(menuOf(route)).toBe("users");
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

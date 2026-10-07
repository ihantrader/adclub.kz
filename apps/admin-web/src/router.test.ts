import { describe, expect, it } from "vitest";
import { locationOf, menuOf, settingHistoryPath, withQuery } from "./router";

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

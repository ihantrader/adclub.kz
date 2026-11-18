import { describe, expect, it } from "vitest";
import { appJsonParserReads } from "../common/http/json-parser";
import { deviceIdOf, maskedSubnet } from "./guest-activity";
import { guestTrialRouteFor, isGuestRequest } from "./guest-trial-routes";

describe("the routes of a guest's AI trial (TASK-066)", () => {
  it("are the three photos, voice and the assistant, each with its kind", () => {
    expect(guestTrialRouteFor("POST", "/garage/vehicle-document")?.kind).toBe("photo");
    expect(guestTrialRouteFor("post", "/garage/dashboard/")?.kind).toBe("photo");
    expect(guestTrialRouteFor("POST", "/Catalog/Part-Photo")?.kind).toBe("photo");
    expect(guestTrialRouteFor("POST", "/speech/transcribe")?.kind).toBe("speech");
    expect(guestTrialRouteFor("POST", "/assistant/messages")?.kind).toBe("assistant");
  });

  it("leave everything else alone, the ways without AI included", () => {
    expect(guestTrialRouteFor("GET", "/garage/vehicle-document/attempts")).toBeNull();
    expect(guestTrialRouteFor("GET", "/assistant/messages")).toBeNull();
    expect(guestTrialRouteFor("POST", "/assistant/messages/abc/complaint")).toBeNull();
    expect(guestTrialRouteFor("POST", "/vehicles/match")).toBeNull();
    expect(guestTrialRouteFor("GET", "/catalog/search")).toBeNull();
  });

  it("a guest is a request without Authorization, whatever else it sends", () => {
    expect(isGuestRequest({ headers: {} })).toBe(true);
    expect(isGuestRequest({ headers: { authorization: "Bearer x" } })).toBe(false);
    // An empty or broken header is not a guest: the session guard refuses it (401).
    expect(isGuestRequest({ headers: { authorization: "" } })).toBe(false);
  });

  it("the application's JSON parser leaves only a guest's body of these routes to the gate", () => {
    const json = { "content-type": "application/json; charset=utf-8" };
    const request = (url: string, headers: Record<string, string>) =>
      ({ method: "POST", url, headers }) as never;
    expect(appJsonParserReads(request("/assistant/messages", json))).toBe(false);
    expect(
      appJsonParserReads(request("/assistant/messages", { ...json, authorization: "Bearer x" })),
    ).toBe(true);
    expect(appJsonParserReads(request("/vehicles/match", json))).toBe(true);
    expect(appJsonParserReads(request("/garage/dashboard", json))).toBe(false);
    expect(appJsonParserReads(request("/vehicles/match", { "content-type": "text/plain" }))).toBe(
      false,
    );
  });
});

describe("the signs of the switch", () => {
  it("show a network, never an address: IPv4 by /24, IPv6 by /64", () => {
    expect(maskedSubnet("198.51.100.17")).toBe("198.51.100.0/24");
    expect(maskedSubnet("::ffff:198.51.100.17")).toBe("198.51.100.0/24");
    expect(maskedSubnet("2001:db8:aa:bb:1:2:3:4")).toBe("2001:db8:aa:bb::/64");
    expect(maskedSubnet(undefined)).toBe("unknown");
  });

  it("count a device by the UUID the app makes, nothing else", () => {
    expect(deviceIdOf("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(deviceIdOf("AAAAAAAA-1111-4111-8111-111111111111")).toBe(
      "aaaaaaaa-1111-4111-8111-111111111111",
    );
    expect(deviceIdOf("+77010000361")).toBeNull();
    expect(deviceIdOf(42)).toBeNull();
  });
});

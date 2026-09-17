import { describe, expect, it } from "vitest";
import { ipHint } from "./ip-hint";

describe("ipHint", () => {
  it.each([
    ["203.0.113.57", "203.0.113.*"],
    ["::ffff:198.51.100.7", "198.51.100.*"],
    ["2001:db8:1:2::10", "2001:db8::*"],
    ["2001:0db8:0001:0002:0003:0004:0005:0006", "2001:db8::*"],
    ["::1", "0:0::*"],
    ["", null],
    [null, null],
    [undefined, null],
    ["not an ip", null],
  ])("shows %j as %j", (ip, expected) => {
    expect(ipHint(ip)).toBe(expected);
  });

  it("never contains the full address", () => {
    for (const ip of ["203.0.113.57", "2001:db8:1:2::10"]) {
      expect(ipHint(ip)).not.toContain(ip);
    }
  });
});

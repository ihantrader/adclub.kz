import { describe, expect, it } from "vitest";
import {
  compareAppVersions,
  isValidAppVersion,
  isVersionBelowMinimum,
  parseAppVersion,
} from "./app-version";

describe("parseAppVersion", () => {
  it("parses a MAJOR.MINOR.PATCH version", () => {
    expect(parseAppVersion("1.4.2")).toEqual([1, 4, 2]);
    expect(parseAppVersion("0.0.0")).toEqual([0, 0, 0]);
  });

  it.each([
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "v1.2.3",
    "1.2.x",
    " 1.2.3",
    "01.2.3",
    "1.2.3-beta",
    "-1.2.3",
  ])("rejects %j", (value) => {
    expect(parseAppVersion(value)).toBeNull();
    expect(isValidAppVersion(value)).toBe(false);
  });
});

describe("compareAppVersions", () => {
  it("compares numerically, not lexically", () => {
    expect(compareAppVersions([1, 10, 0], [1, 9, 0])).toBeGreaterThan(0);
    expect(compareAppVersions([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(compareAppVersions([0, 9, 9], [1, 0, 0])).toBeLessThan(0);
  });
});

describe("isVersionBelowMinimum", () => {
  it("is true only for a strictly lower version", () => {
    expect(isVersionBelowMinimum("1.3.9", "1.4.0")).toBe(true);
    expect(isVersionBelowMinimum("1.4.0", "1.4.0")).toBe(false);
    expect(isVersionBelowMinimum("2.0.0", "1.4.0")).toBe(false);
  });

  it("never reports an unparsable version as outdated", () => {
    expect(isVersionBelowMinimum("garbage", "1.4.0")).toBe(false);
    expect(isVersionBelowMinimum("1.0.0", "garbage")).toBe(false);
  });
});

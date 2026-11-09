import { describe, expect, it } from "vitest";
import { shouldCheckForUpdate, UPDATE_CHECK_INTERVAL_MS } from "./ota-update-rule";

describe("looking for an OTA update (TASK-056)", () => {
  const fresh = { lastCheckAt: null, busy: false, downloaded: false };

  it("looks at the first start, then not more often than the interval", () => {
    expect(shouldCheckForUpdate(fresh, 1000, true)).toBe(true);
    const looked = { ...fresh, lastCheckAt: 1000 };
    expect(shouldCheckForUpdate(looked, 1000 + UPDATE_CHECK_INTERVAL_MS - 1, true)).toBe(false);
    expect(shouldCheckForUpdate(looked, 1000 + UPDATE_CHECK_INTERVAL_MS, true)).toBe(true);
  });

  it("never twice at once, not after a download, not where updates are off", () => {
    expect(shouldCheckForUpdate({ ...fresh, busy: true }, 1000, true)).toBe(false);
    expect(shouldCheckForUpdate({ ...fresh, downloaded: true }, 1000, true)).toBe(false);
    expect(shouldCheckForUpdate(fresh, 1000, false)).toBe(false);
  });
});

import type { SupplierTextKey } from "@adclub/i18n";
import { describe, expect, it, vi } from "vitest";
import { createTranslate } from "./translate";

describe("a text key the dictionary does not know (TASK-032.A)", () => {
  const missing = "offers.reason.brandNew" as SupplierTextKey;

  it("does not take the cabinet down: the key is shown, with or without values", () => {
    const t = createTranslate("kk", null);
    expect(t(missing)).toBe("offers.reason.brandNew");
    expect(() => t(missing, { n: 2 })).not.toThrow();
    expect(t("offers.title")).not.toBe("offers.title");
  });

  it("is reported in development, once per key; known keys say nothing", () => {
    const warn = vi.fn();
    const t = createTranslate("ru", warn);
    t(missing);
    t(missing, { n: 1 });
    t("offers.title");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("offers.reason.brandNew");
  });
});

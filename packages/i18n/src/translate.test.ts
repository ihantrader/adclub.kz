import { describe, expect, it } from "vitest";
import { languages, translate } from "./translate";

describe("translate", () => {
  it("has all three required languages", () => {
    expect(languages.sort()).toEqual(["en", "kk", "ru"]);
  });

  it("returns the demo key in every language", () => {
    expect(translate("ru", "common.appWorking")).toBe("Работает");
    expect(translate("kk", "common.appWorking")).toBe("Жұмыс істеп тұр");
    expect(translate("en", "common.appWorking")).toBe("Working");
  });
});

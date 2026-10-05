import { describe, expect, it } from "vitest";
import { installWay, isIos } from "./install";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

const base = { maxTouchPoints: 0, standalone: false, hasPrompt: false, installedNow: false };

describe("S-INST-01: how this browser installs the cabinet", () => {
  it("recognises iPhone and an iPad that calls itself a Mac, not a real Mac", () => {
    expect(isIos(IPHONE, 5)).toBe(true);
    expect(isIos(IPAD_AS_MAC, 5)).toBe(true);
    expect(isIos(IPAD_AS_MAC, 0)).toBe(false);
    expect(isIos(ANDROID_CHROME, 5)).toBe(false);
  });

  it("offers nothing once installed or opened from the home screen", () => {
    expect(installWay({ ...base, userAgent: IPHONE, standalone: true })).toBe("installed");
    expect(installWay({ ...base, userAgent: ANDROID_CHROME, installedNow: true })).toBe(
      "installed",
    );
  });

  it("uses the browser's dialog where there is one, the Share steps on iPhone, the menu otherwise", () => {
    expect(installWay({ ...base, userAgent: ANDROID_CHROME, hasPrompt: true })).toBe("prompt");
    expect(installWay({ ...base, userAgent: IPHONE, maxTouchPoints: 5 })).toBe("ios");
    expect(installWay({ ...base, userAgent: ANDROID_CHROME })).toBe("menu");
  });
});

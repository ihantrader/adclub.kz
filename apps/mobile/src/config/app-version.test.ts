import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatClientHeader } from "@adclub/contracts";
import { isVersionBelowMinimum } from "@adclub/domain";
import { appVersionOf, updateLabelOf } from "./app-version";

/** TASK-056 AC-1: the installed build is the version; an OTA manifest does not change it. */
describe("the app's version (ARCHITECTURE 7.4, 4.81)", () => {
  it("in an own build, takes the installed native version — not the update's manifest", () => {
    const installed = appVersionOf({
      runEnvironment: "own-build",
      nativeVersion: "1.0.0",
      nativeBuild: "42",
      // An OTA update whose manifest says something else.
      manifestVersion: "1.4.0",
    });
    expect(installed).toEqual({ version: "1.0.0", build: "42" });
    // X-Client and the policy see the store build.
    expect(formatClientHeader({ platform: "ios", version: installed.version })).toBe(
      "mobile/1.0.0 (ios)",
    );
    expect(isVersionBelowMinimum(installed.version, "1.2.0")).toBe(true);
  });

  it("in Expo Go and in the browser, takes app.json as before", () => {
    for (const runEnvironment of ["expo-go", "web"] as const) {
      expect(
        appVersionOf({
          runEnvironment,
          nativeVersion: "2.9.0",
          nativeBuild: "7",
          manifestVersion: "1.0.0",
        }),
      ).toEqual({ version: "1.0.0", build: null });
    }
  });

  it("falls back to the manifest when the native version is missing or unreadable", () => {
    expect(
      appVersionOf({
        runEnvironment: "own-build",
        nativeVersion: null,
        nativeBuild: null,
        manifestVersion: "1.0.0",
      }),
    ).toEqual({ version: "1.0.0", build: null });
    expect(
      appVersionOf({
        runEnvironment: "own-build",
        nativeVersion: "1.0",
        nativeBuild: "",
        manifestVersion: undefined,
      }),
    ).toEqual({ version: "0.0.0", build: null });
  });

  it("names the OTA update by seven characters, and none for the shipped code, Expo Go or the browser", () => {
    const updateId = "A1B2C3D4-5E6F-4A1B-8C9D-0E1F2A3B4C5D";
    expect(updateLabelOf({ runEnvironment: "own-build", updateId, isEmbeddedLaunch: false })).toBe(
      "a1b2c3d",
    );
    expect(
      updateLabelOf({ runEnvironment: "own-build", updateId, isEmbeddedLaunch: true }),
    ).toBeNull();
    expect(updateLabelOf({ runEnvironment: "web", updateId, isEmbeddedLaunch: false })).toBeNull();
    expect(
      updateLabelOf({ runEnvironment: "expo-go", updateId, isEmbeddedLaunch: false }),
    ).toBeNull();
    expect(
      updateLabelOf({ runEnvironment: "own-build", updateId: null, isEmbeddedLaunch: false }),
    ).toBeNull();
  });

  it("app.json: OTA only inside its store version, build numbers are EAS's", () => {
    const appJson = JSON.parse(readFileSync(join(__dirname, "..", "..", "app.json"), "utf8")) as {
      expo: {
        version: string;
        runtimeVersion: unknown;
        ios: Record<string, unknown>;
        android: Record<string, unknown>;
        plugins: unknown[];
      };
    };
    expect(appJson.expo.runtimeVersion).toEqual({ policy: "appVersion" });
    expect(appJson.expo.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(appJson.expo.ios.bundleIdentifier).toBe("kz.adclub.app");
    expect(appJson.expo.android.package).toBe("kz.adclub.app");
    expect(appJson.expo.ios).not.toHaveProperty("buildNumber");
    expect(appJson.expo.android).not.toHaveProperty("versionCode");
    expect(
      (appJson.expo.ios.infoPlist as { UIBackgroundModes: string[] }).UIBackgroundModes,
    ).toContain("remote-notification");
    expect(appJson.expo.plugins).toEqual(
      expect.arrayContaining(["expo-updates", "expo-task-manager"]),
    );
    const eas = JSON.parse(readFileSync(join(__dirname, "..", "..", "eas.json"), "utf8")) as {
      cli: { appVersionSource: string };
      build: Record<string, { channel?: string }>;
    };
    expect(eas.cli.appVersionSource).toBe("remote");
    expect(Object.keys(eas.build)).toEqual(
      expect.arrayContaining(["development", "preview", "production"]),
    );
    expect(eas.build.preview?.channel).toBe("preview");
    expect(eas.build.production?.channel).toBe("production");
    // No addresses and no secrets in the file.
    expect(JSON.stringify(eas)).not.toMatch(/https?:\/\/|\.p8|google-services|key/i);
  });
});

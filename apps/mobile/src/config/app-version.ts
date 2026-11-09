import type { RunEnvironment } from "../orders/call-options";

/**
 * What the app calls its version (TASK-056 requirement 1, ARCHITECTURE 7.4,
 * 4.81) — the one answer `X-Client`, the client policy and M-PRO-06 use.
 *
 * | where           | version                                    | update shown |
 * | --------------- | ------------------------------------------ | ------------ |
 * | own build (EAS) | the installed native build (`expo-application`) | the OTA update applied, if any |
 * | Expo Go         | `app.json` (`expoConfig.version`)          | —            |
 * | browser (dev)   | `app.json` (`expoConfig.version`)          | —            |
 *
 * In an own build the manifest of an OTA update carries a `version` too, but
 * an update runs only inside its own store version (`runtimeVersion:
 * appVersion`) — and the server's minimum is about the store build, which an
 * update never changes. So the installed build decides; the manifest is the
 * fallback where there is no native version (Expo Go, the browser).
 */
export interface VersionSources {
  runEnvironment: RunEnvironment;
  /** `Application.nativeApplicationVersion` — `CFBundleShortVersionString` / `versionName`. */
  nativeVersion: string | null;
  /** `Application.nativeBuildVersion` — `CFBundleVersion` / `versionCode`. */
  nativeBuild: string | null;
  /** `Constants.expoConfig.version` — app.json, or the running update's manifest. */
  manifestVersion: string | null | undefined;
}

export interface AppVersion {
  /** `MAJOR.MINOR.PATCH` — what the server compares with its minimum. */
  version: string;
  /** The store's build number, when the app is its own build. */
  build: string | null;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const FALLBACK = "0.0.0";

export function appVersionOf(sources: VersionSources): AppVersion {
  const manifest =
    sources.manifestVersion && SEMVER.test(sources.manifestVersion)
      ? sources.manifestVersion
      : FALLBACK;
  if (sources.runEnvironment !== "own-build") {
    return { version: manifest, build: null };
  }
  const native = sources.nativeVersion?.trim() ?? "";
  return {
    version: SEMVER.test(native) ? native : manifest,
    build: sources.nativeBuild?.trim() || null,
  };
}

export interface UpdateSources {
  runEnvironment: RunEnvironment;
  /** `Updates.updateId` — `null` when nothing of expo-updates runs (Expo Go, the browser, dev). */
  updateId: string | null | undefined;
  /** `Updates.isEmbeddedLaunch` — the code the build shipped with, no OTA. */
  isEmbeddedLaunch: boolean;
}

/**
 * The short id of the OTA update the app runs («a1b2c3d»), `null` — the code
 * the build shipped with, or no updates at all (Expo Go, the browser). Seven
 * characters, like a short commit: support reads it from M-PRO-06 and finds
 * the update in EAS.
 */
export function updateLabelOf(sources: UpdateSources): string | null {
  if (sources.runEnvironment !== "own-build" || sources.isEmbeddedLaunch) return null;
  const id = (sources.updateId ?? "").replaceAll("-", "").toLowerCase();
  return /^[0-9a-f]{7,}$/.test(id) ? id.slice(0, 7) : null;
}

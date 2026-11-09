import type { ClientInfo } from "@adclub/contracts";
import type { Lang } from "@adclub/i18n";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";
import { supportedSystemLanguage } from "../start/start-decision";
import type { RunEnvironment } from "../orders/call-options";
import { resolveApiUrl } from "./api-url";
import { appVersionOf, updateLabelOf } from "./app-version";

/**
 * Where the app runs: its own build (EAS — what people install), Expo Go
 * (development on a phone) or the browser (development only). What the app
 * can learn about other installed apps differs between them
 * (`orders/call-options.ts`, ARCHITECTURE 4.46).
 */
export const runEnvironment: RunEnvironment =
  Platform.OS === "web"
    ? "web"
    : Constants.executionEnvironment === ExecutionEnvironment.StoreClient
      ? "expo-go"
      : "own-build";

type ApplicationModule = typeof import("expo-application");
type UpdatesModule = typeof import("expo-updates");

/** A native module of the own build; `null` in the browser and wherever it is missing. */
function nativeModule<T>(load: () => T): T | null {
  if (runEnvironment !== "own-build") return null;
  try {
    return load();
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const application = nativeModule(() => require("expo-application") as ApplicationModule);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const updates = nativeModule(() => require("expo-updates") as UpdatesModule);

/**
 * The version of the installed store build in an own build, app.json in Expo
 * Go and the browser (TASK-056; `config/app-version.ts`) — what `X-Client`
 * and the minimum-version policy compare. An OTA update never changes it.
 */
const installed = appVersionOf({
  runEnvironment,
  nativeVersion: application?.nativeApplicationVersion ?? null,
  nativeBuild: application?.nativeBuildVersion ?? null,
  manifestVersion: Constants.expoConfig?.version,
});

export const appInfo = {
  version: installed.version,
  build: installed.build,
  /** The OTA update the app runs («a1b2c3d»), `null` — the code the build shipped with. */
  update: updateLabelOf({
    runEnvironment,
    updateId: updates?.updateId ?? null,
    isEmbeddedLaunch: updates?.isEmbeddedLaunch ?? true,
  }),
} as const;

/**
 * The app targets iOS and Android only; `expo start --web` (a dev
 * convenience, not a product platform) reports itself as Android.
 */
export const clientInfo: ClientInfo = {
  platform: Platform.OS === "ios" ? "ios" : "android",
  version: installed.version,
};

export const apiUrl = resolveApiUrl({
  explicitUrl: process.env.EXPO_PUBLIC_API_URL,
  devServerHostUri: __DEV__ ? Constants.expoConfig?.hostUri : null,
});

function deviceLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * The device language when it is one of ours (kk/ru/en), otherwise `null` —
 * then the app asks (M-START-02). The choice itself lives in
 * `languageStore`; this is only what the system says.
 */
export const systemLanguage: Lang | null = supportedSystemLanguage(deviceLocale());

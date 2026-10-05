import type { ClientInfo } from "@adclub/contracts";
import type { Lang } from "@adclub/i18n";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";
import { supportedSystemLanguage } from "../start/start-decision";
import type { RunEnvironment } from "../orders/call-options";
import { resolveApiUrl } from "./api-url";

/** Store version from app.json — what the minimum-version policy compares against. */
const appVersion = Constants.expoConfig?.version ?? "0.0.0";

export const appInfo = { version: appVersion } as const;

/**
 * The app targets iOS and Android only; `expo start --web` (a dev
 * convenience, not a product platform) reports itself as Android.
 */
export const clientInfo: ClientInfo = {
  platform: Platform.OS === "ios" ? "ios" : "android",
  version: appVersion,
};

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

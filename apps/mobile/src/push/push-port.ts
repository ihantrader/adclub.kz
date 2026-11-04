import type { PushMessage, PushPermission } from "./push-logic";

/**
 * The port of push on the device (TASK-051 requirement 6): the permission,
 * the platform's token, a push received and a push opened. The native module
 * (`expo-notifications`) is one implementation; the browser of development
 * and the tests use another, with nothing native behind it — the app works
 * the same without push.
 */
export interface DevicePushToken {
  platform: "ios" | "android";
  token: string;
}

export interface PushPort {
  /** `false` — this build has no push (the browser, Expo Go without a token). */
  readonly available: boolean;
  permission(): Promise<PushPermission>;
  /** The system's dialog; the only place that asks is M-PUSH-01 and M-PRO-04. */
  request(): Promise<PushPermission>;
  /** The platform's token, `null` — none (no permission, Expo Go, no Google services). */
  deviceToken(): Promise<DevicePushToken | null>;
  onTokenChange(listener: (token: DevicePushToken) => void): () => void;
  /** A push arrived while the app is open. */
  onReceived(listener: (message: PushMessage) => void): () => void;
  /** The person tapped a push. */
  onOpened(listener: (message: PushMessage) => void): () => void;
  /** The push the app was opened from (a cold start); `null` — none. */
  initialOpened(): Promise<PushMessage | null>;
  /** The system settings of the app (M-PRO-04 «Открыть настройки»). */
  openSettings(): Promise<void>;
}

/** Which order's screen is open now: its push is not drawn over it — the screen refreshes itself. */
export const orderOnScreen: { current: string | null } = { current: null };

/** A port that has nothing: what an unknown platform gets. */
export const NO_PUSH: PushPort = {
  available: false,
  permission: () => Promise.resolve({ status: "denied", canAskAgain: false }),
  request: () => Promise.resolve({ status: "denied", canAskAgain: false }),
  deviceToken: () => Promise.resolve(null),
  onTokenChange: () => () => undefined,
  onReceived: () => () => undefined,
  onOpened: () => () => undefined,
  initialOpened: () => Promise.resolve(null),
  openSettings: () => Promise.resolve(),
};

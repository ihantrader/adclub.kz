import { pushMessageOf, type PushMessage, type PushPermission } from "./push-logic";
import type { DevicePushToken, PushPort } from "./push-port";

/**
 * The port of the browser of development and of the tests (TASK-051 AC-6):
 * no system, no provider. The permission starts undetermined; `request`
 * answers what `answer` says (granted by default); the token is a fixed fake
 * one of this page. In development the page exposes it as
 * `globalThis.__adclubPush`, so a check can say what the system would answer
 * and play a push received or opened — with the data the server sent, read
 * off `/dev/pushes`.
 */
export interface StubPushControl {
  /** What the next system dialog answers. */
  answer: PushPermission["status"];
  readonly permission: PushPermission;
  readonly token: string;
  /** A push arrived while the page is open. */
  receive(data: unknown): void;
  /** The person tapped a push. */
  open(data: unknown): void;
}

export function createStubPushPort(platform: "ios" | "android" = "android"): {
  port: PushPort;
  control: StubPushControl;
} {
  let permission: PushPermission = { status: "undetermined", canAskAgain: true };
  const token = `web-dev-stub-${Math.random().toString(36).slice(2, 10)}:APA91b${"WebDevStub0".repeat(10)}`;
  const received = new Set<(message: PushMessage) => void>();
  const opened = new Set<(message: PushMessage) => void>();
  const tokenListeners = new Set<(token: DevicePushToken) => void>();
  let initial: PushMessage | null = null;

  const control: StubPushControl = {
    answer: "granted",
    get permission() {
      return permission;
    },
    token,
    receive(data) {
      const message = pushMessageOf(data);
      for (const listener of received) listener(message);
    },
    open(data) {
      const message = pushMessageOf(data);
      if (opened.size === 0) {
        initial = message;
        return;
      }
      for (const listener of opened) listener(message);
    },
  };

  const port: PushPort = {
    available: true,
    permission: () => Promise.resolve(permission),
    request: () => {
      if (permission.status === "undetermined" || permission.canAskAgain) {
        permission =
          control.answer === "granted"
            ? { status: "granted", canAskAgain: false }
            : { status: control.answer, canAskAgain: false };
        if (permission.status === "granted") {
          for (const listener of tokenListeners) listener({ platform, token });
        }
      }
      return Promise.resolve(permission);
    },
    deviceToken: () =>
      Promise.resolve(permission.status === "granted" ? { platform, token } : null),
    onTokenChange: (listener) => {
      tokenListeners.add(listener);
      return () => tokenListeners.delete(listener);
    },
    onReceived: (listener) => {
      received.add(listener);
      return () => received.delete(listener);
    },
    onOpened: (listener) => {
      opened.add(listener);
      return () => opened.delete(listener);
    },
    initialOpened: () => {
      const message = initial;
      initial = null;
      return Promise.resolve(message);
    },
    openSettings: () => Promise.resolve(),
  };
  return { port, control };
}

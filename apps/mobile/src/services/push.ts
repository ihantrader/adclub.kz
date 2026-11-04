import { Platform } from "react-native";
import { createNativePushPort } from "../push/native-push-port";
import type { PushPort } from "../push/push-port";
import { createStubPushPort, type StubPushControl } from "../push/stub-push-port";

/**
 * The push of this build (TASK-051): the native module on a phone, the stub
 * in the browser of development (`expo start --web`), where a check plays
 * the system and the provider through `globalThis.__adclubPush`.
 */
function choose(): PushPort {
  if (Platform.OS === "web") {
    const { port, control } = createStubPushPort();
    if (__DEV__) {
      (globalThis as { __adclubPush?: StubPushControl }).__adclubPush = control;
    }
    return port;
  }
  return createNativePushPort();
}

export const pushPort: PushPort = choose();

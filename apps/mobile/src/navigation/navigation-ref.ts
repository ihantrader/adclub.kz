import { createNavigationContainerRef } from "@react-navigation/native";
import type { PushTarget } from "../start/start-decision";
import type { RootParams } from "./routes";

/**
 * The root navigator from outside a screen (TASK-051): a tapped push opens
 * the order from wherever the person is. A target that arrives before the
 * navigator is ready (a cold start from a push) waits for it.
 */
export const navigationRef = createNavigationContainerRef<RootParams>();

let pending: PushTarget | null = null;

/** Opens what a push points at: M-ORD-03 of the order, or the profile for the subscription. */
export function openPushTarget(target: PushTarget): void {
  if (!navigationRef.isReady()) {
    pending = target;
    return;
  }
  if (target.screen === "order" && target.params?.orderId) {
    navigationRef.navigate("order", { orderId: target.params.orderId });
    return;
  }
  if (target.screen === "subscription") {
    // M-SUB-02 comes with TASK-041; until then the profile.
    navigationRef.navigate("tabs", { screen: "profile", params: { screen: "profile-home" } });
  }
}

/** The navigator is ready: the target that waited is opened. */
export function flushPushTarget(): void {
  if (pending) {
    const target = pending;
    pending = null;
    openPushTarget(target);
  }
}

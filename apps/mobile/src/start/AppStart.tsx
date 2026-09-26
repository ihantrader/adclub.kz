import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { MainTabs, type TabName } from "../navigation/MainTabs";
import { FirstRunCityScreen } from "../screens/FirstRunCityScreen";
import { LanguageScreen } from "../screens/LanguageScreen";
import { SplashScreen } from "../screens/SplashScreen";
import { UpdateRequiredScreen } from "../screens/UpdateRequiredScreen";
import { updateGate } from "../services/api";
import { useOnline } from "../services/use-network";
import { useLanguage } from "../state/language";
import { firstRunStore } from "../state/stores";
import { useUpdateGateState, type UpdateGateState } from "../update-gate";
import {
  decideStart,
  type PolicyState,
  type SessionState,
  type StartInput,
} from "./start-decision";
import { useSyncExternalStore } from "react";

/** How long the splash may wait for the client policy before going on (SCREENS 5.1). */
const POLICY_WAIT_MS = 2_500;

/** What TASK-029 will provide; until then the app has no session at all. */
const SESSION: SessionState = "none";
/** What TASK-030 will provide: the saved copy of active orders. */
const SAVED_ACTIVE_ORDERS = false;
/** What TASK-031 will provide: the push the app was opened from. */
const PUSH: StartInput["push"] = null;

/**
 * The start of the app (M-START-01): it collects the inputs, asks
 * `decideStart` once, and renders what it answered. The order itself lives
 * in `start-decision.ts` and nowhere else — this file only wires data to it.
 */
export function AppStart() {
  const { chosen, system, setLanguage } = useLanguage();
  const gate = useUpdateGateState(updateGate);
  const policy = usePolicyState(gate);
  const online = useOnline();
  const firstRun = useSyncExternalStore(firstRunStore.subscribe, firstRunStore.get);

  // The policy is asked at start-up and again whenever the app comes back
  // from the background: a minimum raised meanwhile shows the screen, and a
  // minimum lowered again takes it away (SCREENS 5.1, M-START-03).
  useEffect(() => {
    void updateGate.check();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void updateGate.check();
    });
    return () => subscription.remove();
  }, []);

  const decision = decideStart({
    policy,
    storedLanguage: chosen,
    systemLanguage: system,
    firstRun,
    session: SESSION,
    online,
    savedActiveOrders: SAVED_ACTIVE_ORDERS,
    push: PUSH,
  });

  // Rule 2: a system kk/ru/en is applied silently and kept, without a screen.
  useEffect(() => {
    if (decision.applyLanguage) setLanguage(decision.applyLanguage);
  }, [decision.applyLanguage, setLanguage]);

  switch (decision.screen) {
    case "splash":
      return <SplashScreen />;

    case "update-required":
      return (
        <UpdateRequiredScreen
          message={gate.status === "update-required" ? gate.message : ""}
          onCheckAgain={updateGate.check}
        />
      );

    case "language":
      return <LanguageScreen onSelect={setLanguage} />;

    case "first-run-city":
      return (
        <FirstRunCityScreen
          onDone={() => {
            // M-START-05 (the car) is TASK-028: until it exists the run is
            // finished here. Then this becomes `{ completed: false, step: "car" }`.
            firstRunStore.set({ completed: true, step: "car" });
          }}
        />
      );

    // M-START-05 — TASK-028. The decision already knows the step; until the
    // screen exists the app opens the catalog instead of a dead end.
    case "first-run-car":
      return <MainTabs initialTab="catalog" />;

    case "orders-offline":
      return <MainTabs initialTab="orders" />;

    // The screen a push points at — TASK-031 maps it; the catalog until then.
    case "push":
      return <MainTabs initialTab="catalog" />;

    default:
      // Rule 4's "Вы вышли из аккаунта" sheet comes with the session (TASK-029);
      // today no session can be revoked, so there is nothing to show over it.
      return <MainTabs initialTab={INITIAL_TAB} />;
  }
}

const INITIAL_TAB: TabName = "catalog";

/**
 * The policy as the start decision sees it: `pending` while the request is
 * in flight, and only for the first couple of seconds — after that the app
 * goes on without an answer and reacts to a 426 whenever it arrives.
 */
function usePolicyState(state: UpdateGateState): PolicyState {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), POLICY_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  switch (state.status) {
    case "update-required":
      return "update-required";
    case "supported":
      return "supported";
    case "unverified":
      return "unverified";
    default:
      return waited ? "unverified" : "pending";
  }
}

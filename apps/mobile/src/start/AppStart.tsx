import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { RootNavigator } from "../navigation/RootNavigator";
import { LanguageScreen } from "../screens/LanguageScreen";
import { SplashScreen } from "../screens/SplashScreen";
import { UpdateRequiredScreen } from "../screens/UpdateRequiredScreen";
import { updateGate } from "../services/api";
import { useOnline } from "../services/use-network";
import { useGarage } from "../state/garage-provider";
import { useLanguage } from "../state/language";
import { devicePreferencesLoaded, devicePreferencesWereRead, firstRunStore } from "../state/stores";
import { useUpdateGateState, type UpdateGateState } from "../update-gate";
import { rootStart } from "./root-start";
import {
  decideStart,
  type PolicyState,
  type SessionState,
  type StartInput,
} from "./start-decision";

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
 *
 * The gates in front of the app — the splash, the update screen, the language
 * choice — are screens this file swaps. Everything after them, the first run
 * included, is one navigator (`RootNavigator`): the decision says where it
 * opens, and its screens move to one another themselves, with the platform's
 * transitions (ARCHITECTURE 4.39).
 */
export function AppStart() {
  const { chosen, system, setLanguage } = useLanguage();
  const gate = useUpdateGateState(updateGate);
  const policy = usePolicyState(gate);
  const online = useOnline();
  const firstRun = useSyncExternalStore(firstRunStore.subscribe, firstRunStore.get);
  const { cars } = useGarage();
  const preferencesRead = usePreferencesRead();

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
    hasCar: cars.length > 0,
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

    default: {
      // The first run (city → car → the steps), the tabs, a push. The city and
      // the car steps finish by themselves, and each of them changes this
      // decision — the navigator reads where to open once and is not rebuilt.
      // Rule 4's "Вы вышли из аккаунта" sheet comes with the session
      // (TASK-029); today no session can be revoked, so there is nothing to
      // show over it.
      // The key: a device whose storage answered late was opened on the
      // defaults, and the navigator opens again — once — on what the device
      // really holds (a returning person must not be left on the first run).
      const start = rootStart(decision.screen);
      return start ? (
        <RootNavigator key={preferencesRead ? "read" : "defaults"} start={start} />
      ) : (
        <SplashScreen />
      );
    }
  }
}

/** Whether the stores of the device had been read when the app opened, or have been since. */
function usePreferencesRead(): boolean {
  const [read, setRead] = useState(devicePreferencesWereRead);
  useEffect(() => {
    if (read) return;
    let active = true;
    void devicePreferencesLoaded.then(() => {
      if (active) setRead(true);
    });
    return () => {
      active = false;
    };
  }, [read]);
  return read;
}

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

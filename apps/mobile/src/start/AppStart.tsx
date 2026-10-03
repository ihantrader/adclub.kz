import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { RootNavigator } from "../navigation/RootNavigator";
import { LanguageScreen } from "../screens/LanguageScreen";
import { SplashScreen } from "../screens/SplashScreen";
import { UpdateRequiredScreen } from "../screens/UpdateRequiredScreen";
import { updateGate } from "../services/api";
import { useNetworkStatus } from "../services/use-network";
import { useGarage } from "../state/garage-provider";
import { useLanguage } from "../state/language";
import { OrdersReadOnly, useOrdersCopy } from "../state/orders-provider";
import {
  devicePreferencesLoaded,
  devicePreferencesWereRead,
  firstRunStore,
  sessionStore,
} from "../state/stores";
import { useUpdateGateState, type UpdateGateState } from "../update-gate";
import { rootStart } from "./root-start";
import { decideStart, type PolicyState, type StartInput } from "./start-decision";

/** How long the splash may wait for the client policy before going on (SCREENS 5.1). */
const POLICY_WAIT_MS = 2_500;

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
  const waited = useWaited(POLICY_WAIT_MS);
  const policy = policyStateOf(gate, waited);
  const network = useNetworkStatus();
  const { copy } = useOrdersCopy();
  const savedActiveOrders = (copy?.orders.length ?? 0) > 0;
  // M-START-03 «Показать активные заявки» was pressed: the codes from the copy, read only (D-027).
  const [readOnlyOrders, setReadOnlyOrders] = useState(false);
  const leaveReadOnly = useCallback(() => setReadOnlyOrders(false), [setReadOnlyOrders]);
  const firstRun = useSyncExternalStore(firstRunStore.subscribe, firstRunStore.get);
  const { cars } = useGarage();
  const preferencesRead = usePreferencesRead();
  // TASK-029: a stored session is "active"; a guest (never signed in, or
  // signed out) is "none". Distinguishing "none" from a session that was
  // revoked while the app was closed (rule 4's "Вы вышли из аккаунта" sheet)
  // needs state this store doesn't keep — a documented gap (TASK-029 report).
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.get);

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
    session: session.status === "signed_in" ? "active" : "none",
    // Unknown only for the first moments: after the policy wait the app goes
    // on as if online, and a request that fails shows its own state.
    online: network ?? (waited ? true : null),
    // The copy of this account only (`useOrdersCopy` shows no other).
    savedActiveOrders,
    push: PUSH,
  });

  // The update is no longer required (checked again on return): the
  // read-only list goes together with the update screen.
  const updateRequired = decision.screen === "update-required";
  useEffect(() => {
    // Following the gate, an external state, back to the ordinary app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!updateRequired) setReadOnlyOrders(false);
  }, [updateRequired]);

  // Rule 2: a system kk/ru/en is applied silently and kept, without a screen.
  useEffect(() => {
    if (decision.applyLanguage) setLanguage(decision.applyLanguage);
  }, [decision.applyLanguage, setLanguage]);

  switch (decision.screen) {
    case "splash":
      return <SplashScreen />;

    case "update-required":
      // «Показать активные заявки» — only for a signed-in person whose copy
      // holds orders; the same navigator, opened on the list of the copy,
      // with nothing that needs the server (D-027, SCREENS M-START-03).
      if (readOnlyOrders && savedActiveOrders) {
        return (
          <OrdersReadOnly exit={leaveReadOnly}>
            <RootNavigator key="orders-readonly" start={{ screen: "orders-readonly" }} />
          </OrdersReadOnly>
        );
      }
      return (
        <UpdateRequiredScreen
          message={gate.status === "update-required" ? gate.message : ""}
          onCheckAgain={updateGate.check}
          {...(session.status === "signed_in" && savedActiveOrders
            ? { onShowOrders: () => setReadOnlyOrders(true) }
            : {})}
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

/** Whether `ms` have passed since the app opened: how long the splash may wait for anything. */
function useWaited(ms: number): boolean {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return waited;
}

/**
 * The policy as the start decision sees it: `pending` while the request is
 * in flight, and only for the first couple of seconds — after that the app
 * goes on without an answer and reacts to a 426 whenever it arrives.
 */
function policyStateOf(state: UpdateGateState, waited: boolean): PolicyState {
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

import { isLang, type Lang } from "@adclub/i18n";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { INITIAL_FIRST_RUN, parseFirstRun, type FirstRunState } from "../start/first-run";
import { INITIAL_CITY_STATE, parseCityState, type CityState } from "./city";
import {
  createDeviceStore,
  readyWithin,
  type DeviceStorage,
  type DeviceStore,
} from "./device-store";

const storage: DeviceStorage = {
  read: (key) => AsyncStorage.getItem(key),
  write: (key, value) => AsyncStorage.setItem(key, value),
};

/**
 * The interface language chosen on this device; `null` — never chosen, so
 * the start decision either applies the system one silently or asks
 * (SCREENS 5.1 rule 2). With TASK-029 the choice also travels with the
 * account, and this stays the copy of the device.
 */
export const languageStore: DeviceStore<Lang | null> = createDeviceStore(storage, {
  key: "adclub.mobile.language",
  initial: null,
  parse: (raw) => (typeof raw === "string" && isLang(raw) ? raw : null),
});

/** The city of the app — one value (SCREENS 5.1); moves to the account in TASK-029. */
export const cityStore: DeviceStore<CityState> = createDeviceStore(storage, {
  key: "adclub.mobile.city",
  initial: INITIAL_CITY_STATE,
  parse: parseCityState,
});

/** How far the first run got. */
export const firstRunStore: DeviceStore<FirstRunState> = createDeviceStore(storage, {
  key: "adclub.mobile.first-run",
  initial: INITIAL_FIRST_RUN,
  parse: parseFirstRun,
});

/**
 * Resolves once everything the first frame depends on has been read — and
 * after a second in any case: a stuck storage must not hold the splash
 * (the same rule as the theme, ARCHITECTURE 4.10 I91).
 */
export const devicePreferencesReady: Promise<void> = readyWithin(
  Promise.all([languageStore.ready, cityStore.ready, firstRunStore.ready]).then(() => undefined),
  1000,
);

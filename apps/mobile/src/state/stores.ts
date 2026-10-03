import { isLang, type Lang } from "@adclub/i18n";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { INITIAL_GARAGE, parseGarage, type GarageState } from "../garage/garage";
import { forgetOpenedOrders } from "../orders/opened-orders";
import {
  createOrdersCopyStore,
  type OrdersCopyStore,
  type ValueStorage,
} from "../orders/order-copy";
import { INITIAL_FIRST_RUN, parseFirstRun, type FirstRunState } from "../start/first-run";
import { INITIAL_CITY_STATE, parseCityState, type CityState } from "./city";
import {
  createDeviceStore,
  readyWithin,
  type DeviceStorage,
  type DeviceStore,
} from "./device-store";
import { createSessionStore, SIGNED_OUT, type SessionState } from "./session-store";

const storage: DeviceStorage = {
  read: (key) => AsyncStorage.getItem(key),
  write: (key, value) => AsyncStorage.setItem(key, value),
};

/**
 * The signed-in session is a secret (an access and a refresh token): it
 * lives in the platform's secure storage, not in `AsyncStorage` with the
 * rest of the device's preferences (TASK-029). `SecureStore` accepts only
 * keys of `[A-Za-z0-9._-]`; `adclub.mobile.session` is one.
 */
const secureStorage: DeviceStorage = {
  read: (key) => SecureStore.getItemAsync(key),
  write: (key, value) => SecureStore.setItemAsync(key, value),
};

/**
 * The signed-in session (TASK-029): `null` — a guest. Set at sign-in,
 * cleared at sign-out and on `SESSION_ENDED` — always together with the
 * sessions this store's own key protects, never left behind.
 */
export const sessionStore: DeviceStore<SessionState> = createSessionStore(secureStorage);

/**
 * The saved copy of active orders (TASK-030, ARCHITECTURE 4.42): the codes
 * and the QR of every active order, to open without a network. Sealed with
 * AES-GCM (`orders/copy-crypto.ts`); the sealed text is in `AsyncStorage`
 * (no size limit to worry about), its key in the secure storage of this
 * device only — the key never travels to a backup or another phone, and
 * deleting it makes whatever is left of the text unreadable.
 */
const ORDERS_COPY_KEY = "adclub.mobile.orders-copy";
const ORDERS_COPY_SECRET_KEY = "adclub.mobile.orders-key";

const ordersCopyText: ValueStorage = {
  read: () => AsyncStorage.getItem(ORDERS_COPY_KEY),
  write: (value) => AsyncStorage.setItem(ORDERS_COPY_KEY, value),
  remove: () => AsyncStorage.removeItem(ORDERS_COPY_KEY),
};

const ordersCopySecret: ValueStorage = {
  read: () => SecureStore.getItemAsync(ORDERS_COPY_SECRET_KEY),
  write: (value) =>
    SecureStore.setItemAsync(ORDERS_COPY_SECRET_KEY, value, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
  remove: () => SecureStore.deleteItemAsync(ORDERS_COPY_SECRET_KEY),
};

export const ordersCopyStore: OrdersCopyStore = createOrdersCopyStore({
  sealed: ordersCopyText,
  key: ordersCopySecret,
  random: getRandomBytes,
});

/**
 * Clears the session and the secure key itself (sign-out, `SESSION_ENDED`,
 * PRODUCT 6.7) — and with it the saved copy of active orders: the codes do
 * not outlive the session they were saved under (TASK-030 requirement 6).
 */
export function clearSession(): void {
  sessionStore.set(SIGNED_OUT);
  void SecureStore.deleteItemAsync("adclub.mobile.session").catch(() => undefined);
  void ordersCopyStore.clear();
  forgetOpenedOrders();
}

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
 * The cars of a guest (TASK-028). Kept on the device so the garage works
 * without an account and without a network (PRODUCT 6.6, SCREENS 2.4);
 * TASK-029 merges it into the account on sign-in and this stays the copy of
 * the device.
 */
export const garageStore: DeviceStore<GarageState> = createDeviceStore(storage, {
  key: "adclub.mobile.garage",
  initial: INITIAL_GARAGE,
  parse: parseGarage,
});

/** Resolves once every store of the device has really been read, however long it takes. */
export const devicePreferencesLoaded: Promise<void> = Promise.all([
  languageStore.ready,
  cityStore.ready,
  firstRunStore.ready,
  garageStore.ready,
  sessionStore.ready,
  ordersCopyStore.ready,
]).then(() => undefined);

let preferencesRead = false;
void devicePreferencesLoaded.then(() => {
  preferencesRead = true;
});

/**
 * Whether every store has been read by now. The app opens without waiting for
 * a slow storage (`devicePreferencesReady`), on the defaults — a first run
 * that is not started, an empty garage — and the root of the app must know
 * whether it was opened on those or on what the device really holds
 * (`AppStart`: the navigator is opened again, once, when the real values
 * arrive late).
 */
export function devicePreferencesWereRead(): boolean {
  return preferencesRead;
}

/**
 * Resolves once everything the first frame depends on has been read — and
 * after a second in any case: a stuck storage must not hold the splash
 * (the same rule as the theme, ARCHITECTURE 4.10 I91).
 */
export const devicePreferencesReady: Promise<void> = readyWithin(devicePreferencesLoaded, 1000);

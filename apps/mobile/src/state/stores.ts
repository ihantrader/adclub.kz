import { isLang, type Lang } from "@adclub/i18n";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { NO_DIALOGS, parseStoredDialogs, type StoredDialogs } from "../assistant/assistant-rules";
import { parseRecentSearches, RECENT_SEARCHES_KEY } from "../catalog/recent-searches";
import { parseAccountGarageCopy, type AccountGarageCopy } from "../garage/account-garage";
import { INITIAL_GARAGE, parseGarage, type GarageState } from "../garage/garage";
import { forgetOpenedOrders } from "../orders/opened-orders";
import {
  createOrdersCopyStore,
  type OrdersCopyStore,
  type ValueStorage,
} from "../orders/order-copy";
import { parsePendingAcks, type PendingAcks } from "../push/push-ack";
import { parsePushOffers, type PushOffers } from "../push/push-logic";
import { INITIAL_FIRST_RUN, parseFirstRun, type FirstRunState } from "../start/first-run";
import { INITIAL_CITY_STATE, parseCityState, type CityState } from "./city";
import {
  createDeviceStore,
  readyWithin,
  type DeviceStorage,
  type DeviceStore,
} from "./device-store";
import { parsePendingLogouts, type PendingLogout } from "./pending-logout";
import { parseProfileSync, type ProfileSyncState } from "./profile-sync";
import {
  createSessionStore,
  SESSION_STORE_KEY,
  SIGNED_OUT,
  type StoredSessionState,
} from "./session-store";

const storage: DeviceStorage = {
  read: (key) => AsyncStorage.getItem(key),
  write: (key, value) => AsyncStorage.setItem(key, value),
};

/**
 * The signed-in session is a secret (an access and a refresh token): it
 * lives in the platform's secure storage, not in `AsyncStorage` with the
 * rest of the device's preferences (TASK-029). `SecureStore` accepts only
 * keys of `[A-Za-z0-9._-]`; `adclub.mobile.session` is one.
 *
 * Readable after the first unlock since the phone started (TASK-056): an
 * iPhone wakes the app for a push in the background, usually locked, and an
 * item readable only while unlocked (the default) read back as «no session»
 * there — the background confirmation never went, and the woken process
 * believed the person a guest. This device only: never in a backup.
 */
const secureStorage: DeviceStorage = {
  read: (key) => SecureStore.getItemAsync(key),
  write: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
};

/**
 * The signed-in session (TASK-029): `null` — a guest. Set at sign-in,
 * cleared at sign-out and on `SESSION_ENDED` — always together with the
 * sessions this store's own key protects, never left behind.
 */
export const sessionStore: DeviceStore<StoredSessionState> = createSessionStore(secureStorage);

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
 * The copy of the account's garage and what this device last agreed with the
 * account about the city and the language go too (TASK-029.B): they belong
 * to the session, and a guest after it never sees the account's cars.
 */
export function clearSession(): void {
  sessionStore.set(SIGNED_OUT);
  accountGarageStore.set(null);
  profileSyncStore.set(null);
  pendingAcksStore.set([]);
  // The account's current dialog of the assistant (TASK-063): a guest after it never reads it.
  assistantDialogsStore.set({ ...assistantDialogsStore.get(), account: null });
  void SecureStore.deleteItemAsync(SESSION_STORE_KEY).catch(() => undefined);
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

/** The recent queries of the search (M-CAT-04, TASK-044): this device only. */
export const recentSearchesStore: DeviceStore<string[]> = createDeviceStore(storage, {
  key: RECENT_SEARCHES_KEY,
  initial: [],
  parse: parseRecentSearches,
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

/**
 * The copy of the signed-in account's garage (TASK-029.B, ARCHITECTURE
 * 4.46): what the garage, the catalog header and the catalog show while
 * signed in, without waiting for the network. The account is the source of
 * truth; this is refreshed from it (`garage/account-garage.ts`) and cleared
 * with the session. Not a secret — the same kind of data as the guest garage.
 */
export const accountGarageStore: DeviceStore<AccountGarageCopy | null> = createDeviceStore(
  storage,
  { key: "adclub.mobile.account-garage", initial: null, parse: parseAccountGarageCopy },
);

/**
 * The current dialog of the assistant (TASK-063, SCREENS M-AI-01: «хранится
 * только текущий диалог»): its id and the car it is for — a guest's and the
 * signed-in account's apart; the words stay on the server and are read back
 * with `GET /assistant/dialogs/{id}`.
 */
export const assistantDialogsStore: DeviceStore<StoredDialogs> = createDeviceStore(storage, {
  key: "adclub.mobile.assistant-dialogs",
  initial: NO_DIALOGS,
  parse: parseStoredDialogs,
});

/** The city and the language this device last agreed on with the account (TASK-029.B). */
export const profileSyncStore: DeviceStore<ProfileSyncState | null> = createDeviceStore(storage, {
  key: "adclub.mobile.profile-sync",
  initial: null,
  parse: parseProfileSync,
});

/**
 * How many times each account was offered push on this device (M-PUSH-01,
 * TASK-051): no more than twice. Not a secret — kept when the session ends,
 * so signing in again does not ask again.
 */
export const pushOffersStore: DeviceStore<PushOffers> = createDeviceStore(storage, {
  key: "adclub.mobile.push-offers",
  initial: {},
  parse: parsePushOffers,
});

/**
 * Confirmations of pushes that could not be sent (no network, 5xx — TASK-056,
 * I866): the background task and the open app both leave them here, and the
 * app sends them at its next start or return. Ids only, not a secret.
 */
export const PENDING_ACKS_KEY = "adclub.mobile.pending-acks";

export const pendingAcksStore: DeviceStore<PendingAcks> = createDeviceStore(storage, {
  key: PENDING_ACKS_KEY,
  initial: [],
  parse: parsePendingAcks,
});

/**
 * A sign-out the server has not heard of yet (signed out without a network,
 * TASK-056, I866): the tokens of each ended session, kept in the secure
 * storage until its `POST /auth/logout` goes through.
 */
export const pendingLogoutStore: DeviceStore<PendingLogout[]> = createDeviceStore(secureStorage, {
  key: "adclub.mobile.pending-logouts",
  initial: [],
  parse: parsePendingLogouts,
});

/** Resolves once every store of the device has really been read, however long it takes. */
export const devicePreferencesLoaded: Promise<void> = Promise.all([
  languageStore.ready,
  cityStore.ready,
  firstRunStore.ready,
  garageStore.ready,
  accountGarageStore.ready,
  profileSyncStore.ready,
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

/**
 * The signed-in session kept on the device (TASK-029, PRODUCT 6.1; SCREENS
 * M-AUTH-00…03): unlike the language, the city or the guest garage, this is
 * a secret and lives in the platform's secure storage (`expo-secure-store`,
 * Keychain / Keystore), never in `AsyncStorage` — same mechanism as
 * `createDeviceStore` (ARCHITECTURE 4.37 I387), only the storage adapter
 * differs, so `services/api.ts` can still read the current access token
 * synchronously (`sessionStore.get()`).
 *
 * A guest is `{ status: "signed_out" }`. Signing out, and `SESSION_ENDED`
 * from the server, both replace the value with that — the tokens are never
 * left behind (PRODUCT 6.7: sessions and any codes saved for them are gone
 * the moment the session ends).
 */
import type { SessionKind } from "@adclub/contracts";
import { createDeviceStore, type DeviceStorage, type DeviceStore } from "./device-store";

export interface StoredSession {
  accountId: string;
  sessionId: string;
  kind: SessionKind;
  accessToken: string;
  /** ISO 8601. */
  accessTokenExpiresAt: string;
  refreshToken: string;
  /** ISO 8601. */
  sessionExpiresAt: string;
}

export type StoredSessionState =
  { status: "signed_in"; session: StoredSession } | { status: "signed_out" };

/** The key of the session in the secure storage — also what sign-out deletes. */
export const SESSION_STORE_KEY = "adclub.mobile.session";

export const SIGNED_OUT: StoredSessionState = { status: "signed_out" };

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accountId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.kind === "string" &&
    typeof record.accessToken === "string" &&
    typeof record.accessTokenExpiresAt === "string" &&
    typeof record.refreshToken === "string" &&
    typeof record.sessionExpiresAt === "string"
  );
}

/** A stored value in a shape this version understands; anything else is a guest. */
export function parseStoredSessionState(raw: unknown): StoredSessionState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.status === "signed_out") return SIGNED_OUT;
  if (record.status === "signed_in" && isStoredSession(record.session)) {
    return { status: "signed_in", session: record.session };
  }
  return null;
}

/**
 * Builds the session store on a given secure storage adapter (production —
 * `expo-secure-store`; tests — an in-memory fake), so the pure rules here
 * are testable without React Native.
 */
export function createSessionStore(storage: DeviceStorage): DeviceStore<StoredSessionState> {
  return createDeviceStore(storage, {
    key: SESSION_STORE_KEY,
    initial: SIGNED_OUT,
    parse: parseStoredSessionState,
  });
}

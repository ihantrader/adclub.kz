import type { AccountProfile, SessionTokens, UpdateAccountProfileBody } from "@adclub/contracts";
import { isApiError } from "@adclub/api-client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useToast } from "../design-system";
import { garageStateFromAccountCars } from "../garage/account-cars";
import { INITIAL_GARAGE } from "../garage/garage";
import { apiClient, sessionEndedNotice } from "../services/api";
import {
  completeRegistration as apiCompleteRegistration,
  getAccountProfile,
  transferGarage as apiTransferGarage,
  updateAccountProfile as apiUpdateAccountProfile,
} from "../services/account-api";
import type { CitySelection } from "./city";
import { useT } from "./language";
import { cityStore, clearSession, garageStore, languageStore, sessionStore } from "./stores";
import type { StoredSession } from "./session-store";

/** `SessionTokens` plus the account id `verifyLoginCode` answers with, as this device keeps a session. */
export function toStoredSession(accountId: string, tokens: SessionTokens): StoredSession {
  if (!tokens.refreshToken) {
    // Only a mobile session is ever stored here (ARCHITECTURE 4.6): a web
    // kind's refresh token travels in a cookie, never in this app.
    throw new Error("A mobile sign-in without a refresh token");
  }
  return {
    accountId,
    sessionId: tokens.sessionId,
    kind: tokens.kind,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshToken: tokens.refreshToken,
    sessionExpiresAt: tokens.sessionExpiresAt,
  };
}

function cityIdOf(selection: CitySelection): string | null {
  return selection.kind === "city" ? selection.id : null;
}

export interface SessionContextValue {
  status: "guest" | "signed_in";
  accountId: string | null;
  /** `null` while a signed-in profile hasn't loaded yet, or for a guest. */
  profile: AccountProfile | null;
  profileLoading: boolean;
  /** Stores the tokens `verifyLoginCode` returned and loads the profile behind them. */
  beginSession: (session: StoredSession) => Promise<AccountProfile | null>;
  /** M-AUTH-03 «Готово»: gives the account a name and the mandatory consent. */
  completeRegistration: (name: string) => Promise<AccountProfile>;
  /** M-PRO-02 «Сохранить». */
  updateProfile: (patch: UpdateAccountProfileBody) => Promise<AccountProfile>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * The signed-in session and the account profile behind it (TASK-029): one
 * value for the whole app, like `GarageProvider` and `LanguageProvider`.
 * Rendered inside `GarageProvider`/`CityProvider`/`LanguageProvider`/
 * `ToastProvider` (`App.tsx`) — it reads and writes the guest garage, the
 * city and the language, and shows T-AUTH-06 on a successful transfer.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
  const city = useSyncExternalStore(cityStore.subscribe, cityStore.get);
  const language = useSyncExternalStore(languageStore.subscribe, languageStore.get);
  const t = useT();
  const { show } = useToast();

  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  // Whether a garage/city/language sync has been tried this app run — the
  // transfer itself is idempotent (repeating it is harmless), this only
  // avoids calling it on every render.
  const transferTried = useRef(false);
  const syncedDeviceValues = useRef<{ cityId: string | null; language: string | null } | null>(
    null,
  );

  const status: "guest" | "signed_in" = state.status === "signed_in" ? "signed_in" : "guest";
  const accountId = state.status === "signed_in" ? state.session.accountId : null;

  const loadProfile = useCallback(async (): Promise<AccountProfile | null> => {
    setProfileLoading(true);
    try {
      const next = await getAccountProfile();
      setProfile(next);
      return next;
    } catch (error) {
      // A session that just ended is handled by the session store flipping
      // to signed-out (`createSessionAwareFetch`) — nothing more to do here.
      if (!isApiError(error)) throw error;
      return null;
    } finally {
      setProfileLoading(false);
    }
  }, []);

  /**
   * The silent transfer of TASK-029 requirement 5: the guest garage merges
   * into the account (only once there is one to send), and the device's
   * city and language catch the account up. A failure here never blocks
   * being signed in (requirement 5, edge case "перенос не прошёл") — it
   * simply hasn't happened yet, and this runs again next launch.
   */
  const runTransfer = useCallback(async () => {
    if (transferTried.current) return;
    transferTried.current = true;
    try {
      const guest = garageStore.get();
      if (guest.cars.length > 0) {
        const result = await apiTransferGarage(guest.cars, guest.primaryId);
        garageStore.set(garageStateFromAccountCars(result.cars));
        if (result.transferred > 0) show(t("auth.garageTransferred"));
      }
      // Read from the stores now, not from the render this callback was made
      // in: it is made once, long before the city is chosen or the language
      // known, and a stale value here overwrote the account's city with
      // `null` right after the sync effect below had set it (found in the
      // browser walk-through of TASK-029.A).
      const cityId = cityIdOf(cityStore.get().selection);
      const lang = languageStore.get();
      syncedDeviceValues.current = { cityId, language: lang };
      const next = await apiUpdateAccountProfile({ cityId, ...(lang ? { language: lang } : {}) });
      setProfile(next);
    } catch {
      transferTried.current = false;
    }
  }, [show, t]);

  // A fresh sign-in (or the app reopening while signed in): load the profile,
  // and once it says registration is finished, try the one-time transfer.
  useEffect(() => {
    if (status !== "signed_in") {
      // Clearing local state to match the external session store flipping to
      // guest, and loading the profile from the server once it flips to
      // signed in: both are the rule's own "sync with an external system".
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProfile(null);
      transferTried.current = false;
      syncedDeviceValues.current = null;
      return;
    }
    void loadProfile();
  }, [status, loadProfile]);

  useEffect(() => {
    if (status === "signed_in" && profile?.registrationCompleted) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void runTransfer();
    }
  }, [status, profile?.registrationCompleted, runTransfer]);

  // Changing the city or the language anywhere in the app (the catalog's
  // switch, "Мои данные", M-PRO-01) keeps the account in step — one place
  // that reacts, instead of every screen that can change either calling the
  // server itself (TASK-029 requirement 6, "город и язык... в учётной записи").
  useEffect(() => {
    if (status !== "signed_in" || !profile?.registrationCompleted) return;
    const cityId = cityIdOf(city.selection);
    const already = syncedDeviceValues.current;
    if (already && already.cityId === cityId && already.language === language) return;
    syncedDeviceValues.current = { cityId, language };
    apiUpdateAccountProfile({ cityId, ...(language ? { language } : {}) }).then(
      (next) => setProfile(next),
      () => {
        // Retried the next time either value changes, or at the next sign-in.
        syncedDeviceValues.current = already;
      },
    );
  }, [status, profile?.registrationCompleted, city, language]);

  // `SESSION_ENDED` from anywhere (an expired refresh token, another device
  // ending this session) shows the explanation once the store has already
  // dropped back to a guest (PRODUCT/TASK-029 requirement 4).
  useEffect(() => {
    sessionEndedNotice.current = () => show(t("auth.sessionEnded"));
    return () => {
      sessionEndedNotice.current = () => undefined;
    };
  }, [show, t]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      accountId,
      profile,
      profileLoading,
      beginSession: async (session) => {
        transferTried.current = false;
        syncedDeviceValues.current = null;
        sessionStore.set({ status: "signed_in", session });
        return loadProfile();
      },
      completeRegistration: async (name) => {
        const next = await apiCompleteRegistration(name);
        setProfile(next);
        return next;
      },
      updateProfile: async (patch) => {
        const next = await apiUpdateAccountProfile(patch);
        setProfile(next);
        return next;
      },
      signOut: async () => {
        try {
          await apiClient.logout();
        } catch {
          // The device forgets the session either way (PRODUCT 6.7).
        }
        clearSession();
        // The account's own cars are not the next guest's to see (edge case
        // "Выход из аккаунта при пустом гостевом гараже").
        garageStore.set(INITIAL_GARAGE);
        setProfile(null);
      },
    }),
    [status, accountId, profile, profileLoading, loadProfile],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

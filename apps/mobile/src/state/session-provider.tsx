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
import { AppState } from "react-native";
import { useToast } from "../design-system";
import { INITIAL_GARAGE } from "../garage/garage";
import { accountGarage } from "../services/account-garage";
import { apiClient, sessionEndedNotice } from "../services/api";
import {
  completeRegistration as apiCompleteRegistration,
  getAccountProfile,
  updateAccountProfile as apiUpdateAccountProfile,
} from "../services/account-api";
import { selectionOf, type CitySelection } from "./city";
import { useT } from "./language";
import { runProfileSync } from "./profile-sync";
import {
  cityStore,
  clearSession,
  garageStore,
  languageStore,
  profileSyncStore,
  sessionStore,
} from "./stores";
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

function currentAccountId(): string | null {
  const state = sessionStore.get();
  return state.status === "signed_in" ? state.session.accountId : null;
}

export interface SessionContextValue {
  status: "guest" | "signed_in";
  accountId: string | null;
  /** `null` while a signed-in profile hasn't loaded yet, or for a guest. */
  profile: AccountProfile | null;
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
 * The signed-in session and the account behind it (TASK-029, TASK-029.B):
 * one value for the whole app, like `GarageProvider` and `LanguageProvider`.
 * Rendered inside `GarageProvider`/`CityProvider`/`LanguageProvider`/
 * `ToastProvider` (`App.tsx`).
 *
 * Once registration is finished the account is the source of truth for the
 * garage, the city and the language (ARCHITECTURE 4.46). This is where the
 * device and the account meet: at a sign-in and every launch, and whenever
 * the app comes back from the background, the profile is read, the garage
 * copy is synced (the guest garage transferred first, if it has cars) and
 * the city and the language are reconciled (`runProfileSync`); a change of
 * the city or the language on this device is sent at once.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
  const city = useSyncExternalStore(cityStore.subscribe, cityStore.get);
  const language = useSyncExternalStore(languageStore.subscribe, languageStore.get);
  const t = useT();
  const { show } = useToast();

  const [profile, setProfile] = useState<AccountProfile | null>(null);
  // One read of the profile at a time: a sign-in asks for it and so does the
  // effect that sees the session appear — they share the request.
  const profileRequest = useRef<Promise<AccountProfile | null> | null>(null);
  // One pass of the city and language sync at a time, in order.
  const profileQueue = useRef<Promise<void>>(Promise.resolve());

  const status: "guest" | "signed_in" = state.status === "signed_in" ? "signed_in" : "guest";
  const accountId = state.status === "signed_in" ? state.session.accountId : null;

  const loadProfile = useCallback((): Promise<AccountProfile | null> => {
    if (profileRequest.current) return profileRequest.current;
    const request = getAccountProfile()
      .then((next) => {
        // A late answer for a session that has ended meanwhile is not shown.
        if (currentAccountId() === null) return null;
        setProfile(next);
        return next;
      })
      .catch((error: unknown) => {
        // A session that just ended is handled by the session store flipping
        // to signed-out (`createSessionAwareFetch`) — nothing more to do here.
        if (!isApiError(error)) throw error;
        return null;
      })
      .finally(() => {
        profileRequest.current = null;
      });
    profileRequest.current = request;
    return request;
  }, []);

  /** One pass of the city and language rule; `account` — as just read, or `null` (only the device changed). */
  const syncProfile = useCallback((account: AccountProfile | null): Promise<void> => {
    const pass = async () => {
      const accountId = currentAccountId();
      if (accountId === null) return;
      await runProfileSync({
        accountId,
        account: account && { cityId: account.cityId, language: account.language },
        device: () => ({
          cityId: cityIdOf(cityStore.get().selection),
          language: languageStore.get(),
        }),
        synced: profileSyncStore,
        resolveCity: async (cityId) => {
          try {
            const { cities } = await apiClient.getCities();
            const match = cities.find((item) => item.id === cityId);
            // Archived by an administrator: as with any city the list no
            // longer has (`reconcileCity`) — «Весь Казахстан».
            return match ? selectionOf(match) : { kind: "all" };
          } catch {
            return "unavailable";
          }
        },
        setDeviceCity: (selection) => {
          cityStore.set({ ...cityStore.get(), selection, chosen: true });
        },
        // A language from the account is a chosen one: the start never asks again.
        setDeviceLanguage: languageStore.set,
        push: async (patch) => {
          const next = await apiUpdateAccountProfile(patch);
          if (currentAccountId() === accountId) setProfile(next);
        },
      });
    };
    const next = profileQueue.current.then(pass).catch(() => {
      // Retried at the next change, launch or return from the background.
    });
    profileQueue.current = next;
    return next;
  }, []);

  /** Garage, city and language in step with the account just read. */
  const syncAccount = useCallback(
    async (account: AccountProfile) => {
      if (!account.registrationCompleted) return;
      const garage = await accountGarage.sync();
      if (garage.kind === "synced" && garage.transferred > 0) show(t("auth.garageTransferred"));
      await syncProfile(account);
    },
    [show, t, syncProfile],
  );

  const refresh = useCallback(async () => {
    const account = await loadProfile();
    if (account) await syncAccount(account);
  }, [loadProfile, syncAccount]);

  // A sign-in, or the app opening while signed in.
  useEffect(() => {
    if (status !== "signed_in") {
      // Clearing local state to match the external session store flipping to
      // guest: the rule's own "sync with an external system".
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProfile(null);
      return;
    }
    void refresh();
  }, [status, refresh]);

  // Back from the background: what another phone changed meanwhile (TASK-029.B).
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && currentAccountId() !== null) void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  // The city or the language changed on this device (the catalog's switch,
  // M-PRO-01): one place sends it, instead of every screen that can change
  // either (I432). A pass that applied the account's values finds nothing to
  // send — it agreed on them before changing the stores.
  const registered = profile?.registrationCompleted === true;
  useEffect(() => {
    if (status !== "signed_in" || !registered) return;
    const agreed = profileSyncStore.get();
    // Nothing agreed yet: the pass after reading the profile does the first one.
    if (agreed?.accountId !== currentAccountId()) return;
    void syncProfile(null);
  }, [status, registered, city, language, syncProfile]);

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
      beginSession: async (session) => {
        sessionStore.set({ status: "signed_in", session });
        return loadProfile();
      },
      completeRegistration: async (name) => {
        const next = await apiCompleteRegistration(name);
        setProfile(next);
        void syncAccount(next);
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
    [status, accountId, profile, loadProfile, syncAccount],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

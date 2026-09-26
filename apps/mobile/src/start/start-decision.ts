import { isLang, type Lang } from "@adclub/i18n";

/**
 * M-START-01: the one place that decides what the app opens (SCREENS 5.1).
 *
 * A pure function on purpose — the order of the seven rules is the product
 * decision, and it is checked by tests without React Native. Everything the
 * order needs is an input; the inputs whose data arrives with later tasks
 * (a session — TASK-029, the saved copy of active orders — TASK-030, a push
 * — TASK-031) are already here and are passed as "no" today. Adding them
 * later means passing another value, not changing this order.
 */
export type StartScreen =
  /** M-START-01 — the logo, while the policy answer is still worth waiting for. */
  | "splash"
  /** M-START-03 — the server said this version is too old. */
  | "update-required"
  /** M-START-02 — the system language is not kk/ru/en. */
  | "language"
  /** M-START-04 — the first run: the city. */
  | "first-run-city"
  /** M-START-05 — the first run: the car (TASK-028). */
  | "first-run-car"
  /** M-CAT-01 — the catalog. */
  | "catalog"
  /** M-ORD-02 — active orders from the saved copy, without a network. */
  | "orders-offline"
  /** The screen a push points at (TASK-031). */
  | "push";

/** The step of the first run the user stopped at. */
export type FirstRunStep = "city" | "car";

/** What the app knows about the policy answer when the splash has to decide. */
export type PolicyState =
  /** The server explicitly said this version is too old. */
  | "update-required"
  /** The server explicitly allowed this version. */
  | "supported"
  /** No explicit answer (offline, server down, unreadable policy). */
  | "unverified"
  /** No answer yet — the splash does not wait for the server longer than a few seconds. */
  | "pending";

/** The saved session (TASK-029): today always `none`. */
export type SessionState = "none" | "active" | "revoked";

export interface PushTarget {
  /** Where the push points; the app maps it to a screen in TASK-031. */
  screen: string;
  params?: Readonly<Record<string, string>>;
}

export interface StartInput {
  policy: PolicyState;
  /** The language chosen and kept on the device; `null` — never chosen. */
  storedLanguage: Lang | null;
  /** The device language when it is kk/ru/en, otherwise `null`. */
  systemLanguage: Lang | null;
  firstRun: { completed: boolean; step: FirstRunStep };
  session: SessionState;
  online: boolean;
  /** Whether the device holds a copy of active orders (TASK-030). */
  savedActiveOrders: boolean;
  /** The push the app was opened from (TASK-031). */
  push: PushTarget | null;
}

export interface StartDecision {
  screen: StartScreen;
  /**
   * The system language to apply silently and keep (rule 2): set only when
   * no language was chosen yet and the system one is kk/ru/en.
   */
  applyLanguage?: Lang;
  /** Rule 4: the catalog opens as a guest with the "you were signed out" sheet. */
  signedOutNotice?: true;
  /** Rule 6: where the push points. */
  push?: PushTarget;
}

/**
 * The order of SCREENS 5.1, rule by rule. Every earlier rule wins over the
 * later ones: a 426 outranks everything (it is also applied while the app is
 * already running — the same function runs again with `policy:
 * "update-required"`), and an unfinished first run outranks a revoked
 * session, a missing network and a push.
 */
export function decideStart(input: StartInput): StartDecision {
  // 1. The server said an update is required.
  if (input.policy === "update-required") {
    return { screen: "update-required" };
  }

  // No answer yet: the splash stays — but the caller only reports `pending`
  // for the first couple of seconds and then switches to `unverified`, so
  // the app never waits for the server longer than that (SCREENS 5.1).
  if (input.policy === "pending") {
    return { screen: "splash" };
  }

  // 2. No language chosen yet: apply the system one silently when it is
  //    kk/ru/en, otherwise ask (M-START-02).
  if (input.storedLanguage === null) {
    if (input.systemLanguage === null) {
      return { screen: "language" };
    }
    return { ...continueAfterLanguage(input), applyLanguage: input.systemLanguage };
  }

  return continueAfterLanguage(input);
}

/** Rules 3–7, once the interface language is settled. */
function continueAfterLanguage(input: StartInput): StartDecision {
  // 3. The first run is not finished — its first step, or the step the user
  //    stopped at.
  if (!input.firstRun.completed) {
    return { screen: input.firstRun.step === "car" ? "first-run-car" : "first-run-city" };
  }

  // 4. The saved session was revoked: the catalog as a guest plus the sheet
  //    "Вы вышли из аккаунта" (the saved codes are already deleted).
  if (input.session === "revoked") {
    return { screen: "catalog", signedOutNotice: true };
  }

  // 5. No network, signed in, and the device holds active orders.
  if (!input.online && input.session === "active" && input.savedActiveOrders) {
    return { screen: "orders-offline" };
  }

  // 6. Opened from a push.
  if (input.push) {
    return { screen: "push", push: input.push };
  }

  // 7. Otherwise the catalog.
  return { screen: "catalog" };
}

/**
 * The interface language of this launch: the choice kept on the device, or
 * the system one when it is kk/ru/en, or Russian. `decideStart` decides
 * whether to ask — this only says what to render with meanwhile.
 */
export function startLanguage(storedLanguage: Lang | null, systemLanguage: Lang | null): Lang {
  return storedLanguage ?? systemLanguage ?? "ru";
}

/**
 * The device language as a supported one: `kk`/`ru`/`en` (with a region,
 * `kk-KZ` → `kk`), and `null` for anything else — Turkish, for example,
 * means the app asks (rule 2). Deliberately stricter than the server's
 * `pickLanguage`, which falls back to Russian: a silent Russian for a
 * Turkish phone would skip the question.
 */
export function supportedSystemLanguage(locale: string | null | undefined): Lang | null {
  const tag = locale?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return isLang(tag) ? tag : null;
}

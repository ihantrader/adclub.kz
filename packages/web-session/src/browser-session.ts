import { apiRoutes, CLIENT_HEADER, formatClientHeader } from "@adclub/contracts";
import { reportRequestOutcome } from "./connection";
import {
  createWebSession,
  exchangeVerdictOf,
  type ExchangeVerdict,
  type TabChannel,
  type TabLock,
  type TabMessage,
  type WebSession,
} from "./session-core";

/**
 * Connects the session rules (`session-core.ts`, where they are tested) to
 * the browser: the real `fetch`, the cookie exchange, Web Locks and a
 * BroadcastChannel between the tabs of one web client (the cabinet's tabs
 * talk to each other, never to the admin panel's). Browsers without the
 * last two (Safari before 15.4) still work: the server's grace period keeps
 * concurrent exchanges of several tabs from ending the session.
 */
const EXCHANGE_TIMEOUT_MS = 10_000;
const ATTEMPT_TIMEOUT_MS = 12_000;

/** The web clients that sign in with a session cookie. */
export type WebPlatform = "supplier-web" | "admin-web";

function browserLock(name: string): TabLock | undefined {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return undefined;
  return <T>(task: () => Promise<T>) => locks.request(name, task) as Promise<T>;
}

function browserChannel(name: string): TabChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(name);
  return {
    post: (message) => channel.postMessage(message),
    subscribe(listener) {
      const handle = (event: MessageEvent<TabMessage>) => listener(event.data);
      channel.addEventListener("message", handle);
      return () => channel.removeEventListener("message", handle);
    },
  };
}

export interface BrowserSessionOptions {
  apiUrl: string;
  client: { platform: WebPlatform; version: string };
  onUpdateRequired: (message: string) => void;
  onContextChanged: () => void;
}

export function createBrowserSession(options: BrowserSessionOptions): WebSession {
  const { platform } = options.client;

  /** `POST /auth/session/refresh` with the HttpOnly cookie; never through the wrapped `fetch`. */
  async function exchange(): Promise<ExchangeVerdict> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
    try {
      const response = await fetch(`${options.apiUrl}${apiRoutes.refreshSession.path}`, {
        method: apiRoutes.refreshSession.method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          [CLIENT_HEADER]: formatClientHeader(options.client),
        },
        body: "{}",
        credentials: "include",
        signal: controller.signal,
      });
      reportRequestOutcome(true);
      return await exchangeVerdictOf(response);
    } catch {
      // No answer at all: the «Нет сети» banner, as for any other request.
      reportRequestOutcome(false);
      return { kind: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  return createWebSession({
    fetch: (input, init) => fetch(input, init),
    exchange,
    lock: browserLock(`adclub.${platform}.refresh`),
    channel: browserChannel(`adclub.${platform}.session`),
    attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
    onUpdateRequired: options.onUpdateRequired,
    onContextChanged: options.onContextChanged,
  });
}

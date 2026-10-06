import { isApiError } from "@adclub/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useLoadingGate } from "../design-system/loading";
import type { RequestCache } from "./request-cache";

/**
 * One request of one screen (TASK-028): the loading state, the error told
 * apart well enough to word it for a person, the refresh over content that
 * is already shown (SCREENS 2.1) and «Повторить».
 *
 * **Freshness.** An answer to a guest may be kept by any cache for a minute
 * (`Cache-Control: public, max-age=60`, ARCHITECTURE 4.29), so a screen the
 * user comes back to after longer than that could be showing a price that
 * has changed. Every catalog request therefore carries `staleAfterMs`: when
 * the app returns from the background, or the screen is focused again, and
 * the answer is older than that, it is loaded afresh — over the content
 * that is on screen, not instead of it.
 *
 * **Without flicker** (DESIGN 7.6, D-069): every answer — and every error —
 * reaches the screen through the loading rule of `@adclub/ui-core`: a quick
 * one at once, one that made the refresh line appear when the line has been
 * seen its minimum. `refreshing` is that line, never a blink of it.
 */

export type RequestFailure =
  /** No response at all: offline, timeout, refused connection. */
  | "network"
  /** 429: the catalog's rate limit (ARCHITECTURE 4.30). */
  | "rate_limited"
  /** The car does not make sense to the server any more (a deleted generation). */
  | "vehicle"
  /** 404: the category or the item is gone, hidden or archived. */
  | "not_found"
  | "other";

export interface RequestState<T> {
  status: "idle" | "loading" | "ready" | "error";
  data: T | null;
  failure: RequestFailure | null;
  /** Loading over data that is already on screen — after the delay of the loading rule. */
  refreshing: boolean;
  /**
   * The key of the answer on screen: changes when an answer to another
   * question (another sort) takes the place of the old one — `Screen`
   * fades the new content in on it.
   */
  answerKey: string | null;
  reload: () => void;
  /** Reloads only when the answer is older than `staleAfterMs`. */
  reloadIfStale: () => void;
}

export interface RequestOptions {
  /** How long an answer may be shown before it is loaded afresh. */
  staleAfterMs?: number;
  /**
   * A short memory shared by the screens of one flow. A screen that opens
   * while the memory holds the answer starts with it — no skeleton, no
   * request — and every answer that arrives is written to it. «Повторить»
   * and a refresh still ask the server.
   */
  cache?: RequestCache;
  /**
   * What the answer is *about*, coarser than `key`: the card of one item, the
   * count of one category. While a new key of the same scope is loading — the
   * offers in another order, the count under other filters — the previous
   * answer stays on screen and the load is reported as a refresh (SCREENS 2.1:
   * «старое содержимое остаётся, сверху индикатор»), instead of the whole
   * screen turning into a skeleton, losing its title and the reader's place.
   * A new scope, or a failed new key, starts from nothing.
   */
  scope?: string;
}

export function failureOf(error: unknown): RequestFailure {
  if (!isApiError(error)) return "other";
  if (error.code === "NETWORK_ERROR") return "network";
  if (error.code === "RATE_LIMITED") return "rate_limited";
  if (error.code === "COMPATIBILITY_VEHICLE_INVALID") return "vehicle";
  if (error.status === 404) return "not_found";
  return "other";
}

/**
 * `key` identifies the request: a new key means new data (another category,
 * another car, another language). `load` is read from a ref, so a screen may
 * build it inline without restarting the request on every render.
 */
export function useRequest<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  { staleAfterMs, cache, scope }: RequestOptions = {},
): RequestState<T> {
  // The loader is read from a ref so a screen may build it inline without
  // restarting the request on every render. It is updated in an effect
  // declared before the request's own, so the request always calls the
  // latest one.
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });

  // What the memory of the flow already holds for this key when the screen
  // opens: the screen starts with it instead of a skeleton and does not ask
  // again. Read once, at the first frame — a screen whose key changes later
  // asks the server as always.
  const [seeded] = useState<{ key: string; data: T; at: number } | null>(() => {
    const kept = key !== null && cache ? cache.read<T>(key) : undefined;
    return key !== null && kept !== undefined ? { key, data: kept.value, at: kept.at } : null;
  });
  /** The request the memory has already answered; taken at the first effect. */
  const answered = useRef<string | null>(seeded ? `${seeded.key}#0` : null);

  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<string | null>(seeded ? `${seeded.key}#0` : null);
  const [result, setResult] = useState<{
    key: string;
    /** The scope the answer was asked in (see `RequestOptions.scope`). */
    scope: string | undefined;
    data: T | null;
    failure: RequestFailure | null;
  }>(
    seeded
      ? { key: seeded.key, scope, data: seeded.data, failure: null }
      : { key: "", scope: undefined, data: null, failure: null },
  );
  const loadedAt = useRef(0);
  const gate = useLoadingGate();
  const { begin, settle, cancel } = gate;

  // The attempt is part of the request but not of the identity of the data:
  // «Повторить» and a stale refresh load over what is on screen, while a new
  // key (another category, another car, another language) replaces it.
  const request = key === null ? null : `${key}#${attempt}`;

  useEffect(() => {
    if (request === null || key === null) return;
    // The first request of a screen that started with an answer of the
    // memory is already answered — once: the same key asked for again later
    // (a retry, coming back to it) goes to the server as always.
    const alreadyAnswered = answered.current === request;
    answered.current = null;
    if (alreadyAnswered) {
      // As old as the memory says, not as old as the screen: an answer of the
      // memory that is 59 s old is 59 s old, whenever the screen opened.
      loadedAt.current = seeded?.at ?? Date.now();
      return;
    }
    const controller = new AbortController();
    const ticket = begin();
    loader
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        loadedAt.current = Date.now();
        cache?.write(key, data);
        settle(ticket, () => {
          setResult({ key, scope, data, failure: null });
          setSettled(request);
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        loadedAt.current = Date.now();
        settle(ticket, () => {
          setResult((previous) => ({
            key,
            scope,
            // The old data stays on screen while a refresh fails (SCREENS 2.1);
            // a new request — even one of the same scope, whose answer would
            // no longer match what was asked — starts with nothing to show.
            data: previous.key === key ? previous.data : null,
            failure: failureOf(error),
          }));
          setSettled(request);
        });
      });
    return () => {
      controller.abort();
      // Nothing more to wait for, unless the next request begins right away.
      cancel();
    };
    // `key` only ever changes together with `request`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const reloadIfStale = useCallback(() => {
    if (staleAfterMs === undefined || loadedAt.current === 0) return;
    if (Date.now() - loadedAt.current >= staleAfterMs) reload();
  }, [reload, staleAfterMs]);

  // Back from the background: a price older than the server's own cache
  // window must not stay on screen.
  useEffect(() => {
    if (staleAfterMs === undefined) return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") reloadIfStale();
    });
    return () => subscription.remove();
  }, [reloadIfStale, staleAfterMs]);

  const fresh = key !== null && result.key === key;
  // An older answer to the same question stays until the new one arrives.
  const carried = !fresh && scope !== undefined && result.scope === scope;
  const data = fresh || carried ? result.data : null;
  const failure = fresh ? result.failure : null;
  const pending = request !== null && settled !== request;

  const status: RequestState<T>["status"] =
    request === null
      ? "idle"
      : data !== null
        ? "ready"
        : pending
          ? "loading"
          : failure !== null
            ? "error"
            : "loading";

  return {
    status,
    data,
    failure,
    refreshing: pending && gate.indicator && data !== null,
    answerKey: data !== null ? result.key : null,
    reload,
    reloadIfStale,
  };
}

import { isApiError } from "@adclub/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

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
  /** Loading over data that is already on screen. */
  refreshing: boolean;
  reload: () => void;
  /** Reloads only when the answer is older than `staleAfterMs`. */
  reloadIfStale: () => void;
}

export interface RequestOptions {
  /** How long an answer may be shown before it is loaded afresh. */
  staleAfterMs?: number;
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
  { staleAfterMs }: RequestOptions = {},
): RequestState<T> {
  // The loader is read from a ref so a screen may build it inline without
  // restarting the request on every render. It is updated in an effect
  // declared before the request's own, so the request always calls the
  // latest one.
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });

  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<string | null>(null);
  const [result, setResult] = useState<{
    key: string;
    data: T | null;
    failure: RequestFailure | null;
  }>({ key: "", data: null, failure: null });
  const loadedAt = useRef(0);

  // The attempt is part of the request but not of the identity of the data:
  // «Повторить» and a stale refresh load over what is on screen, while a new
  // key (another category, another car, another language) replaces it.
  const request = key === null ? null : `${key}#${attempt}`;

  useEffect(() => {
    if (request === null || key === null) return;
    const controller = new AbortController();
    loader
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        loadedAt.current = Date.now();
        setResult({ key, data, failure: null });
        setSettled(request);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        loadedAt.current = Date.now();
        setResult((previous) => ({
          key,
          // The old data stays on screen while a refresh fails (SCREENS 2.1);
          // a new request starts with nothing to show.
          data: previous.key === key ? previous.data : null,
          failure: failureOf(error),
        }));
        setSettled(request);
      });
    return () => controller.abort();
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
  const data = fresh ? result.data : null;
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
    refreshing: pending && data !== null,
    reload,
    reloadIfStale,
  };
}

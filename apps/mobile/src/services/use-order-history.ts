import { useCallback, useEffect, useRef, useState } from "react";
import { appendHistoryPage, EMPTY_HISTORY, type HistoryState } from "../orders/order-history";
import { apiClient } from "./api";
import { failureOf, type RequestFailure } from "./use-request";

const HISTORY_PAGE = 20;

export interface OrderHistoryState {
  status: "idle" | "loading" | "ready" | "error";
  history: HistoryState;
  failure: RequestFailure | null;
  loadingMore: boolean;
  /** Starts over from the first page (on opening, a pull, «Повторить»). */
  reload: () => void;
  /** The next page by the server's cursor; nothing while one is on its way. */
  loadMore: () => void;
}

/**
 * «История» of M-ORD-02 (TASK-030): pages of `GET /order-history` by the
 * server's cursor, joined by `appendHistoryPage` — an order is neither lost
 * nor shown twice across pages. `key` names whose history it is (the account
 * and the language): another key starts over; `null` — not asked (a guest,
 * no network).
 */
export function useOrderHistory(key: string | null): OrderHistoryState {
  const [state, setState] = useState<{
    key: string | null;
    status: OrderHistoryState["status"];
    history: HistoryState;
    failure: RequestFailure | null;
  }>({ key: null, status: "idle", history: EMPTY_HISTORY, failure: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    if (key === null) return;
    const mine = ++generation.current;
    const controller = new AbortController();
    // The request below is the external system; this marks it as on its way.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((previous) => ({
      key,
      // A reload keeps the list on screen under the refresh line (SCREENS 2.1).
      status: previous.key === key && previous.status === "ready" ? "ready" : "loading",
      history: previous.key === key ? previous.history : EMPTY_HISTORY,
      failure: null,
    }));
    apiClient
      .getOrderHistory({ signal: controller.signal, query: { limit: HISTORY_PAGE } })
      .then((page) => {
        if (generation.current !== mine) return;
        setState({
          key,
          status: "ready",
          history: appendHistoryPage(EMPTY_HISTORY, page),
          failure: null,
        });
      })
      .catch((error: unknown) => {
        if (generation.current !== mine || controller.signal.aborted) return;
        setState((previous) => ({
          ...previous,
          status: previous.status === "ready" ? "ready" : "error",
          failure: failureOf(error),
        }));
      });
    return () => controller.abort();
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const loadMore = useCallback(() => {
    const cursor = state.history.nextCursor;
    if (state.status !== "ready" || cursor === null || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    apiClient
      .getOrderHistory({ query: { limit: HISTORY_PAGE, cursor } })
      .then((page) => {
        if (generation.current !== mine) return;
        setState((previous) => ({
          ...previous,
          history: appendHistoryPage(previous.history, page),
        }));
      })
      .catch((error: unknown) => {
        if (generation.current !== mine) return;
        setState((previous) => ({ ...previous, failure: failureOf(error) }));
      })
      .finally(() => setLoadingMore(false));
  }, [state, loadingMore]);

  const current =
    state.key === key ? state : { status: "idle" as const, history: EMPTY_HISTORY, failure: null };
  return {
    status: key === null ? "idle" : current.status,
    history: current.history,
    failure: current.failure,
    loadingMore,
    reload,
    loadMore,
  };
}

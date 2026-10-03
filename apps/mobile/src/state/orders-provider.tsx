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
import {
  copyFor,
  copyFromResponse,
  copyIsOrphaned,
  type SavedOrdersCopy,
} from "../orders/order-copy";
import { apiClient } from "../services/api";
import { useOnline } from "../services/use-network";
import { ordersCopyStore, sessionStore } from "./stores";

/**
 * The saved copy of active orders for the whole app (TASK-030 requirement
 * 6): one value, like the session and the garage. It shows the copy only
 * to the account it was saved for, deletes a copy that belongs to nobody
 * signed in now, and refreshes it — whole, from `GET /active-orders` — when
 * the app opens or comes back from the background with a network, when the
 * network comes back, and when a screen asks (the tab «Заявки», an order
 * created or cancelled, an order screen that sees the copy is behind).
 */
export interface OrdersCopyValue {
  /** The copy of the signed-in account; `null` — none (a guest, nothing saved yet). */
  copy: SavedOrdersCopy | null;
  /** A refresh is on its way. */
  refreshing: boolean;
  /** The last refresh failed (no network, the server): the copy shown is the older one. */
  refreshFailed: boolean;
  /** Asks the server for the copy now; several asks at once make one request. */
  refresh: () => Promise<void>;
}

const OrdersCopyContext = createContext<OrdersCopyValue | null>(null);

/** Both the session and the copy have been read from the device: only then is a copy known to be orphaned. */
const storesRead = Promise.all([sessionStore.ready, ordersCopyStore.ready]).then(() => undefined);

export function OrdersCopyProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
  const saved = useSyncExternalStore(ordersCopyStore.subscribe, ordersCopyStore.get);
  const online = useOnline();
  const accountId = session.status === "signed_in" ? session.session.accountId : null;
  const [read, setRead] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let active = true;
    void storesRead.then(() => {
      if (active) setRead(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // Signed out, or signed in as someone else, while the device held a copy:
  // it goes (requirement 6 «при смене учётной записи»). Not before both
  // stores are read — a session not read yet looks like a guest.
  useEffect(() => {
    if (read && copyIsOrphaned(saved, accountId)) void ordersCopyStore.clear();
  }, [read, saved, accountId]);

  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const forAccount = accountId;
    if (forAccount === null) return Promise.resolve();
    setRefreshing(true);
    const run = (async () => {
      try {
        const response = await apiClient.getActiveOrders();
        // The answer belongs to the account that asked: a sign-out or another
        // sign-in meanwhile must not get it.
        const now = sessionStore.get();
        if (now.status === "signed_in" && now.session.accountId === forAccount) {
          await ordersCopyStore.save(copyFromResponse(forAccount, response));
        }
        setRefreshFailed(false);
      } catch (error) {
        // `SESSION_ENDED` has cleared the session and the copy already
        // (`clearSession`); anything else keeps the older copy on screen.
        if (!isApiError(error) || error.code !== "SESSION_ENDED") setRefreshFailed(true);
      } finally {
        setRefreshing(false);
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [accountId]);

  // The app opens (or a person signs in) with a network, and the network
  // comes back: the copy is asked for afresh.
  useEffect(() => {
    // Asking the server is the external system this effect keeps in step.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (read && accountId !== null && online) void refresh();
  }, [read, accountId, online, refresh]);

  // Back from the background.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const value = useMemo<OrdersCopyValue>(
    () => ({ copy: copyFor(saved, accountId), refreshing, refreshFailed, refresh }),
    [saved, accountId, refreshing, refreshFailed, refresh],
  );
  return <OrdersCopyContext.Provider value={value}>{children}</OrdersCopyContext.Provider>;
}

export function useOrdersCopy(): OrdersCopyValue {
  const value = useContext(OrdersCopyContext);
  if (!value) throw new Error("useOrdersCopy must be used inside <OrdersCopyProvider>");
  return value;
}

/**
 * «Только просмотр» (M-START-03 → M-ORD-02, D-027): the app must be updated,
 * so nothing that needs the server is offered — only the codes and the QR
 * from the copy. The update screen opens the order screens inside this, and
 * `exit` («Назад» on the list) returns to it.
 */
const ReadOnlyContext = createContext<{ exit: () => void } | null>(null);

export function OrdersReadOnly({ exit, children }: { exit: () => void; children: ReactNode }) {
  const value = useMemo(() => ({ exit }), [exit]);
  return <ReadOnlyContext.Provider value={value}>{children}</ReadOnlyContext.Provider>;
}

/** `null` — the ordinary app; otherwise the read-only mode and the way back to the update screen. */
export function useOrdersReadOnly(): { exit: () => void } | null {
  return useContext(ReadOnlyContext);
}

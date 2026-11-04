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
import { AppState, StyleSheet, View } from "react-native";
import { Button, Icon, Sheet, Text } from "../design-system";
import { openPushTarget } from "../navigation/navigation-ref";
import {
  offeredOnce,
  pushPromised,
  registrationKey,
  shouldOfferPush,
  type PushMessage,
  type PushPermission,
} from "../push/push-logic";
import type { DevicePushToken } from "../push/push-port";
import type { PushTarget } from "../start/start-decision";
import { apiClient } from "../services/api";
import { pushPort } from "../services/push";
import { useT } from "./language";
import { useOrdersCopy } from "./orders-provider";
import { pushOffersStore, sessionStore } from "./stores";

/**
 * Push on the device (TASK-051; SCREENS M-PUSH-01, M-PRO-04, 5.1 rule 6;
 * ARCHITECTURE 4.79): the permission, the token sent to the server for this
 * session, a push received (the copy of orders refreshed, the push confirmed)
 * and a push opened (the order opened, the push confirmed), and the sheet
 * that asks after an order. The permission is asked nowhere else than that
 * sheet and «Открыть настройки» of the profile.
 */
export interface PushValue {
  /** `null` — not known yet. */
  permission: PushPermission | null;
  /** Whether a push is on its way for this person (the screen of an order may promise one). */
  promised: boolean;
  /** This build has push at all. */
  available: boolean;
  /** What the push the app was opened from points at (SCREENS 5.1 rule 6); `null` — none. */
  startTarget: PushTarget | null;
  /** After M-ORD-01 succeeded: M-PUSH-01, when it is due. */
  afterOrderPlaced: () => void;
  /** M-PRO-04: the system dialog while it can still be shown, the system settings otherwise. */
  openSettings: () => Promise<void>;
  /** An order's pushes arrived while the app is open: the screens of that order listen. */
  subscribe: (listener: (orderId: string) => void) => () => void;
}

const PushContext = createContext<PushValue | null>(null);

export function PushProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
  const signedIn = session.status === "signed_in" ? session.session : null;
  const orders = useOrdersCopy();
  const [permission, setPermission] = useState<PushPermission | null>(null);
  const [offer, setOffer] = useState(false);
  const registered = useRef<string | null>(null);
  const listeners = useRef(new Set<(orderId: string) => void>());
  /** Confirmations that could not be sent (no network): tried again on the next return. */
  const unsent = useRef(new Set<string>());
  const refreshOrders = orders.refresh;

  const readPermission = useCallback(async () => {
    const next = await pushPort.permission().catch(() => null);
    setPermission(next);
    return next;
  }, []);

  const ack = useCallback((notificationId: string | null) => {
    if (!notificationId || sessionStore.get().status !== "signed_in") return;
    apiClient.ackNotification({ notificationId }).catch(() => unsent.current.add(notificationId));
  }, []);

  const register = useCallback(
    async (token: DevicePushToken | null) => {
      if (!signedIn || !token) return;
      const key = registrationKey(signedIn.sessionId, token.token);
      if (registered.current === key) return;
      try {
        await apiClient.registerPushToken({ platform: token.platform, token: token.token });
        registered.current = key;
      } catch {
        // Tried again at the next start, return or change of the token.
      }
    },
    [signedIn],
  );

  // The permission at start and on every return; the token of a signed-in
  // session with the permission sent to the server.
  useEffect(() => {
    const sync = async () => {
      const now = await readPermission();
      if (now?.status === "granted" && signedIn) {
        await register(await pushPort.deviceToken());
      }
      for (const id of [...unsent.current]) {
        unsent.current.delete(id);
        ack(id);
      }
    };
    void sync();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void sync();
    });
    return () => subscription.remove();
  }, [readPermission, register, signedIn, ack]);

  // A new session: its token is not the old one's.
  useEffect(() => {
    if (!signedIn) registered.current = null;
  }, [signedIn]);

  useEffect(() => pushPort.onTokenChange((token) => void register(token)), [register]);

  const handle = useCallback(
    (message: PushMessage, opened: boolean) => {
      ack(message.notificationId);
      const orderId =
        message.target?.screen === "order" ? message.target.params?.orderId : undefined;
      // The status changed: the copy of orders (and the code in it) follows at once (R18).
      void refreshOrders();
      if (orderId) {
        for (const listener of listeners.current) listener(orderId);
      }
      if (opened && message.target && sessionStore.get().status === "signed_in") {
        openPushTarget(message.target);
      }
    },
    [ack, refreshOrders],
  );

  useEffect(() => pushPort.onReceived((message) => handle(message, false)), [handle]);
  useEffect(() => pushPort.onOpened((message) => handle(message, true)), [handle]);
  const [startTarget, setStartTarget] = useState<PushTarget | null>(null);
  const startRead = useRef(false);
  useEffect(() => {
    // Opened from a push (a cold start): the start decision opens the tab
    // under it, and the order itself once the navigator is ready.
    if (startRead.current) return;
    startRead.current = true;
    void pushPort.initialOpened().then((message) => {
      if (!message) return;
      setStartTarget(message.target);
      handle(message, true);
    });
  }, [handle]);

  const afterOrderPlaced = useCallback(() => {
    const accountId = sessionStore.get().status === "signed_in" ? signedIn?.accountId : null;
    if (!accountId || !pushPort.available) return;
    void readPermission().then((now) => {
      if (shouldOfferPush(now, pushOffersStore.get()[accountId] ?? 0)) {
        pushOffersStore.set(offeredOnce(pushOffersStore.get(), accountId));
        setOffer(true);
      }
    });
  }, [readPermission, signedIn]);

  const enable = useCallback(async () => {
    setOffer(false);
    const next = await pushPort.request().catch(() => null);
    setPermission(next);
    if (next?.status === "granted") {
      await register(await pushPort.deviceToken());
    }
  }, [register]);

  const openSettings = useCallback(async () => {
    const now = await readPermission();
    if (now && now.status === "undetermined" && now.canAskAgain) {
      await enable();
      return;
    }
    await pushPort.openSettings().catch(() => undefined);
  }, [readPermission, enable]);

  const value = useMemo<PushValue>(
    () => ({
      permission,
      promised: pushPort.available && pushPromised(permission),
      available: pushPort.available,
      startTarget,
      afterOrderPlaced,
      openSettings,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [permission, startTarget, afterOrderPlaced, openSettings],
  );

  return (
    <PushContext.Provider value={value}>
      {children}
      {/* M-PUSH-01: after the order, before its screen is read. */}
      <Sheet
        visible={offer}
        onClose={() => setOffer(false)}
        title={t("push.offer.title")}
        closeLabel={t("common.close")}
      >
        <View style={styles.content}>
          <Icon name="bell" size={32} color="accent" />
          <Text color="textMuted">{t("push.offer.text")}</Text>
          <Button onPress={() => void enable()}>{t("push.offer.enable")}</Button>
          <Button variant="text" tone="neutral" onPress={() => setOffer(false)}>
            {t("push.offer.later")}
          </Button>
        </View>
      </Sheet>
    </PushContext.Provider>
  );
}

export function usePush(): PushValue {
  const value = useContext(PushContext);
  if (!value) throw new Error("usePush must be used inside <PushProvider>");
  return value;
}

const styles = StyleSheet.create({
  content: { gap: 12, paddingBottom: 8 },
});

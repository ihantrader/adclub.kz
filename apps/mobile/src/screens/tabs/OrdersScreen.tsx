import type { MobileTextKey } from "@adclub/i18n";
import { layout } from "@adclub/ui-core";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  DataState,
  EmptyState,
  OfflineBanner,
  OfflineContent,
  Screen,
  Segments,
  SkeletonList,
  Text,
  useDelayedIndicator,
} from "../../design-system";
import { ROOT_NAVIGATOR, type RootParams } from "../../navigation/routes";
import { useSignIn } from "../../navigation/use-sign-in";
import { mainDateText, orderActiveOrders } from "../../orders/active-orders";
import { monthOf } from "../../orders/order-history";
import { CLUB_TIME_ZONE } from "../../orders/order-time";
import { useOnline } from "../../services/use-network";
import { useOrderHistory } from "../../services/use-order-history";
import { useLanguage } from "../../state/language";
import { useOrdersCopy, useOrdersReadOnly } from "../../state/orders-provider";
import { useSession } from "../../state/session-provider";
import { OrderRow, useNow, useOrderTime } from "../orders/parts";
import { useRepeatOrder } from "../orders/use-repeat-order";

type Tab = "active" | "history";

/**
 * M-ORD-02 «Мои заявки» (TASK-030 requirement 4). A guest has no orders at
 * all: the empty state of SCREENS 5.1 with «Войти» straight to M-AUTH-01
 * (this tab is «не шторка»). Signed in: «Активные» — the saved copy, which
 * this tab asks the server to refresh whenever it is opened with a network,
 * so with a network and without it the list is one and the same; and
 * «История» — finished orders by months, page by page, only with a network.
 *
 * Opened from M-START-03 it is the read-only list (D-027): the codes of the
 * copy and nothing that needs the server, under «Приложение нужно обновить».
 */
export function OrdersScreen() {
  const { t } = useLanguage();
  const online = useOnline();
  const session = useSession();
  const signIn = useSignIn();
  const readOnly = useOrdersReadOnly();

  if (session.status === "guest" && !readOnly) {
    return (
      <Screen
        title={t("tabs.orders")}
        root
        banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      >
        <View style={styles.content}>
          <EmptyState
            icon="receipt"
            title={t("orders.guestEmptyTitle")}
            action={<Button onPress={signIn.start}>{t("auth.signIn")}</Button>}
          />
        </View>
      </Screen>
    );
  }
  return <SignedInOrders />;
}

function SignedInOrders() {
  const { t, lang } = useLanguage();
  const online = useOnline();
  const session = useSession();
  const readOnly = useOrdersReadOnly();
  const orders = useOrdersCopy();
  const now = useNow();
  const time = useOrderTime();
  const repeat = useRepeatOrder();
  const navigation = useNavigation();
  const root = () => navigation.getParent<NativeStackNavigationProp<RootParams>>(ROOT_NAVIGATOR);
  const [tab, setTab] = useState<Tab>("active");
  const history = useOrderHistory(
    !readOnly && online && tab === "history" && session.accountId
      ? `${session.accountId}:${lang}`
      : null,
  );

  // Opening the tab with a network asks for the copy afresh (SCREENS «Сохранённая копия»).
  // …and the history too, when it is coming back into view: an order given
  // out while the person was elsewhere belongs in it now.
  const firstFocus = useRef(true);
  const reloadHistory = history.reload;
  useFocusEffect(
    useCallback(() => {
      if (!readOnly) void orders.refresh();
      if (firstFocus.current) firstFocus.current = false;
      else reloadHistory();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [readOnly, reloadHistory]),
  );

  const copy = orders.copy;
  const updated = copy
    ? time.updated(copy.serverTime, now, {
        time: "orders.offlineBanner",
        date: "orders.offlineBannerDate",
      })
    : null;
  const openOrder = (orderId: string) => root()?.push("order", { orderId });

  const banner = readOnly ? (
    <Banner tone="warning" icon="refresh" placement="flush">
      {t("orders.readOnlyBanner")}
    </Banner>
  ) : !online ? (
    <OfflineBanner label={updated ?? t("state.offline")} />
  ) : null;

  // The line of a refresh (a pull, a return to the tab) by the loading rule:
  // a quick answer shows none, a slow one keeps it at least its minimum.
  const refreshing = useDelayedIndicator(
    tab === "active"
      ? orders.refreshing && copy !== null
      : history.status === "loading" && history.history.months.length > 0,
  );

  const activeStatus = copy
    ? copy.orders.length > 0
      ? "ready"
      : "empty"
    : !online || readOnly
      ? "offline"
      : orders.refreshFailed
        ? "error"
        : "loading";

  return (
    <Screen
      title={t("tabs.orders")}
      root={!readOnly}
      {...(readOnly ? { back: { label: t("common.back"), onPress: readOnly.exit } } : {})}
      banner={banner}
      refreshing={refreshing}
      refreshingLabel={t("common.loading")}
      {...(!readOnly && online
        ? { onPullToRefresh: () => (tab === "active" ? void orders.refresh() : history.reload()) }
        : {})}
    >
      <View style={styles.content}>
        {!readOnly && (
          <Segments<Tab>
            label={t("tabs.orders")}
            value={tab}
            onChange={(next) => {
              if (next === "history" && tab !== "history") reloadHistory();
              setTab(next);
            }}
            options={[
              { value: "active", label: t("orders.active") },
              { value: "history", label: t("orders.history") },
            ]}
          />
        )}

        {tab === "active" ? (
          <DataState
            status={activeStatus}
            skeleton={<SkeletonList rows={3} label={t("common.loading")} />}
            error={{
              title: t("state.errorTitle"),
              text: t("state.errorText"),
              retry: { label: t("common.retry"), onRetry: orders.refresh },
            }}
            offline={{ title: t("orders.offlineNoCopy") }}
            empty={{
              icon: "receipt",
              title: t("orders.activeEmptyTitle"),
              ...(readOnly
                ? {}
                : {
                    action: (
                      <Button
                        variant="secondary"
                        onPress={() => root()?.navigate("tabs", { screen: "catalog" })}
                      >
                        {t("orders.toCatalog")}
                      </Button>
                    ),
                  }),
            }}
          >
            {copy && (
              <View style={styles.list}>
                {copy.truncated && (
                  <Banner tone="neutral">
                    {t("orders.truncated", { shown: copy.orders.length, total: copy.total })}
                  </Banner>
                )}
                {orderActiveOrders(copy.orders).map((order) => {
                  const main = mainDateText(
                    order.mainDate,
                    order.pickupPoint?.timeZone ?? order.serviceVisit?.timeZone ?? CLUB_TIME_ZONE,
                    now,
                    (month) => t(`month.${month}` as MobileTextKey),
                    (date, time) => t("order.visitAt", { date, time }),
                  );
                  return (
                    <OrderRow
                      key={order.id}
                      order={order}
                      needsAnswer={order.needsAnswer}
                      dateLine={main ? t(main.key, { time: main.time }) : null}
                      onPress={() => openOrder(order.id)}
                    />
                  );
                })}
              </View>
            )}
          </DataState>
        ) : !online ? (
          <OfflineContent title={t("orders.historyOffline")} />
        ) : (
          <DataState
            status={
              history.status === "error"
                ? "error"
                : history.status === "ready"
                  ? history.history.total === 0
                    ? "empty"
                    : "ready"
                  : "loading"
            }
            skeleton={<SkeletonList rows={3} label={t("common.loading")} />}
            error={{
              title: t("state.errorTitle"),
              text: t("state.errorText"),
              retry: { label: t("common.retry"), onRetry: history.reload },
            }}
            empty={{ icon: "archive", title: t("orders.historyEmptyTitle") }}
          >
            <View style={styles.list}>
              {history.history.months.map((month) => {
                const parts = monthOf(month.month);
                return (
                  <View key={month.month} style={styles.list}>
                    <Text variant="heading" accessibilityRole="header">
                      {parts
                        ? `${t(`monthName.${parts.month}` as MobileTextKey)} ${parts.year}`
                        : month.month}
                    </Text>
                    {month.orders.map((order) => {
                      const finished = time.dateAndTime(order.finishedAt, CLUB_TIME_ZONE);
                      return (
                        <OrderRow
                          key={order.id}
                          order={order}
                          dateLine={finished.date}
                          onPress={() => openOrder(order.id)}
                          footer={
                            order.canRepeat ? (
                              <View style={styles.repeat}>
                                <Button
                                  variant="text"
                                  size="m"
                                  icon="refresh"
                                  loading={repeat.pending === order.id}
                                  onPress={() => repeat.repeat(order.id)}
                                >
                                  {t("orders.repeat")}
                                </Button>
                              </View>
                            ) : null
                          }
                        />
                      );
                    })}
                  </View>
                );
              })}
              {history.history.nextCursor && (
                <Button
                  variant="secondary"
                  loading={history.loadingMore}
                  onPress={history.loadMore}
                >
                  {t("catalog.loadMore")}
                </Button>
              )}
            </View>
          </DataState>
        )}
      </View>
      {repeat.sheet}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 12 },
  list: { gap: 12 },
  repeat: { paddingHorizontal: 8, paddingBottom: 8, alignItems: "flex-start" },
});

import { isApiError } from "@adclub/api-client";
import type { UserOrderStep } from "@adclub/contracts";
import type { MobileTextKey } from "@adclub/i18n";
import { formatOrderCode, layout, radius } from "@adclub/ui-core";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  ButtonRow,
  CodeBlock,
  DataState,
  Dialog,
  hairline,
  ListGroup,
  ListRow,
  OfflineBanner,
  Screen,
  Section,
  SkeletonList,
  StatusBadge,
  Text,
  useTheme,
  useToast,
} from "../../design-system";
import { formatTenge, parseDate } from "../../catalog/format";
import type { RootParams } from "../../navigation/routes";
import { useLeaveWhenSignedOut } from "../../navigation/use-leave-when-signed-out";
import { rememberOpenedOrder } from "../../orders/opened-orders";
import { copyIsBehind } from "../../orders/order-copy";
import { isActiveStatus, orderMarkKey, orderStatusView } from "../../orders/order-status";
import { orderViewOfCopy, orderViewOfServer, type OrderView } from "../../orders/order-view";
import { callUrl, navigatorLinks, weeklyHoursLines } from "../../orders/pickup-place";
import { apiClient } from "../../services/api";
import { useOnline } from "../../services/use-network";
import { useRequest } from "../../services/use-request";
import { useLanguage } from "../../state/language";
import { useOrdersCopy, useOrdersReadOnly } from "../../state/orders-provider";
import { ItemPhoto } from "../catalog/parts";
import { NavigatorSheet } from "./NavigatorSheet";
import { useNow, useOrderTime } from "./parts";
import { useRepeatOrder } from "./use-repeat-order";

type Props = NativeStackScreenProps<RootParams, "order">;

const DAY_KEYS = ["", "day.1", "day.2", "day.3", "day.4", "day.5", "day.6", "day.7"] as const;

/**
 * M-ORD-03 — one order (TASK-030 requirement 3). With a network it is the
 * order as the server has it now (`GET /orders/{id}`), on opening, back
 * from the background and on a pull; without one — its entry in the saved
 * copy, with T-ORD-07 «Обновлено в {время}. Статус мог измениться» and the
 * actions that need the server switched off («Нужна сеть», SCREENS 2.4). An
 * order the server has moved meanwhile is shown as it is now, not as an
 * error (SCREENS 2.3).
 */
export function OrderScreen({ route, navigation }: Props) {
  const { orderId } = route.params;
  const { t, lang } = useLanguage();
  const { theme } = useTheme();
  const toast = useToast();
  const online = useOnline();
  const now = useNow();
  const time = useOrderTime();
  const readOnly = useOrdersReadOnly();
  const orders = useOrdersCopy();
  const repeat = useRepeatOrder();
  useLeaveWhenSignedOut(navigation);

  const request = useRequest(
    readOnly ? null : `order:${orderId}:${lang}`,
    (signal) => apiClient.getUserOrder({ orderId }, { signal }),
    { staleAfterMs: 0 },
  );
  useFocusEffect(
    useCallback(() => {
      request.reloadIfStale();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const copyEntry = orders.copy?.orders.find((entry) => entry.id === orderId) ?? null;
  const server = request.data ? orderViewOfServer(request.data.order) : null;
  // Without a network (or in the read-only mode) the copy speaks — it knows
  // when it was true; otherwise the server, and the copy only while the
  // server has not answered.
  const fromCopy = (readOnly || !online || !server) && copyEntry !== null;
  const order: OrderView | null = fromCopy ? orderViewOfCopy(copyEntry) : server;

  useEffect(() => {
    if (order) rememberOpenedOrder(order);
  }, [order]);

  // The order just loaded says the copy is behind (accepted a moment ago,
  // finished): the copy is asked for again, so the list and the QR without
  // a network show what is true.
  const serverOrder = request.data?.order;
  useEffect(() => {
    if (
      serverOrder &&
      copyIsBehind(orders.copy, {
        id: serverOrder.id,
        updatedAt: serverOrder.updatedAt,
        active: isActiveStatus(serverOrder.status),
      })
    ) {
      void orders.refresh();
    }
    // Only a new answer of the server is a reason to ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverOrder]);

  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const cancel = async () => {
    setConfirmCancel(false);
    setCancelling(true);
    try {
      await apiClient.cancelUserOrder({ orderId });
      toast.show(t("order.cancelled"));
    } catch (error) {
      // The order moved first (given out, declined, expired): its real state
      // is loaded and said in words — a repeat of one's own cancel is no error.
      if (isApiError(error) && error.code === "ORDER_STATE_CONFLICT") {
        const status = (error.details as { currentStatus?: string } | undefined)?.currentStatus;
        toast.show(status === "completed" ? t("order.cancelTooLate") : t("order.cancelChanged"));
      } else {
        toast.show(t("order.cancelFailed"));
      }
    } finally {
      setCancelling(false);
      request.reload();
      void orders.refresh();
    }
  };

  const view = order ? orderStatusView(order) : null;
  const timeZone = order?.pickupPoint?.timeZone ?? null;
  const offlineNote =
    fromCopy && orders.copy
      ? time.updated(orders.copy.serverTime, now, {
          time: "order.offlineNote",
          date: "order.offlineNoteDate",
        })
      : null;

  const status =
    order !== null
      ? "ready"
      : readOnly || !online
        ? "offline"
        : request.status === "error"
          ? "error"
          : "loading";

  const serverActions = !readOnly;
  const actionsLive = online && !fromCopy;

  return (
    <Screen
      title={order ? t("order.title", { number: order.number }) : t("order.titleShort")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
      banner={
        readOnly ? (
          <Banner tone="warning" icon="refresh" placement="flush">
            {t("orders.readOnlyBanner")}
          </Banner>
        ) : !online ? (
          <OfflineBanner label={t("state.offline")} />
        ) : null
      }
      refreshing={request.refreshing}
      refreshingLabel={t("common.loading")}
      {...(!readOnly && online ? { onPullToRefresh: request.reload } : {})}
      bottomInset
    >
      <DataState
        status={status}
        skeleton={<SkeletonList rows={3} label={t("common.loading")} />}
        error={
          request.failure === "not_found"
            ? { title: t("order.notFound"), text: t("order.notFoundText") }
            : {
                title: t("state.errorTitle"),
                text: t("state.errorText"),
                retry: { label: t("common.retry"), onRetry: request.reload },
              }
        }
        offline={{ title: t("state.offline"), text: t("order.notInCopy") }}
        empty={{ icon: "receipt", title: t("order.notFound") }}
      >
        {order && view && (
          <View style={styles.body}>
            {offlineNote && (
              <Text variant="bodyS" color="textMuted">
                {offlineNote}
              </Text>
            )}

            {/* 1. The status: heading, explanation, deadline. */}
            <View style={styles.block}>
              <StatusBadge group={view.group}>{t(orderMarkKey(order))}</StatusBadge>
              <Text variant="title" accessibilityRole="header">
                {view.title === "orderStatus.completed.title" && order.givenOut
                  ? t(view.title, time.dateAndTime(order.givenOut.at, timeZone))
                  : view.title === "orderStatus.completed.title"
                    ? t("orderStatus.completed.short")
                    : t(view.title)}
              </Text>
              {view.text && (
                <Text color="textMuted">
                  {t(view.text, {
                    time:
                      view.deadline === "respondBy"
                        ? time.deadline(order.respondBy, timeZone, now)
                        : view.deadline === "reserveUntil" && order.reserveUntil
                          ? time.deadline(order.reserveUntil, timeZone, now)
                          : "",
                  })}
                </Text>
              )}
              {order.status === "accepted" && order.reserveUntil && (
                <Text variant="bodyS">
                  {t("orders.mainDate.reserveUntil", {
                    time: time.deadline(order.reserveUntil, timeZone, now),
                  })}
                </Text>
              )}
            </View>

            {/* 2. The code and the QR — while the order is active, for its user only. */}
            {view.code !== "none" && order.confirmation && (
              <View style={styles.block}>
                <Pressable
                  disabled={view.code === "dimmed"}
                  accessibilityRole={view.code === "dimmed" ? undefined : "button"}
                  accessibilityHint={t("order.openQr")}
                  onPress={() => navigation.push("order-qr", { orderId: order.id })}
                >
                  <CodeBlock
                    code={order.confirmation.code}
                    qrValue={order.confirmation.qrPayload}
                    codeLabel={t("order.codeLabel")}
                    qrLabel={t("order.qrLabel", { code: formatOrderCode(order.confirmation.code) })}
                    ready={view.code === "large"}
                    {...(view.code === "dimmed" ? { pending: { text: t("order.codeLater") } } : {})}
                  />
                </Pressable>
                {view.code !== "dimmed" && (
                  <Text variant="bodyS" color="textMuted" style={styles.center}>
                    {t("order.showCode")}
                  </Text>
                )}
              </View>
            )}

            {/* 3. The supplier and the place — exactly as the server gave them:
                «Где забрать» for a pickup, «Поставщик» for a delivery (TASK-030.A). */}
            {view.place !== "none" && (
              <Section
                title={t(
                  order.fulfillment === "pickup" ? "order.placePickup" : "order.placeDelivery",
                )}
              >
                <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
                  <Text variant="bodyStrong">{order.supplier.name}</Text>
                  {view.place === "full" && order.pickupPoint ? (
                    <PickupPlace order={order} />
                  ) : (
                    <Text variant="bodyS" color="textMuted">
                      {[order.supplier.district, order.supplier.cityName]
                        .filter(Boolean)
                        .join(", ")}
                    </Text>
                  )}
                </View>
              </Section>
            )}

            {/* 4. The item. */}
            <Section title={t("order.item")}>
              <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
                <View style={styles.itemRow}>
                  <ItemPhoto photo={order.item.photo} icon={null} />
                  <View style={styles.grow}>
                    <Text variant="bodyStrong">{order.item.name.text}</Text>
                    {(order.item.brand || order.item.article) && (
                      <Text variant="bodyS" color="textMuted">
                        {[order.item.brand, order.item.article].filter(Boolean).join(" · ")}
                      </Text>
                    )}
                  </View>
                </View>
                <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
                <Term label={t("order.quantityLabel")}>
                  {t("orders.quantityShort", { n: order.quantity })}
                </Term>
                <Term label={t("order.priceLabel")}>{formatTenge(order.unitPrice)}</Term>
                <Term label={t("order.fulfillmentLabel")}>
                  {order.fulfillment === "pickup" ? t("catalog.pickup") : t("catalog.delivery")}
                </Term>
                <Term label={t("order.totalLabel")} strong>
                  {formatTenge(order.total)}
                </Term>
              </View>
            </Section>

            {/* 5. The course of the order — moves and times, never an employee's name. */}
            {order.history && order.history.length > 0 && (
              <Section title={t("order.history")}>
                <ListGroup>
                  {order.history.map((step, index) => (
                    <ListRow
                      key={`${step.at}-${index}`}
                      first={index === 0}
                      title={<Text variant="body">{t(stepKey(step, order.fulfillment))}</Text>}
                      trailing={
                        <Text variant="caption" color="textMuted">
                          {(() => {
                            const parts = time.dateAndTime(step.at, timeZone);
                            return `${parts.date}, ${parts.time}`;
                          })()}
                        </Text>
                      }
                    />
                  ))}
                </ListGroup>
              </Section>
            )}

            {/* 6. The actions. «Оценить» and «Пожаловаться» are stage C and are not drawn. */}
            {serverActions && (
              <View style={styles.actions}>
                {view.cancellable && (
                  <Button
                    variant="secondary"
                    destructive
                    disabled={!actionsLive}
                    loading={cancelling}
                    onPress={() => setConfirmCancel(true)}
                  >
                    {t("order.cancel")}
                  </Button>
                )}
                {view.finished && (
                  <Button
                    variant="secondary"
                    icon="refresh"
                    disabled={!actionsLive}
                    loading={repeat.pending === order.id}
                    onPress={() => repeat.repeat(order.id)}
                  >
                    {t("order.repeat")}
                  </Button>
                )}
                {!actionsLive && (view.cancellable || view.finished) && (
                  <Text variant="caption" color="textMuted" style={styles.center}>
                    {t("order.needsNetwork")}
                  </Text>
                )}
              </View>
            )}
          </View>
        )}
      </DataState>

      <Dialog
        visible={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title={t("order.cancelConfirmTitle")}
        actions={
          <>
            <Button variant="danger" onPress={cancel}>
              {t("order.cancel")}
            </Button>
            <Button variant="text" onPress={() => setConfirmCancel(false)}>
              {t("order.cancelKeep")}
            </Button>
          </>
        }
      >
        <Text>{t("order.cancelConfirmText")}</Text>
      </Dialog>
      {repeat.sheet}
    </Screen>
  );
}

/**
 * The place after acceptance: address, hours, closed dates, and «Маршрут» |
 * «Позвонить» — two equal buttons across the width, or the one there is
 * (TASK-030.A). «Маршрут» lets the person choose the navigation app.
 */
function PickupPlace({ order }: { order: OrderView }) {
  const { t } = useLanguage();
  const [navigators, setNavigators] = useState(false);
  const point = order.pickupPoint!;
  const canRoute = navigatorLinks(point, "android").length > 0;
  const call = callUrl(point.phone);
  const lines = weeklyHoursLines(point.weeklyHours);
  return (
    <View style={styles.place}>
      {point.address && (
        <Text>{[point.address, point.district, point.cityName].filter(Boolean).join(", ")}</Text>
      )}
      {lines.length > 0 && (
        <View>
          <Text variant="caption" color="textMuted">
            {t("order.hours")}
          </Text>
          {lines.map((line) => (
            <Text key={line.fromDay} variant="bodyS">
              {`${line.fromDay === line.toDay ? t(DAY_KEYS[line.fromDay] as MobileTextKey) : `${t(DAY_KEYS[line.fromDay] as MobileTextKey)}–${t(DAY_KEYS[line.toDay] as MobileTextKey)}`} ${
                line.hours === null
                  ? t("order.dayOff")
                  : line.hours === "allDay"
                    ? t("order.allDay")
                    : line.hours
              }`}
            </Text>
          ))}
        </View>
      )}
      {point.closedDates.length > 0 && (
        <View>
          <Text variant="caption" color="textMuted">
            {t("order.closedDates")}
          </Text>
          {point.closedDates.slice(0, 5).map((closed) => {
            const parts = parseDate(closed.date);
            return (
              <Text key={closed.date} variant="bodyS">
                {parts ? `${parts.day} ${t(`month.${parts.month}` as MobileTextKey)}` : closed.date}
                {closed.note ? ` · ${closed.note}` : ""}
              </Text>
            );
          })}
        </View>
      )}
      {point.phone && <Text variant="bodyS">{point.phone}</Text>}
      {(canRoute || call) && (
        <ButtonRow>
          {canRoute && (
            <Button variant="secondary" size="m" icon="route" onPress={() => setNavigators(true)}>
              {t("order.route")}
            </Button>
          )}
          {call && (
            <Button
              variant="secondary"
              size="m"
              icon="phone"
              onPress={() => void Linking.openURL(call)}
            >
              {t("order.call")}
            </Button>
          )}
        </ButtonRow>
      )}
      <NavigatorSheet visible={navigators} onClose={() => setNavigators(false)} place={point} />
    </View>
  );
}

/** A term of the order: the label on the left, the value on the right. */
function Term({
  label,
  strong = false,
  children,
}: {
  label: string;
  strong?: boolean;
  children: string;
}) {
  return (
    <View style={styles.term}>
      <Text variant={strong ? "bodyStrong" : "bodyS"} color={strong ? "text" : "textMuted"}>
        {label}
      </Text>
      <Text variant={strong ? "priceS" : "bodyS"} style={styles.termValue}>
        {children}
      </Text>
    </View>
  );
}

/** A step of «Ход заявки» by the status it led to. */
function stepKey(step: UserOrderStep, fulfillment: OrderView["fulfillment"]): MobileTextKey {
  switch (step.status) {
    case "created":
      return "order.step.created";
    case "accepted":
      return "orderStatus.accepted.title";
    case "ready":
      return fulfillment === "pickup"
        ? "orderStatus.readyPickup.title"
        : "orderStatus.readyDelivery.title";
    case "completed":
      return "orderStatus.completed.short";
    case "cancelled_by_user":
      return "orderStatus.cancelled.title";
    case "declined_by_supplier":
      return "orderStatus.declined.title";
    case "response_expired":
      return "orderStatus.responseExpired.title";
    case "reserve_expired":
      return "orderStatus.reserveExpired.title";
    default:
      return "order.step.changed";
  }
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 12 },
  block: { gap: 8 },
  center: { textAlign: "center" },
  // `surface` sets the card apart from the page: no frame (DESIGN.md 7.6, D-068).
  card: { borderRadius: radius.m, padding: layout.cardPadding, gap: 6 },
  place: { gap: 8 },
  itemRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  grow: { flex: 1, gap: 2 },
  divider: { height: hairline, marginVertical: 6 },
  term: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
  termValue: { flexShrink: 1, textAlign: "right" },
  actions: { gap: 8, paddingTop: 12 },
});

import { isApiError } from "@adclub/api-client";
import { formatKzPhone } from "@adclub/domain";
import type { MobileTextKey } from "@adclub/i18n";
import { formatOrderCode, layout, radius, size } from "@adclub/ui-core";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { Linking, Platform, Pressable, StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  ButtonRow,
  CodeBlock,
  DataState,
  Dialog,
  hairline,
  Icon,
  IconLine,
  ListGroup,
  ListRow,
  OfflineBanner,
  Screen,
  ScreenBody,
  Section,
  SkeletonList,
  StarsInput,
  StatusBadge,
  Text,
  useTheme,
  useToast,
  ValueRow,
} from "../../design-system";
import { formatTenge, joinDot, parseDate } from "../../catalog/format";
import { runEnvironment } from "../../config/environment";
import type { RootParams } from "../../navigation/routes";
import { useLeaveWhenSignedOut } from "../../navigation/use-leave-when-signed-out";
import { rememberOpenedOrder } from "../../orders/opened-orders";
import {
  supplyOverdue,
  termAnswer,
  timeAnswer,
  termAnswerProblem,
  termAnswerProblemKeys,
} from "../../orders/order-answer";
import { copyIsBehind } from "../../orders/order-copy";
import {
  complaintReasonKeys,
  orderFeedback,
  rejectReasonKeys,
  reviewFailure,
  reviewFailureKeys,
} from "../../orders/order-feedback";
import {
  isActiveStatus,
  orderMarkKey,
  orderStatusView,
  orderStepKey,
} from "../../orders/order-status";
import { orderViewOfCopy, orderViewOfServer, type OrderView } from "../../orders/order-view";
import {
  callOptions,
  callUrl,
  detectWhatsapp,
  openCallOption,
  type CallOption,
} from "../../orders/call-options";
import { navigatorLinks, weeklyHoursLines } from "../../orders/pickup-place";
import { apiClient } from "../../services/api";
import { orderAnswers, orderRequestKey } from "../../services/order-answers";
import { useOnline } from "../../services/use-network";
import { useRequest } from "../../services/use-request";
import { useLanguage } from "../../state/language";
import { useOrdersCopy, useOrdersReadOnly } from "../../state/orders-provider";
import { ItemPhoto } from "../catalog/parts";
import { CallSheet } from "./CallSheet";
import { NavigatorSheet } from "./NavigatorSheet";
import { carText, useNow, useOrderTime } from "./parts";
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
 *
 * TASK-078: the blocks of SCREENS M-ORD-03 are sections 32 apart; the code
 * block carries T-ORD-05 inside it and, before acceptance, a muted square
 * with a lock; the details of the item are value rows and «Итого» appears
 * only when there is more than one; the phone of the point is said under
 * «Позвонить», written out; the actions — one main button, the finished
 * order's «Повторить заказ», pinned at the bottom, the rest in the body:
 * «Отменить заявку» a secondary button with the danger text, «Пожаловаться»
 * a text button; the place of a finished order is only the supplier's name.
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
    readOnly ? null : orderRequestKey(orderId, lang),
    (signal) => apiClient.getUserOrder({ orderId }, { signal }),
    // The answers are kept for «Оценить» and «Пожаловаться» opened from here (TASK-049.B).
    { staleAfterMs: 0, cache: orderAnswers },
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
  const [confirmReject, setConfirmReject] = useState(false);
  const [answering, setAnswering] = useState<"agree" | "reject" | null>(null);
  const [confirmScoreOnly, setConfirmScoreOnly] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // TASK-049.B: the review and the complaint — from the server's order; an
  // order shown from the copy keeps those of the last answer, if there was one.
  const feedback = orderFeedback(order?.feedback ?? server?.feedback ?? null);

  // «Опубликовать только оценку» after «Текст не будет опубликован».
  const publishScoreOnly = async () => {
    setConfirmScoreOnly(false);
    const reviewId = request.data?.order.review?.id;
    if (!reviewId) return;
    setPublishing(true);
    try {
      await apiClient.publishReviewScoreOnly({ reviewId });
      toast.show(t("review.published"));
    } catch (error) {
      const problem = reviewFailure(error);
      if (problem.kind !== "session_ended") {
        toast.show(
          t(
            reviewFailureKeys[problem.kind],
            problem.kind === "rate_limited" ? { minutes: problem.minutes } : {},
          ),
        );
      }
    } finally {
      setPublishing(false);
      request.reload();
    }
  };

  // M-ORD-03 «Ответ пользователя» (TASK-039): «Согласиться» at once,
  // «Отказаться» after «Заявка будет отменена». The server decides — the
  // version is the one the user saw, and a refusal (the deadline passed,
  // the supplier declined first) is said in words over the order as it is now.
  const answerTerm = async (how: "agree" | "reject") => {
    const version = request.data?.order.version;
    setConfirmReject(false);
    if (version === undefined) return;
    setAnswering(how);
    try {
      if (how === "agree") {
        await apiClient.agreeUserOrderTerm({ orderId }, { expectedVersion: version });
      } else {
        await apiClient.rejectUserOrderTerm({ orderId }, { expectedVersion: version });
      }
      toast.show(
        t(
          how === "reject"
            ? "order.answer.rejected"
            : order?.kind === "service"
              ? "order.answer.timeAgreed"
              : "order.answer.agreed",
        ),
      );
    } catch (error) {
      const problem = termAnswerProblem(error);
      // A session that ended has taken the user out already.
      if (problem !== "session_ended") toast.show(t(termAnswerProblemKeys[problem]));
    } finally {
      setAnswering(null);
      request.reload();
      void orders.refresh();
    }
  };

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
  const answer = order ? termAnswer(order) : null;
  // TASK-039.B: the same answer to another time of a visit for a service.
  const visitAnswer = order ? timeAnswer(order) : null;
  const waitsForAnswer = answer !== null || visitAnswer !== null;
  // A visit for a service is not repeated yet (the server answers
  // `kind_not_supported`, ARCHITECTURE 4.63): no button that only refuses.
  const repeatable = view !== null && view.finished && order?.kind !== "service";
  // A visit for a service knows its point's zone from the first moment (TASK-038).
  const timeZone = order?.pickupPoint?.timeZone ?? order?.serviceVisit?.timeZone ?? null;
  const offlineNote =
    fromCopy && orders.copy
      ? time.updated(orders.copy.serverTime, now, {
          time: "order.offlineNote",
          date: "order.offlineNoteDate",
        })
      : null;

  // The time of a visit the status speaks of — asked for, proposed or
  // confirmed — «12 октября в 15:00» (TASK-038, TASK-039.B).
  const visitAt = (() => {
    const visit = order?.serviceVisit;
    switch (view?.visit) {
      case "desired":
        return visit?.desiredAt ?? null;
      case "proposed":
        return visit?.proposed?.visitAt ?? null;
      case "confirmed":
        return visit?.confirmed?.visitAt ?? null;
      default:
        return null;
    }
  })();
  const visitLine = visitAt ? time.visit(visitAt, timeZone) : "";

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
  const finished = view?.finished ?? false;
  // «Посмотрите другие предложения» of a declined or expired order: the card of the item.
  const otherOffers =
    order &&
    (order.status === "declined_by_supplier" ||
      order.status === "response_expired" ||
      order.status === "reserve_expired");
  const openItem = () => {
    if (!order) return;
    navigation.navigate("tabs", {
      screen: "catalog",
      params: {
        screen: "catalog-item",
        params: { itemId: order.item.id, title: order.item.name.text },
        initial: false,
      },
    });
  };

  const needsNetwork = (
    <Text variant="caption" color="textMuted">
      {t("order.needsNetwork")}
    </Text>
  );

  return (
    <Screen
      title={order ? t("order.title", { number: order.number }) : t("order.titleShort")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
      banner={
        readOnly ? (
          <Banner tone="warning" icon="refresh">
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
      // The one main button of a finished order, pinned: a toast stands above it (DESIGN 7.7).
      footer={
        serverActions && order && repeatable ? (
          <>
            <Button
              disabled={!actionsLive}
              loading={repeat.pending === order.id}
              onPress={() => repeat.repeat(order.id)}
            >
              {t("order.repeat")}
            </Button>
            {!actionsLive && needsNetwork}
          </>
        ) : null
      }
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
          <ScreenBody>
            {/* 1. The status: heading, explanation, deadline. */}
            <Section first>
              {offlineNote && (
                <Text variant="bodyS" color="textMuted">
                  {offlineNote}
                </Text>
              )}
              <View style={styles.status}>
                <StatusBadge group={view.group}>{t(orderMarkKey(order))}</StatusBadge>
                <Text variant="title" accessibilityRole="header">
                  {view.title === "orderStatus.completed.title" && order.givenOut
                    ? t(view.title, time.dateAndTime(order.givenOut.at, timeZone))
                    : view.title === "orderStatus.completed.title"
                      ? t("orderStatus.completed.short")
                      : // TASK-039.B: «Ждём вас {дата} в {время}» of a confirmed visit.
                        t(view.title, { visit: visitLine })}
                </Text>
                {/* TASK-037: the day the goods come, on a line of its own (TASK-078). */}
                {view.termDate === "confirmed" && order.onOrderTerm?.confirmed && (
                  <Text variant="bodyStrong">
                    {t("order.bringBy", {
                      date: time.calendarDate(order.onOrderTerm.confirmed.readyOn),
                    })}
                  </Text>
                )}
                {view.text && (
                  <Text color="textMuted">
                    {t(view.text, {
                      time:
                        view.deadline === "respondBy"
                          ? time.deadline(order.respondBy, timeZone, now)
                          : view.deadline === "reserveUntil" && order.reserveUntil
                            ? time.deadline(order.reserveUntil, timeZone, now)
                            : view.deadline === "answerBy" && order.onOrderTerm?.proposed
                              ? time.deadline(order.onOrderTerm.proposed.answerBy, timeZone, now)
                              : view.deadline === "answerBy" && order.serviceVisit?.proposed
                                ? time.deadline(order.serviceVisit.proposed.answerBy, timeZone, now)
                                : "",
                      // TASK-038: the time of a visit for a service.
                      visit: visitLine,
                      // TASK-037: the date of the term of an order under order.
                      date: time.calendarDate(
                        view.termDate === "proposed"
                          ? order.onOrderTerm?.proposed?.readyOn
                          : view.termDate === "confirmed"
                            ? order.onOrderTerm?.confirmed?.readyOn
                            : null,
                      ),
                    })}
                  </Text>
                )}
                {supplyOverdue(order) && (
                  <Text variant="bodyS" color="warning">
                    {t("order.supplyOverdue")}
                  </Text>
                )}
                {order.status === "accepted" && order.reserveUntil && (
                  <IconLine icon="clock" variant="bodyS" textColor="text">
                    {t("orders.mainDate.reserveUntil", {
                      time: time.deadline(order.reserveUntil, timeZone, now),
                    })}
                  </IconLine>
                )}
                {otherOffers && serverActions && (
                  <Button variant="text" size="m" disabled={!actionsLive} onPress={openItem}>
                    {t("order.otherOffers")}
                  </Button>
                )}
              </View>
            </Section>

            {/* The review and the complaint as the server says them (TASK-049.B, M-ORD-05, M-ORD-06). */}
            {feedback.review && (
              <Section title={t("review.blockTitle")}>
                <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
                  <StarsInput
                    value={feedback.review.score}
                    starLabel={(n) => t("review.scoreLabel", { n })}
                    small
                  />
                  {feedback.review.kind === "rejected" ? (
                    <Text color="warning">
                      {t("review.rejected", {
                        reason: feedback.review.reason
                          ? t(rejectReasonKeys[feedback.review.reason])
                          : "",
                      })}
                    </Text>
                  ) : (
                    <Text
                      variant="bodyStrong"
                      color={feedback.review.kind === "published" ? "success" : "textMuted"}
                    >
                      {t(
                        feedback.review.kind === "published"
                          ? "review.published"
                          : "review.checking",
                      )}
                    </Text>
                  )}
                  {feedback.review.text && (
                    <Text variant="bodyS" color="textMuted">
                      {feedback.review.text}
                    </Text>
                  )}
                  {serverActions &&
                    feedback.review.kind === "rejected" &&
                    (feedback.review.canEditText || feedback.review.canPublishScoreOnly) && (
                      <View style={styles.reviewActions}>
                        {feedback.review.canEditText && (
                          <Button
                            size="m"
                            variant="secondary"
                            disabled={!actionsLive || publishing}
                            onPress={() =>
                              navigation.push("order-review", { orderId: order.id, mode: "edit" })
                            }
                          >
                            {t("review.editText")}
                          </Button>
                        )}
                        {feedback.review.canPublishScoreOnly && (
                          <Button
                            size="m"
                            variant="secondary"
                            disabled={!actionsLive}
                            loading={publishing}
                            onPress={() => setConfirmScoreOnly(true)}
                          >
                            {t("review.scoreOnly")}
                          </Button>
                        )}
                        {!actionsLive && needsNetwork}
                      </View>
                    )}
                </View>
              </Section>
            )}
            {feedback.complaint && (
              <Section title={t("complaint.blockTitle")}>
                <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
                  <Text variant="bodyStrong">
                    {t(
                      feedback.complaint.status === "resolved"
                        ? "complaint.resolved"
                        : "complaint.inReview",
                    )}
                  </Text>
                  <Text variant="bodyS" color="textMuted">
                    {t("complaint.reasonLine", {
                      reason: t(complaintReasonKeys[feedback.complaint.reason]),
                    })}
                  </Text>
                </View>
              </Section>
            )}

            {/* 2. The user's answer to another term (TASK-039, SCREENS M-ORD-03 block 2). */}
            {waitsForAnswer && (
              <Section title={t("order.answer.title")}>
                <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
                  <Text>
                    {answer
                      ? t(answer.was ? "order.answer.text" : "order.answer.textNoWas", {
                          date: time.calendarDate(answer.readyOn),
                          was: time.calendarDate(answer.was),
                          time: time.deadline(answer.answerBy, timeZone, now),
                        })
                      : visitAnswer
                        ? // TASK-039.B: «Поставщик предлагает другое время: {дата} в {время} (было …)».
                          t("order.answer.timeText", {
                            visit: time.visit(visitAnswer.visitAt, timeZone),
                            was: time.visit(visitAnswer.was, timeZone),
                            time: time.deadline(visitAnswer.answerBy, timeZone, now),
                          })
                        : null}
                  </Text>
                  {serverActions && (
                    <>
                      <ButtonRow>
                        <Button
                          size="m"
                          disabled={!actionsLive || answering !== null}
                          loading={answering === "agree"}
                          onPress={() => void answerTerm("agree")}
                        >
                          {t("order.answer.agree")}
                        </Button>
                        <Button
                          size="m"
                          variant="secondary"
                          destructive
                          disabled={!actionsLive || answering !== null}
                          loading={answering === "reject"}
                          onPress={() => setConfirmReject(true)}
                        >
                          {t("order.answer.reject")}
                        </Button>
                      </ButtonRow>
                      {!actionsLive && needsNetwork}
                    </>
                  )}
                </View>
              </Section>
            )}

            {/* 3. The code and the QR — while the order is active, for its user only. */}
            {view.code !== "none" && order.confirmation && (
              <Section>
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
                    // A service's status already says «Покажите код на месте» (TASK-078).
                    {...(order.kind === "service" ? {} : { note: t("order.showCode") })}
                    {...(view.code === "dimmed" ? { pending: { text: t("order.codeLater") } } : {})}
                  />
                </Pressable>
              </Section>
            )}

            {/* 4. The supplier and the place — exactly as the server gave them:
                «Где забрать» for a pickup, «Поставщик» for a delivery (TASK-030.A);
                for a finished order only the supplier's name (TASK-078). */}
            {view.place !== "none" && (
              <Section
                title={t(
                  order.kind === "service"
                    ? "order.placeService"
                    : order.fulfillment === "pickup"
                      ? "order.placePickup"
                      : "order.placeDelivery",
                )}
              >
                <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
                  {serverActions ? (
                    // M-CAT-09 (TASK-050): the supplier's rating and reviews.
                    <Pressable
                      accessibilityRole="button"
                      accessibilityHint={t("item.openSupplier")}
                      onPress={() => navigation.push("supplier-page", { orderId: order.id })}
                      style={styles.supplierLink}
                    >
                      <Text variant="bodyStrong" style={styles.grow}>
                        {order.supplier.name}
                      </Text>
                      <Icon name="chevronRight" size={20} color="textMuted" />
                    </Pressable>
                  ) : (
                    <Text variant="bodyStrong">{order.supplier.name}</Text>
                  )}
                  {view.place === "full" && order.pickupPoint && !finished ? (
                    <PickupPlace order={order} />
                  ) : !finished ? (
                    <Text variant="bodyS" color="textMuted">
                      {[order.supplier.district, order.supplier.cityName]
                        .filter(Boolean)
                        .join(", ")}
                    </Text>
                  ) : null}
                </View>
              </Section>
            )}

            {/* 5. The item. */}
            <Section title={t("order.item")}>
              <ListGroup>
                <View style={styles.itemRow}>
                  <ItemPhoto photo={order.item.photo} icon={null} kind={order.item.type} />
                  <View style={styles.grow}>
                    <Text variant="bodyStrong">{order.item.name.text}</Text>
                    {(order.item.brand || order.item.article) && (
                      <Text variant="bodyS" color="textMuted">
                        {joinDot([order.item.brand, order.item.article])}
                      </Text>
                    )}
                  </View>
                </View>
                {order.serviceVisit ? (
                  <>
                    {/* TASK-038: the car and the time of a visit for a service. */}
                    <ValueRow label={t("order.carLabel")} value={carText(order.serviceVisit.car)} />
                    <ValueRow
                      label={t("order.visitLabel")}
                      value={time.visit(
                        order.serviceVisit.confirmed?.visitAt ?? order.serviceVisit.desiredAt,
                        timeZone,
                      )}
                    />
                    <ValueRow label={t("order.priceLabel")} value={formatTenge(order.unitPrice)} />
                  </>
                ) : (
                  <>
                    <ValueRow
                      label={t("order.quantityLabel")}
                      value={t("orders.quantityShort", { n: order.quantity })}
                    />
                    <ValueRow label={t("order.priceLabel")} value={formatTenge(order.unitPrice)} />
                    <ValueRow
                      label={t("order.fulfillmentLabel")}
                      value={
                        order.fulfillment === "pickup" ? t("catalog.pickup") : t("catalog.delivery")
                      }
                    />
                    {/* «Итого» says something only when there is more than one (TASK-078). */}
                    {order.quantity > 1 && (
                      <ValueRow
                        label={t("order.totalLabel")}
                        value={formatTenge(order.total)}
                        strong
                      />
                    )}
                  </>
                )}
              </ListGroup>
            </Section>

            {/* 6. The course of the order — moves and times, never an employee's name. */}
            {order.history && order.history.length > 0 && (
              <Section title={t("order.history")}>
                <ListGroup>
                  {order.history.map((step, index) => (
                    <ListRow
                      key={`${step.at}-${index}`}
                      first={index === 0}
                      title={<Text variant="body">{t(orderStepKey(step, order))}</Text>}
                      subtitle={
                        <Text variant="caption" color="textMuted">
                          {time.when(step.at, timeZone, now)}
                        </Text>
                      }
                    />
                  ))}
                </ListGroup>
              </Section>
            )}

            {/* 7. The actions: «Оценить поставщика», «Пожаловаться» and T-ORD-08 as
                the server allows them (TASK-049.B), then the rest. */}
            {serverActions && (
              <Section>
                <View style={styles.actions}>
                  {feedback.notReceived && (
                    <Pressable
                      accessibilityRole="button"
                      disabled={!actionsLive}
                      accessibilityState={{ disabled: !actionsLive }}
                      onPress={() =>
                        navigation.push("order-complaint", {
                          orderId: order.id,
                          reason: "not_received",
                        })
                      }
                      style={[styles.notReceived, { backgroundColor: theme.colors.surface }]}
                    >
                      <Icon
                        name="alertTriangle"
                        size={20}
                        color={actionsLive ? "warning" : "textDisabled"}
                      />
                      <Text
                        variant="bodyStrong"
                        color={actionsLive ? "text" : "textDisabled"}
                        style={styles.grow}
                      >
                        {t("complaint.notReceivedLine")}
                      </Text>
                      <Icon
                        name="chevronRight"
                        size={20}
                        color={actionsLive ? "textMuted" : "textDisabled"}
                      />
                    </Pressable>
                  )}
                  {feedback.rate && (
                    <Button
                      variant={repeatable ? "secondary" : "primary"}
                      disabled={!actionsLive}
                      onPress={() =>
                        navigation.push("order-review", { orderId: order.id, mode: "new" })
                      }
                    >
                      {t("review.rate")}
                    </Button>
                  )}
                  {feedback.testOrder && (
                    <Text variant="bodyS" color="textMuted">
                      {t("review.testOrder")}
                    </Text>
                  )}
                  {view.cancellable && !waitsForAnswer && (
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
                  {feedback.complain && (
                    <Button
                      variant="text"
                      size="m"
                      tone="neutral"
                      disabled={!actionsLive}
                      onPress={() => navigation.push("order-complaint", { orderId: order.id })}
                    >
                      {t("complaint.complain")}
                    </Button>
                  )}
                  {!actionsLive &&
                    ((view.cancellable && !waitsForAnswer) || feedback.rate || feedback.complain) &&
                    needsNetwork}
                </View>
              </Section>
            )}
          </ScreenBody>
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
      <Dialog
        visible={confirmReject}
        onClose={() => setConfirmReject(false)}
        title={t(
          order?.kind === "service" ? "order.answer.timeRejectTitle" : "order.answer.rejectTitle",
        )}
        actions={
          <>
            <Button variant="danger" onPress={() => void answerTerm("reject")}>
              {t("order.answer.reject")}
            </Button>
            <Button variant="text" onPress={() => setConfirmReject(false)}>
              {t("order.answer.rejectKeep")}
            </Button>
          </>
        }
      >
        <Text>{t("order.answer.rejectText")}</Text>
      </Dialog>
      <Dialog
        visible={confirmScoreOnly}
        onClose={() => setConfirmScoreOnly(false)}
        title={t("review.scoreOnlyTitle")}
        actions={
          <>
            <Button onPress={() => void publishScoreOnly()}>{t("review.scoreOnly")}</Button>
            <Button variant="text" onPress={() => setConfirmScoreOnly(false)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        <Text>{t("review.scoreOnlyText")}</Text>
      </Dialog>
      {repeat.sheet}
    </Screen>
  );
}

/**
 * The place after acceptance: address, hours, closed dates, and «Маршрут» |
 * «Позвонить» — two equal buttons across the width, or the one there is
 * (TASK-030.A), with the phone written out under them (M4). «Маршрут» lets
 * the person choose the navigation app.
 */
function PickupPlace({ order }: { order: OrderView }) {
  const { t } = useLanguage();
  const toast = useToast();
  const [navigators, setNavigators] = useState(false);
  const [callSheet, setCallSheet] = useState(false);
  const [callChoices, setCallChoices] = useState<readonly CallOption[]>([]);
  const point = order.pickupPoint!;
  const canRoute = navigatorLinks(point, "android").length > 0;
  const call = callUrl(point.phone);

  const openCall = async (option: CallOption) => {
    if (!(await openCallOption(option, (url) => Linking.openURL(url)))) {
      toast.show(t("order.openFailed"));
    }
  };
  // «Позвонить»: the sheet only when a WhatsApp is there to choose (asked
  // now — an app installed a minute ago counts), otherwise the call at once.
  const startCall = async () => {
    const presence = await detectWhatsapp(runEnvironment, Platform.OS, (url) =>
      Linking.canOpenURL(url),
    );
    const options = callOptions(point.phone, presence);
    if (options.length > 1) {
      setCallChoices(options);
      setCallSheet(true);
    } else if (options[0]) {
      await openCall(options[0]);
    }
  };
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
                {joinDot([
                  parts
                    ? `${parts.day} ${t(`month.${parts.month}` as MobileTextKey)}`
                    : closed.date,
                  closed.note,
                ])}
              </Text>
            );
          })}
        </View>
      )}
      {(canRoute || call) && (
        <ButtonRow>
          {canRoute && (
            <Button variant="secondary" size="m" icon="route" onPress={() => setNavigators(true)}>
              {t("order.route")}
            </Button>
          )}
          {call && (
            <Button variant="secondary" size="m" icon="phone" onPress={startCall}>
              {t("order.call")}
            </Button>
          )}
        </ButtonRow>
      )}
      {point.phone && (
        <IconLine icon="phone" variant="caption">
          {formatKzPhone(point.phone)}
        </IconLine>
      )}
      <NavigatorSheet visible={navigators} onClose={() => setNavigators(false)} place={point} />
      <CallSheet
        visible={callSheet}
        onClose={() => setCallSheet(false)}
        options={callChoices}
        onPick={(option) => void openCall(option)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  status: { gap: 8 },
  grow: { flex: 1 },
  // `surface` sets the card apart from the page: no frame (DESIGN.md 7.6, D-068).
  card: { borderRadius: radius.m, padding: layout.cardPadding, gap: 8 },
  supplierLink: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.touchTarget },
  place: { gap: 8 },
  itemRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    padding: layout.cardPadding,
    borderBottomWidth: hairline,
    borderBottomColor: "transparent",
  },
  reviewActions: { gap: 8, paddingTop: 4 },
  actions: { gap: 12 },
  notReceived: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: layout.cardPadding,
    borderRadius: radius.m,
  },
});

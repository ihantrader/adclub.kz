import type { CreateOrderBody, OrderFulfillment, ShowcaseOffer } from "@adclub/contracts";
import { layout, radius } from "@adclub/ui-core";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { randomUUID } from "expo-crypto";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import type { MobileTextKey } from "@adclub/i18n";
import {
  Banner,
  Button,
  Chip,
  DataState,
  Dialog,
  OfflineBanner,
  Quantity,
  Radio,
  Rating,
  Screen,
  Section,
  SkeletonList,
  Text,
  useTheme,
  useToast,
} from "../../design-system";
import { catalogEntry } from "../../catalog/catalog-gate";
import { formatTenge } from "../../catalog/format";
import { vehicleQuery } from "../../catalog/vehicle-query";
import { carTitle, type GarageCar } from "../../garage/garage";
import { useCarPicker } from "../../navigation/car-picker";
import type { RootParams } from "../../navigation/routes";
import { useLeaveWhenSignedOut } from "../../navigation/use-leave-when-signed-out";
import {
  canOrderOffer,
  checkoutFailure,
  checkoutKind,
  checkoutReserve,
  createAttemptKeys,
  fulfillmentOptions,
  settleFulfillment,
  settleQuantity,
  type CheckoutFailure,
} from "../../orders/checkout";
import { CLUB_TIME_ZONE, zonedParts } from "../../orders/order-time";
import {
  desiredAtOf,
  settleVisitChoice,
  visitChoiceDays,
  visitDayLabel,
  type VisitChoice,
} from "../../orders/visit-choice";
import { apiClient } from "../../services/api";
import { catalogRefresh } from "../../services/catalog-refresh";
import { useShowcaseItem } from "../../services/use-catalog";
import { useOnline } from "../../services/use-network";
import { useRequest } from "../../services/use-request";
import { CarSheet } from "../catalog/CarSheet";
import { garageErrorText } from "../garage/garage-errors";
import { cityIdOf } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useGarage } from "../../state/garage-provider";
import { useLanguage } from "../../state/language";
import { useOrdersCopy } from "../../state/orders-provider";
import { NoCarContent } from "../NoCarState";
import { CompatibilityLine, ItemPhoto, useReceiptText } from "../catalog/parts";
import { ClubAccessSheet } from "./ClubAccessSheet";

type Props = NativeStackScreenProps<RootParams, "order-checkout">;

/**
 * M-ORD-01 — the checkout of one offer (TASK-030 requirement 1). There is
 * no checkout without a car (D-062): the card it reads is always asked for
 * the main car of the garage, as the catalog does.
 */
export function CheckoutScreen(props: Props) {
  const { state } = useGarage();
  const carPicker = useCarPicker();
  const t = useLanguage().t;
  const entry = catalogEntry(state);
  useLeaveWhenSignedOut(props.navigation);
  if (entry.kind === "needs-car") {
    return (
      <Screen
        title={t("checkout.title")}
        back={{ label: t("common.back"), onPress: props.navigation.goBack }}
        centerContent
      >
        <NoCarContent onAdd={carPicker.add} />
      </Screen>
    );
  }
  return <Checkout {...props} car={entry.car} />;
}

type Notice =
  | { kind: "fulfillment_unavailable" }
  | { kind: "quantity_invalid" }
  | { kind: "time_refused" }
  | { kind: "car_invalid" }
  | { kind: "kind_not_supported" }
  | { kind: "rate_limited"; minutes: number }
  | { kind: "network" }
  | { kind: "other" };

type Asking =
  | { kind: "price_changed"; expectedPrice: number; currentPrice: number }
  | { kind: "duplicate_active"; existingOrderId: string }
  | { kind: "offer_unavailable" };

function Checkout({ route, navigation, car }: Props & { car: GarageCar }) {
  const { itemId, offerId, preset, previousPrice } = route.params;
  const { t, tn, lang } = useLanguage();
  const { theme } = useTheme();
  const online = useOnline();
  const { selection } = useCity();
  const orders = useOrdersCopy();
  const receiptText = useReceiptText();
  const cityId = cityIdOf(selection);
  const request = useShowcaseItem(itemId, {
    ...(cityId ? { cityId } : {}),
    vehicle: vehicleQuery(car),
    sort: "recommended",
  });
  const data = request.data;
  const offer: ShowcaseOffer | null = data?.offers.find((entry) => entry.id === offerId) ?? null;
  const maxQuantity = data?.ordering.maxQuantity ?? 1;

  const [quantityChoice, setQuantity] = useState(preset?.quantity ?? 1);
  const [fulfillmentChoice, setFulfillment] = useState<OrderFulfillment | null>(
    preset?.fulfillment ?? null,
  );
  // One set of keys per screen: the same attempt is the same order (`createAttemptKeys`).
  const [keys] = useState(() => createAttemptKeys(randomUUID));
  // «Оформить ещё одну» once said stays said for this attempt — a retry
  // after a lost answer must not ask about the duplicate again.
  const [anotherAllowed, setAnotherAllowed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [clubSheet, setClubSheet] = useState(false);
  const [sending, setSending] = useState(false);

  // TASK-039.B, a service (M-ORD-01 «Услуга»): the car is the one of the
  // header — the price of the card is for its model — changed from the
  // garage; the day and the time are chosen from what the server offers.
  const service = data?.item.type === "service";
  const garage = useGarage();
  const toast = useToast();
  const carPicker = useCarPicker();
  const [carSheet, setCarSheet] = useState(false);
  const [visitChoice, setVisitChoice] = useState<VisitChoice | null>(null);
  const visitOptions = useRequest(
    service ? `visit-options:${offerId}` : null,
    (signal) => apiClient.getOfferVisitOptions({ signal, query: { offerId } }),
    { staleAfterMs: 60_000 },
  );
  const visitZone = visitOptions.data?.timeZone ?? CLUB_TIME_ZONE;
  const visitDays = visitOptions.data ? visitChoiceDays(visitOptions.data) : [];
  const visit = settleVisitChoice(visitChoice, visitDays);
  const desiredAt = desiredAtOf(visit, visitZone);
  // Today at the point, for «Сегодня» / «Завтра» on the day chips.
  const now = zonedParts(new Date().toISOString(), visitZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  const today = now ? `${now.year}-${pad(now.month)}-${pad(now.day)}` : "";

  const chooseCar = async (carId: string) => {
    if (carId === car.id) return;
    try {
      await garage.makePrimary(carId);
    } catch (error) {
      toast.show(garageErrorText(error, t));
    }
  };

  const quantity = settleQuantity(quantityChoice, maxQuantity);
  const fulfillment = service
    ? "pickup"
    : offer
      ? settleFulfillment(fulfillmentChoice, offer)
      : null;

  // «Поставщик снял это предложение» → the card of the item, its offers
  // loaded afresh. From «Повторить заказ» the card was not under this
  // screen, so it is opened in the catalog, saying why.
  const leaveToCard = () => {
    catalogRefresh.mark(itemId);
    if (!preset) {
      navigation.goBack();
      return;
    }
    navigation.pop();
    navigation.navigate("tabs", {
      screen: "catalog",
      params: {
        screen: "catalog-item",
        params: { itemId, notice: "offer_withdrawn" },
        initial: false,
      },
    });
  };

  const submit = async (options: { expectedPrice?: number; allowAnother?: boolean } = {}) => {
    if (!offer || !fulfillment || sending) return;
    // An offer of a kind this version has no checkout for is not placed
    // blind — «Повторить» could open the checkout of one.
    if (!canOrderOffer(offer, data?.item.type)) {
      setNotice({ kind: "kind_not_supported" });
      return;
    }
    if (service && desiredAt === null) return;
    const allowAnotherActive = options.allowAnother ?? anotherAllowed;
    const body: CreateOrderBody =
      service && desiredAt !== null
        ? {
            offerId: offer.id,
            carId: car.id,
            desiredAt,
            expectedPrice: options.expectedPrice ?? offer.price,
            idempotencyKey: keys.keyFor({
              offerId: offer.id,
              quantity: 1,
              fulfillment: "pickup",
              carId: car.id,
              desiredAt,
            }),
            allowAnotherActive,
          }
        : {
            offerId: offer.id,
            quantity,
            fulfillment,
            expectedPrice: options.expectedPrice ?? offer.price,
            idempotencyKey: keys.keyFor({ offerId: offer.id, quantity, fulfillment }),
            allowAnotherActive,
          };
    setNotice(null);
    setSending(true);
    try {
      const { order } = await apiClient.createOrder(body);
      void orders.refresh();
      navigation.replace("order", { orderId: order.id });
    } catch (error) {
      react(checkoutFailure(error));
    } finally {
      setSending(false);
    }
  };

  const react = (failure: CheckoutFailure) => {
    switch (failure.kind) {
      case "price_changed":
        request.reload();
        setAsking(failure);
        return;
      case "duplicate_active":
        setAsking(failure);
        return;
      case "offer_unavailable":
        setAsking(failure);
        return;
      case "fulfillment_unavailable":
        // The card is loaded again, and the ways it has now are the choice.
        setFulfillment(null);
        request.reload();
        setNotice(failure);
        return;
      case "quantity_invalid":
        request.reload();
        setNotice(failure);
        return;
      case "time_refused":
        // The point closed that day, or the minute passed: the times are
        // asked for again and the time is chosen anew.
        setVisitChoice(visit ? { date: visit.date, time: null } : null);
        visitOptions.reload();
        setNotice(failure);
        return;
      case "car_invalid":
        setNotice(failure);
        return;
      case "registration_incomplete":
        navigation.push("auth-register");
        return;
      case "club_access_required":
        setClubSheet(true);
        return;
      case "session_ended":
        // The app is a guest already (`createSessionAwareFetch`); the screen goes with the session.
        return;
      default:
        setNotice(failure);
    }
  };

  const status =
    !online && data === null
      ? "offline"
      : request.status === "loading"
        ? "loading"
        : request.status === "error"
          ? "error"
          : data && !offer
            ? service && (visitOptions.status === "loading" || visitOptions.status === "idle")
              ? "loading"
              : "empty"
            : "ready";

  const receipt = offer && !service ? receiptText(offer.receipt, "withDate") : null;
  // TASK-039: «Под заказ» — the date the supplier brings it by, the
  // agreement to the term (T-ORD-02, T-ORD-03) and its own reserve.
  const kind = offer ? checkoutKind(offer, data?.item.type) : "stock";
  const onOrder = kind === "on_order";
  const reserve = data ? checkoutReserve(kind, data.ordering) : null;
  const options = offer ? fulfillmentOptions(offer) : [];
  const priceWas = previousPrice !== undefined && offer && previousPrice !== offer.price;
  // A service whose offer the card no longer has: the offer is there (the
  // server gave its times) but has no price for this car's model — another
  // car may have one; otherwise the supplier took it off.
  const noPriceForCar = service && !offer && visitOptions.status === "ready";
  const visitDay = visit ? visitDays.find((day) => day.date === visit.date) : undefined;

  const dayLabel = (date: string) => {
    const label = visitDayLabel(date, today);
    if (label.kind === "today") return t("catalog.today");
    if (label.kind === "tomorrow") return t("catalog.tomorrow");
    return t("checkout.visitDay", {
      weekday: t(`day.${label.weekday}` as MobileTextKey),
      date: `${label.day} ${t(`month.${label.month}` as MobileTextKey)}`,
    });
  };

  return (
    <Screen
      title={t(service ? "checkout.serviceTitle" : "checkout.title")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      refreshing={request.refreshing}
      refreshingLabel={t("common.loading")}
      bottomInset
      footer={
        offer && fulfillment && (!service || visitDays.length > 0) ? (
          <>
            {!online ? (
              <Text variant="caption" color="textMuted" style={styles.center}>
                {t("order.needsNetwork")}
              </Text>
            ) : service && desiredAt === null ? (
              <Text variant="caption" color="textMuted" style={styles.center}>
                {t("checkout.chooseTime")}
              </Text>
            ) : null}
            <Button
              onPress={() => submit()}
              loading={sending}
              disabled={!online || (service && desiredAt === null)}
            >
              {t(service ? "checkout.book" : "checkout.submit")}
            </Button>
          </>
        ) : null
      }
    >
      <DataState
        status={status}
        skeleton={<SkeletonList rows={3} label={t("common.loading")} />}
        error={{
          title: t("state.errorTitle"),
          text: t("state.errorText"),
          retry: { label: t("common.retry"), onRetry: request.reload },
        }}
        offline={{ title: t("state.offline"), text: t("state.offlineText") }}
        empty={
          noPriceForCar
            ? {
                icon: "car",
                title: t("checkout.noPriceForCar", { model: carTitle(car) }),
                action: (
                  <Button variant="secondary" onPress={() => setCarSheet(true)}>
                    {t("checkout.chooseCar")}
                  </Button>
                ),
              }
            : {
                icon: "package",
                title: t("checkout.offerGone"),
                action: (
                  <Button variant="secondary" onPress={leaveToCard}>
                    {t("common.back")}
                  </Button>
                ),
              }
        }
      >
        {data && offer && (
          <View style={styles.body}>
            <View style={styles.itemRow}>
              <ItemPhoto photo={data.item.photos[0] ?? null} icon={null} />
              <View style={styles.grow}>
                <Text variant="bodyStrong">{data.item.name.text}</Text>
                {(data.item.brand || data.item.article) && (
                  <Text variant="bodyS" color="textMuted">
                    {[data.item.brand?.name, data.item.article].filter(Boolean).join(" · ")}
                  </Text>
                )}
              </View>
            </View>
            {/* The mark is the server's (D-029), the same line as on the card. */}
            {!service && data.compatibility.mark !== "fits" && (
              <CompatibilityLine
                result={data.compatibility}
                carName={carTitle(car)}
                variant="card"
              />
            )}

            <Section title={t("checkout.offer")}>
              <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
                <Text variant="caption" color="accent">
                  {service
                    ? t("item.servicePriceFor", { model: car.model.label })
                    : t("item.clubPrice")}
                </Text>
                <Text variant="price">{formatTenge(offer.price)}</Text>
                {priceWas && (
                  <Text variant="bodyS" color="warning">
                    {t("checkout.priceChangedText", {
                      was: formatTenge(previousPrice!),
                      now: formatTenge(offer.price),
                    })}
                  </Text>
                )}
                {offer.supplier.kind === "visible" ? (
                  <>
                    <Text variant="bodyStrong">{offer.supplier.name}</Text>
                    {(offer.supplier.district ?? offer.supplier.address) && (
                      <Text variant="bodyS" color="textMuted">
                        {offer.supplier.district ?? offer.supplier.address}
                      </Text>
                    )}
                  </>
                ) : (
                  <Text variant="bodyS" color="textMuted">
                    {t("item.supplierHidden")}
                  </Text>
                )}
                <Rating
                  value={offer.rating?.value ?? null}
                  count={offer.rating?.count ?? 0}
                  emptyText={t("item.newSupplier")}
                  label={t("item.rating")}
                  locale={lang}
                />
              </View>
            </Section>

            {onOrder && (
              <Section title={t("checkout.term")}>
                {receipt && (
                  <Text variant="bodyStrong">{t("checkout.onOrderTerm", { date: receipt })}</Text>
                )}
                <Text variant="bodyS" color="textMuted">
                  {t("checkout.onOrderAgree")}
                </Text>
                <Text variant="bodyS" color="textMuted">
                  {t("checkout.onOrderPrepay")}
                </Text>
              </Section>
            )}

            {service && (
              <>
                {/* M-ORD-01 «Услуга»: the car is required — the one of the header. */}
                <Section title={t("checkout.car")}>
                  <View
                    style={[styles.card, styles.carRow, { backgroundColor: theme.colors.surface }]}
                  >
                    <Text variant="bodyStrong" style={styles.grow}>
                      {carTitle(car)}
                    </Text>
                    <Button variant="text" size="m" onPress={() => setCarSheet(true)}>
                      {t("checkout.changeCar")}
                    </Button>
                  </View>
                </Section>

                {/* The days and hours are the server's; the app counts no schedule. */}
                <Section title={t("checkout.visit")}>
                  {visitOptions.status === "error" ? (
                    <Banner
                      tone="warning"
                      action={
                        <Button
                          variant="text"
                          size="m"
                          icon="refresh"
                          onPress={visitOptions.reload}
                        >
                          {t("common.retry")}
                        </Button>
                      }
                    >
                      {t("checkout.visitOptionsFailed")}
                    </Banner>
                  ) : !visitOptions.data ? (
                    <SkeletonList rows={1} label={t("common.loading")} />
                  ) : visitDays.length === 0 ? (
                    <Text color="textMuted">{t("checkout.noVisitDays")}</Text>
                  ) : (
                    <>
                      <Text variant="caption" color="textMuted">
                        {t("checkout.visitDate")}
                      </Text>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.chips}
                      >
                        {visitDays.map((day) => (
                          <Chip
                            key={day.date}
                            selected={visit?.date === day.date}
                            onPress={() => setVisitChoice({ date: day.date, time: null })}
                          >
                            {dayLabel(day.date)}
                          </Chip>
                        ))}
                      </ScrollView>
                      <Text variant="caption" color="textMuted">
                        {t("checkout.visitTime")}
                      </Text>
                      <View style={styles.times}>
                        {(visitDay?.times ?? []).map((slot) => (
                          <Chip
                            key={slot}
                            selected={visit?.time === slot}
                            onPress={() =>
                              visit && setVisitChoice({ date: visit.date, time: slot })
                            }
                          >
                            {slot}
                          </Chip>
                        ))}
                      </View>
                    </>
                  )}
                  <Text variant="bodyS" color="textMuted">
                    {t("checkout.visitHint")}
                  </Text>
                  <Text variant="bodyS" color="textMuted">
                    {t("checkout.phoneNotice")}
                  </Text>
                </Section>
              </>
            )}

            {!service && (
              <>
                <Section title={t("checkout.quantity")}>
                  <View style={styles.quantityRow}>
                    <Quantity
                      value={quantity}
                      onChange={setQuantity}
                      min={1}
                      max={maxQuantity}
                      label={t("checkout.quantity")}
                      decreaseLabel={t("checkout.decrease")}
                      increaseLabel={t("checkout.increase")}
                    />
                    <Text variant="bodyStrong" style={styles.grow}>
                      {t("checkout.total", {
                        n: quantity,
                        price: formatTenge(offer.price),
                        total: formatTenge(offer.price * quantity),
                      })}
                    </Text>
                  </View>
                  <Text variant="bodyS" color="textMuted">
                    {t("checkout.phoneNotice")}
                  </Text>
                </Section>

                <Section title={t("checkout.receiving")}>
                  {options.length > 1 ? (
                    options.map((way) => (
                      <Radio
                        key={way}
                        checked={fulfillment === way}
                        onSelect={() => setFulfillment(way)}
                        label={way === "pickup" ? t("catalog.pickup") : t("catalog.delivery")}
                        {...(receipt && !onOrder
                          ? {
                              description:
                                way === "pickup"
                                  ? t("item.pickupDate", { date: receipt })
                                  : t("item.deliveryDate", { date: receipt }),
                            }
                          : {})}
                      />
                    ))
                  ) : (
                    <Text variant="bodyStrong">
                      {receipt && !onOrder
                        ? fulfillment === "pickup"
                          ? t("item.pickupDate", { date: receipt })
                          : t("item.deliveryDate", { date: receipt })
                        : fulfillment === "pickup"
                          ? t("catalog.pickup")
                          : t("catalog.delivery")}
                    </Text>
                  )}
                  {fulfillment === "pickup" && reserve && (
                    <Text variant="bodyS" color="textMuted">
                      {reserve.onOrder
                        ? reserve.unit === "days"
                          ? tn("checkout.onOrderReserveDays", reserve.count)
                          : tn("checkout.onOrderReserveHours", reserve.count)
                        : reserve.unit === "days"
                          ? tn("checkout.reserveDays", reserve.count)
                          : tn("checkout.reserveHours", reserve.count)}
                    </Text>
                  )}
                  {fulfillment === "delivery" && (
                    <Text variant="bodyS" color="textMuted">
                      {t("checkout.deliveryNote")}
                    </Text>
                  )}
                </Section>
              </>
            )}

            {notice && (
              <Banner
                tone="warning"
                action={
                  notice.kind === "network" ||
                  notice.kind === "rate_limited" ||
                  notice.kind === "other" ? (
                    <Button variant="text" size="m" icon="refresh" onPress={() => submit()}>
                      {t("common.retry")}
                    </Button>
                  ) : undefined
                }
              >
                {noticeText(notice)}
              </Banner>
            )}
          </View>
        )}
      </DataState>

      <Dialog
        visible={asking?.kind === "price_changed"}
        onClose={() => setAsking(null)}
        title={t("checkout.priceChangedTitle")}
        actions={
          <>
            <Button
              onPress={() => {
                const current = asking?.kind === "price_changed" ? asking.currentPrice : undefined;
                setAsking(null);
                if (current !== undefined) void submit({ expectedPrice: current });
              }}
            >
              {t("checkout.orderAtNewPrice")}
            </Button>
            <Button variant="text" onPress={() => setAsking(null)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        {asking?.kind === "price_changed" && (
          <Text>
            {t("checkout.priceChangedText", {
              was: formatTenge(asking.expectedPrice),
              now: formatTenge(asking.currentPrice),
            })}
          </Text>
        )}
      </Dialog>

      <Dialog
        visible={asking?.kind === "duplicate_active"}
        onClose={() => setAsking(null)}
        title={t("checkout.duplicateTitle")}
        actions={
          <>
            <Button
              onPress={() => {
                const existing =
                  asking?.kind === "duplicate_active" ? asking.existingOrderId : null;
                setAsking(null);
                if (existing) navigation.replace("order", { orderId: existing });
              }}
            >
              {t("checkout.openIt")}
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                setAsking(null);
                setAnotherAllowed(true);
                void submit({ allowAnother: true });
              }}
            >
              {t("checkout.orderAnother")}
            </Button>
          </>
        }
      />

      <Dialog
        visible={asking?.kind === "offer_unavailable"}
        onClose={() => {
          setAsking(null);
          leaveToCard();
        }}
        title={t("checkout.offerGone")}
        actions={
          <Button
            onPress={() => {
              setAsking(null);
              leaveToCard();
            }}
          >
            {t("checkout.toOtherOffers")}
          </Button>
        }
      />

      <ClubAccessSheet visible={clubSheet} onClose={() => setClubSheet(false)} />
      {/* The car of a visit: the same switch as the header of the catalog —
          the chosen one becomes the main car, the card is asked for it. */}
      <CarSheet
        visible={carSheet}
        onClose={() => setCarSheet(false)}
        onPickCar={chooseCar}
        onAddCar={carPicker.add}
      />
    </Screen>
  );

  function noticeText(current: Notice): string {
    switch (current.kind) {
      case "fulfillment_unavailable":
        return t("checkout.fulfillmentGone");
      case "quantity_invalid":
        return t("checkout.quantityChanged", { n: maxQuantity });
      case "time_refused":
        return t("checkout.timeRefused");
      case "car_invalid":
        return t("checkout.carInvalid");
      case "kind_not_supported":
        return t("item.orderLater");
      case "rate_limited":
        return t("checkout.tooMany", { minutes: current.minutes });
      case "network":
        return t("checkout.failed");
      default:
        return t("state.errorText");
    }
  }
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 12 },
  itemRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  grow: { flex: 1 },
  // `surface` sets the card apart from the page: no frame (DESIGN.md 7.6, D-068).
  card: { borderRadius: radius.m, padding: layout.cardPadding, gap: 4 },
  quantityRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  carRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  chips: { gap: 8, paddingVertical: 4 },
  times: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  center: { textAlign: "center" },
});

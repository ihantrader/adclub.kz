import type {
  CategoryIcon as CategoryIconName,
  ShowcaseOffer,
  ShowcaseOfferSort,
} from "@adclub/contracts";
import { layout, radius, size } from "@adclub/ui-core";
import { useFocusEffect, useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import {
  Badge,
  Banner,
  Button,
  CategoryIcon,
  DataState,
  hairline,
  Icon,
  IconLine,
  ListGroup,
  ListRow,
  OfflineBanner,
  Rating,
  Screen,
  ScreenBody,
  Section,
  Segments,
  SkeletonList,
  Text,
  useTheme,
  useToast,
  ValueRow,
} from "../../design-system";
import { useCatalogCar } from "../../catalog/catalog-car-provider";
import { formatTenge, joinDot } from "../../catalog/format";
import { vehicleQuery } from "../../catalog/vehicle-query";
import { carTitle, type GarageCar } from "../../garage/garage";
import { ROOT_NAVIGATOR, type RootParams } from "../../navigation/routes";
import { useSignIn } from "../../navigation/use-sign-in";
import { canOrderOffer } from "../../orders/checkout";
import { orderGate, resumeOrderGate, type OrderGate } from "../../orders/order-gate";
import { catalogRefresh } from "../../services/catalog-refresh";
import { SignInSheet } from "../auth/SignInSheet";
import { ClubAccessSheet } from "../orders/ClubAccessSheet";
import { useSession } from "../../state/session-provider";
import { categoryIconOf } from "../../catalog/category-icon";
import { useCategoryTree, useShowcaseItem } from "../../services/use-catalog";
import { useOnline } from "../../services/use-network";
import { cityIdOf } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useLanguage } from "../../state/language";
import { CitySheet } from "../CitySheet";
import { CatalogHeader } from "./CatalogHeader";
import { CompatibilityLine, ItemRow, SORT_HINT, SORT_TEXT, useReceiptText } from "./parts";

const OFFER_SORTS: ShowcaseOfferSort[] = ["recommended", "cheaper", "faster", "rating"];

export interface ItemScreenProps {
  itemId: string;
  /** The name the previous screen already showed: the top bar has it before the data does. */
  title?: string;
  /** An analog opens the same screen; its name is passed on for the top bar. */
  onOpenItem: (item: { id: string; name: string }) => void;
  /** «Дополнить автомобиль»: the steps of choosing a car, at the engine. */
  onCompleteCar: (car: GarageCar) => void;
  /** «Добавить автомобиль» of the car switch of a service's card (M-CAT-08). */
  onAddCar: () => void;
  onBack: () => void;
  /** Opened by «Повторить заказ» instead of the checkout: why the same offer is not here (TASK-030). */
  notice?: "offer_withdrawn" | "supplier_unavailable";
}

/**
 * M-CAT-07 — the card of an item. «Оформить» on an offer in stock leads by
 * the state of the person (`orderGate`, TASK-030): a guest signs in and
 * comes back to the checkout, an account without a name finishes the
 * registration first, a member without club access sees the stand-in
 * sheet, anybody else checks out. An offer «Под заказ» has no button — a
 * short line says those orders come later (stage C), so nothing is pressed
 * in vain.
 *
 * The supplier of an offer is shown **exactly** as the server hands it over
 * (D-005): without club access the answer carries no name, no id and no
 * address at all, only `kind: "hidden"`, and the card says «Поставщик
 * клуба». The app never tries to work the name out from anything else.
 *
 * TASK-078: the name is the heading of the content and reaches the bar only
 * when scrolled past (M12); the photo is whole on `surfaceRaised` (4:3); the
 * characteristics are value rows (M1); «Подходит для» is a row of a card
 * that opens in place; an offer's button is a secondary one across the
 * card — the one main button is the checkout's (M5); green stays with the
 * compatibility (M6); the analogs are rows of the list (M-CAT-02).
 */
export function ItemScreen({
  itemId,
  title,
  onOpenItem,
  onCompleteCar,
  onAddCar,
  onBack,
  notice,
}: ItemScreenProps) {
  const { t, tn } = useLanguage();
  const online = useOnline();
  const toast = useToast();
  const { selection } = useCity();
  const { car } = useCatalogCar();
  const [sort, setSort] = useState<ShowcaseOfferSort>("recommended");
  const [showFitsFor, setShowFitsFor] = useState(false);

  const cityId = cityIdOf(selection);
  const request = useShowcaseItem(itemId, {
    ...(cityId ? { cityId } : {}),
    vehicle: vehicleQuery(car),
    sort,
  });

  useFocusEffect(
    useCallback(() => {
      // The checkout learned that an offer of this card is gone: load now.
      if (catalogRefresh.take(itemId)) request.reload();
      else request.reloadIfStale();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [itemId]),
  );

  const data = request.data;
  const tree = useCategoryTree();
  const ordering = useOrderButton(itemId, data?.viewer ?? null, request.reload);
  const rootNavigation = useNavigation();
  // M-CAT-09 (TASK-050): the supplier or the rating of an offer opens its page.
  const openSupplier = useCallback(
    (offerId: string) =>
      rootNavigation
        .getParent<NativeStackNavigationProp<RootParams>>(ROOT_NAVIGATOR)
        ?.push("supplier-page", { offerId }),
    [rootNavigation],
  );
  const carName = carTitle(car);
  // M-CAT-08 (TASK-019): a service — by the chosen city, at the price for the
  // car's model; no compatibility, availability or receipt date.
  const service = data?.item.type === "service";
  const [citySheet, setCitySheet] = useState(false);
  const placeholderIcon = data
    ? categoryIconOf(tree.data?.categories, data.item.category.id)
    : null;

  const status =
    !online && data === null
      ? "offline"
      : request.status === "loading"
        ? "loading"
        : request.status === "error"
          ? "error"
          : "ready";

  const copyArticle = useCallback(
    (article: string) => {
      void Clipboard.setStringAsync(article).then(() => toast.show(t("item.articleCopied")));
    },
    [t, toast],
  );

  return (
    <Screen
      title={data?.item.name.text ?? title ?? t("tabs.catalog")}
      titleAfterScroll
      back={{ label: t("common.back"), onPress: onBack }}
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      // A service's price is for the car's model and its city (M-CAT-08): the switches of the catalog.
      header={service ? <CatalogHeader onAddCar={onAddCar} services /> : undefined}
      refreshing={request.refreshing}
      // Another order of the offers: the card fades from the old order to the new one.
      contentKey={request.answerKey}
      refreshingLabel={t("common.loading")}
    >
      <DataState
        status={status}
        skeleton={<SkeletonList rows={4} label={t("common.loading")} />}
        error={
          request.failure === "not_found"
            ? { title: t("item.notFound"), text: t("item.notFoundText") }
            : request.failure === "rate_limited"
              ? {
                  title: t("state.tooManyRequests"),
                  text: t("state.tooManyRequestsText"),
                  retry: { label: t("common.retry"), onRetry: request.reload },
                }
              : {
                  title: t("state.errorTitle"),
                  text: t("state.errorText"),
                  retry: { label: t("common.retry"), onRetry: request.reload },
                }
        }
        empty={{ icon: "package", title: t("item.notFound") }}
      >
        {data && (
          <ScreenBody>
            {notice && (
              <View style={styles.notice}>
                <Banner tone="warning">
                  {notice === "offer_withdrawn"
                    ? t("item.noticeOfferWithdrawn")
                    : t("item.noticeSupplierUnavailable")}
                </Banner>
              </View>
            )}
            <Section first>
              {/* A service without pictures has nothing to wait for: no placeholder (M-CAT-08). */}
              {(!service || data.item.photos.length > 0) && (
                <Photos
                  photos={data.item.photos}
                  icon={placeholderIcon}
                  placeholder={t("item.photoPlaceholder")}
                />
              )}
              <View style={styles.head}>
                <Text variant="heading" accessibilityRole="header">
                  {data.item.name.text}
                </Text>
                {/* The brand and the article on one line (TASK-030.A); a long press
                    copies the article — the line keeps the 48 touch zone. */}
                {data.item.article ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${t("item.article")}: ${data.item.article}`}
                    accessibilityHint={t("item.articleCopied")}
                    onLongPress={() => copyArticle(data.item.article ?? "")}
                    style={styles.article}
                  >
                    <Text variant="bodyS" color="textMuted" style={styles.articleText}>
                      {joinDot([data.item.brand?.name, data.item.article])}
                    </Text>
                    <Icon name="copy" size={16} color="textMuted" />
                  </Pressable>
                ) : (
                  data.item.brand && (
                    <Text variant="bodyS" color="textMuted">
                      {data.item.brand.name}
                    </Text>
                  )
                )}
                {service ? (
                  <IconLine icon="mapPin" variant="bodyS">
                    {data.city
                      ? t("item.serviceCity", { city: data.city.name.text })
                      : t("city.servicesNote")}
                  </IconLine>
                ) : (
                  <CompatibilityLine
                    result={data.compatibility}
                    carName={carName}
                    variant="card"
                    onComplete={() => onCompleteCar(car)}
                  />
                )}
              </View>
            </Section>

            {service && data.city === null && (
              <Section>
                {/* «Весь Казахстан» — services are by a city: first choose one (M-CAT-08). */}
                <Banner
                  tone="neutral"
                  icon="mapPin"
                  action={
                    <Button variant="text" size="m" onPress={() => setCitySheet(true)}>
                      {t("catalog.chooseCity")}
                    </Button>
                  }
                >
                  {t("city.servicesNote")}
                </Banner>
              </Section>
            )}

            {!service && data.fitsFor.length > 0 && (
              <Section>
                <ListGroup>
                  <ListRow
                    first
                    title={t("item.fitsFor")}
                    onPress={() => setShowFitsFor((value) => !value)}
                    trailing={
                      <>
                        <Text variant="bodyS" color="textMuted">
                          {tn("item.fitsForModels", data.fitsFor.length)}
                        </Text>
                        <Icon
                          name={showFitsFor ? "chevronDown" : "chevronRight"}
                          size={20}
                          color="textMuted"
                        />
                      </>
                    }
                  />
                  {showFitsFor &&
                    data.fitsFor.map((label, index) => (
                      <ListRow
                        key={index}
                        title={
                          <Text variant="bodyS">
                            {joinDot([
                              label.make,
                              label.model,
                              label.generation,
                              label.engine,
                              label.years,
                            ])}
                          </Text>
                        }
                      />
                    ))}
                </ListGroup>
              </Section>
            )}

            {data.item.attributes.length > 0 && (
              <Section title={t("item.characteristics")}>
                <ListGroup>
                  {data.item.attributes.map((attribute, index) => (
                    <ValueRow
                      key={attribute.attributeId}
                      first={index === 0}
                      label={attribute.name.text}
                      value={attribute.display.text}
                    />
                  ))}
                </ListGroup>
              </Section>
            )}

            <Section title={t("item.offers")}>
              {data.noOffers ? (
                <Text color="textMuted">
                  {service && data.city
                    ? t("item.noServiceOffers", {
                        model: car.model.label,
                        city: data.city.name.text,
                      })
                    : t("item.noOffers")}
                </Text>
              ) : (
                <>
                  {/* The same control as the list (TASK-030.A), with «Рейтинг». */}
                  {data.offers.length > 1 && (
                    <Segments
                      label={t("catalog.sort")}
                      value={sort}
                      onChange={setSort}
                      options={(service
                        ? OFFER_SORTS.filter((value) => value !== "faster")
                        : OFFER_SORTS
                      ).map((value) => ({
                        value,
                        label: t(SORT_TEXT[value]),
                        hint: t(SORT_HINT[value]),
                      }))}
                    />
                  )}
                  <View style={styles.offers}>
                    {data.offers.map((offer) => (
                      <OfferCard
                        key={offer.id}
                        offer={offer}
                        {...(service ? { serviceModel: carName } : {})}
                        onOrder={ordering.press}
                        onOpenSupplier={openSupplier}
                      />
                    ))}
                  </View>
                </>
              )}
            </Section>

            {data.analogs.length > 0 && (
              <Section title={t("item.analogs")}>
                <ListGroup>
                  {data.analogs.map((analog, index) => (
                    <ItemRow
                      key={analog.id}
                      first={index === 0}
                      last={index === data.analogs.length - 1}
                      name={analog.name.text}
                      brand={analog.brand?.name ?? null}
                      article={analog.article}
                      photo={analog.photo}
                      icon={placeholderIcon}
                      keyAttributes={[]}
                      compatibility={analog.compatibility}
                      carName={carName}
                      offers={analog.offers}
                      cityName={data.city?.name.text ?? null}
                      onPress={() => onOpenItem({ id: analog.id, name: analog.name.text })}
                    />
                  ))}
                </ListGroup>
              </Section>
            )}
          </ScreenBody>
        )}
      </DataState>

      {ordering.sheets}
      <CitySheet visible={citySheet} onClose={() => setCitySheet(false)} services />
    </Screen>
  );
}

/**
 * The photos of the card, 4:3 across the screen, whole (`contain`) on
 * `surfaceRaised` — a photo is never cut (TASK-078 M-CAT-07); the
 * placeholder with T-CAT-09 where there is none.
 */
function Photos({
  photos,
  icon,
  placeholder,
}: {
  photos: { photoId: string; url: string }[];
  icon: CategoryIconName | null;
  placeholder: string;
}) {
  const { theme } = useTheme();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  // 4:3 across the screen, inside its 16 padding (DESIGN 7.8).
  const photoWidth = Math.max(160, width - layout.screenPadding * 2);
  const photoHeight = Math.round((photoWidth * 3) / 4);

  if (photos.length === 0) {
    return (
      <View
        style={[
          styles.photoPlaceholder,
          { height: photoHeight, backgroundColor: theme.colors.surfaceRaised },
        ]}
      >
        <CategoryIcon name={icon} size={48} color="textMuted" />
        <Text variant="bodyS" color="textMuted">
          {placeholder}
        </Text>
      </View>
    );
  }

  return (
    <View>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        style={[styles.photoStrip, { backgroundColor: theme.colors.surfaceRaised }]}
        onMomentumScrollEnd={(event) => {
          const width = event.nativeEvent.layoutMeasurement.width;
          setPage(width > 0 ? Math.round(event.nativeEvent.contentOffset.x / width) : 0);
        }}
      >
        {photos.map((photo) => (
          <Image
            key={photo.photoId}
            source={{ uri: photo.url }}
            accessibilityIgnoresInvertColors
            style={{ width: photoWidth, height: photoHeight }}
            resizeMode="contain"
          />
        ))}
      </ScrollView>
      {photos.length > 1 && (
        <View style={styles.dots}>
          {photos.map((photo, index) => (
            <View
              key={photo.photoId}
              style={[
                styles.dot,
                {
                  backgroundColor: index === page ? theme.colors.accent : theme.colors.borderField,
                },
              ]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * «Оформить» of the card (TASK-030 requirement 1): what a press leads to,
 * and the press of a guest remembered until they come back signed in
 * (SCREENS M-AUTH-00 «после входа — возврат к действию»). The sign-in and
 * the registration are screens pushed over this one, so «came back» is this
 * screen in focus again after it had been left.
 */
function useOrderButton(
  itemId: string,
  viewer: { signedIn: boolean; clubAccess: boolean } | null,
  reload: () => void,
) {
  const { t } = useLanguage();
  const session = useSession();
  const signIn = useSignIn();
  const navigation = useNavigation();
  const focused = useIsFocused();
  // One sign-in sheet for the whole card (TASK-029.B), for «Оформить» (T-GATE-01);
  // the hidden name of a supplier now opens M-CAT-09, which asks there (TASK-050).
  const [signInReason, setSignInReason] = useState<"order" | null>(null);
  const [clubSheet, setClubSheet] = useState(false);
  const [pending, setPending] = useState<{ offerId: string; afterReturn: boolean } | null>(null);
  const left = useRef(false);

  const gate: OrderGate = orderGate({
    session: session.status,
    registrationCompleted:
      session.status === "signed_in" ? (session.profile?.registrationCompleted ?? null) : null,
    viewer,
  });

  const go = useCallback(
    (to: OrderGate, offerId: string) => {
      if (to === "club-access") {
        setClubSheet(true);
        // The card says what the server thought a moment ago; access given
        // meanwhile (by invitation, today) shows on the next press.
        reload();
        return;
      }
      navigation
        .getParent<NativeStackNavigationProp<RootParams>>(ROOT_NAVIGATOR)
        ?.push("order-checkout", { itemId, offerId });
    },
    [navigation, itemId, reload],
  );

  useEffect(() => {
    if (!focused) left.current = true;
  }, [focused]);

  // Carry the remembered press out once the person is back (or once what it
  // waited for — the profile, the card as this account sees it — has come).
  useEffect(() => {
    if (!pending || !focused) return;
    if (pending.afterReturn && !left.current) return;
    const next = resumeOrderGate(gate);
    if (next === "wait") return;
    // A remembered press is carried out or forgotten once, as an effect of
    // the session and the card arriving.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending(null);
    if (next === "go") go(gate, pending.offerId);
  }, [pending, focused, gate, go]);

  const press = (offerId: string) => {
    left.current = false;
    switch (gate) {
      case "sign-in":
        setPending({ offerId, afterReturn: true });
        setSignInReason("order");
        return;
      case "register":
        setPending({ offerId, afterReturn: true });
        signIn.resumeRegistration();
        return;
      case "wait":
        setPending({ offerId, afterReturn: false });
        return;
      default:
        go(gate, offerId);
    }
  };

  return {
    press,
    sheets: (
      <>
        <SignInSheet
          visible={signInReason !== null}
          onClose={() => setSignInReason(null)}
          reason={t("auth.gateOrder")}
        />
        <ClubAccessSheet visible={clubSheet} onClose={() => setClubSheet(false)} />
      </>
    ),
  };
}

function OfferCard({
  offer,
  serviceModel,
  onOrder,
  onOpenSupplier,
}: {
  offer: ShowcaseOffer;
  /**
   * An offer on a service (TASK-019): the car its price is for; no
   * availability, no dates; «Записаться» opens the booking (TASK-039.B).
   */
  serviceModel?: string;
  onOrder: (offerId: string) => void;
  /**
   * The supplier or its rating tapped (SCREENS M-CAT-07, TASK-050): M-CAT-09.
   * A guest signs in there, for the reviews (it replaced T-GATE-02 here).
   */
  onOpenSupplier: (offerId: string) => void;
}) {
  const { t, lang } = useLanguage();
  const { theme } = useTheme();
  const receiptText = useReceiptText();
  const service = serviceModel !== undefined;
  const receipt = service ? null : receiptText(offer.receipt, "withDate");
  const inStock = offer.availability === "in_stock";
  const placeLine = joinDot([
    offer.supplier.kind === "visible" ? (offer.supplier.district ?? offer.supplier.address) : null,
    offer.inCity ? t("item.inYourCity") : offer.city.name.text,
  ]);

  return (
    <View
      style={[
        styles.offer,
        // `surface` sets the offer apart from the page: no frame (DESIGN.md 7.6).
        { backgroundColor: theme.colors.surface },
      ]}
    >
      <Text variant="caption" color="accent">
        {service ? t("item.clubPriceFor", { model: serviceModel }) : t("item.clubPrice")}
      </Text>
      <Text variant="price">{formatTenge(offer.price)}</Text>
      {!service && (
        <View style={styles.offerLines}>
          {/* A fact, not a status: no plate, no green (M6). */}
          <IconLine icon={inStock ? "package" : "clock"} variant="bodyS" textColor="text">
            {inStock ? t("catalog.inStock") : t("catalog.onOrder")}
          </IconLine>
          {receipt && offer.pickup && (
            <IconLine icon="store" variant="bodyS" textColor="text">
              {t("item.pickupDate", { date: receipt.text })}
            </IconLine>
          )}
          {receipt && offer.delivery && (
            <IconLine icon="truck" variant="bodyS" textColor="text">
              {t(receipt.soon ? "item.deliveryDateSoon" : "item.deliveryDate", {
                date: receipt.text,
              })}
            </IconLine>
          )}
        </View>
      )}
      <View style={[styles.offerDivider, { backgroundColor: theme.colors.border }]} />

      {/* M-CAT-07: the supplier and its rating open M-CAT-09 (TASK-050). D-005:
          without club access there is no name in the answer at all. */}
      <Pressable
        accessibilityRole="button"
        accessibilityHint={t("item.openSupplier")}
        onPress={() => onOpenSupplier(offer.id)}
        style={styles.supplierBlock}
      >
        <View style={styles.supplierText}>
          {offer.supplier.kind === "hidden" ? (
            <IconLine icon="lock" variant="bodyS">
              {t("item.supplierHidden")}
            </IconLine>
          ) : (
            <Text variant="bodyStrong">{offer.supplier.name}</Text>
          )}
          {placeLine !== "" && (
            <Text variant="bodyS" color="textMuted">
              {placeLine}
            </Text>
          )}
          <View style={styles.offerMarks}>
            {offer.verifiedPartner && (
              <Badge tone="accent" icon="progressCheck">
                {t("item.verifiedPartner")}
              </Badge>
            )}
            <Rating
              value={offer.rating?.value ?? null}
              count={offer.rating?.count ?? 0}
              emptyText={t("item.newSupplier")}
              label={t("item.rating")}
              locale={lang}
            />
          </View>
        </View>
        <Icon name="chevronRight" size={20} color="textMuted" />
      </Pressable>
      {offer.warrantyMonths !== null && (
        <Text variant="bodyS" color="textMuted">
          {t("item.warrantyMonths", { n: offer.warrantyMonths })}
        </Text>
      )}
      {offer.warrantyText ? (
        <Text variant="bodyS" color="textMuted">
          {offer.warrantyText}
        </Text>
      ) : null}
      {/* A secondary M button across the card (M5): the one main button is the checkout's. */}
      {service ? (
        <Button
          variant="secondary"
          size="m"
          onPress={() => onOrder(offer.id)}
          style={styles.orderButton}
        >
          {t("item.book")}
        </Button>
      ) : canOrderOffer(offer) ? (
        <Button
          variant="secondary"
          size="m"
          onPress={() => onOrder(offer.id)}
          style={styles.orderButton}
        >
          {t("item.order")}
        </Button>
      ) : (
        <Text variant="bodyS" color="textMuted" style={styles.orderLater}>
          {t("item.orderLater")}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { paddingBottom: 12 },
  head: { gap: 4 },
  article: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: size.touchTarget },
  articleText: { flexShrink: 1 },
  photoStrip: { borderRadius: radius.m, overflow: "hidden" },
  photoPlaceholder: {
    borderRadius: radius.m,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  dots: { flexDirection: "row", justifyContent: "center", gap: 6, paddingTop: 8 },
  dot: { width: 6, height: 6, borderRadius: radius.full },
  offers: { gap: 12 },
  offer: { borderRadius: radius.m, padding: layout.cardPadding, gap: 6 },
  offerLines: { gap: 4, paddingTop: 4 },
  offerDivider: { height: hairline, marginVertical: 6 },
  offerMarks: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  supplierBlock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: size.touchTarget,
  },
  supplierText: { flex: 1, gap: 2 },
  orderButton: { marginTop: 8 },
  orderLater: { paddingTop: 8 },
});

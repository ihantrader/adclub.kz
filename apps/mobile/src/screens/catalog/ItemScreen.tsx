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
  ListGroup,
  ListRow,
  OfflineBanner,
  Rating,
  Screen,
  Section,
  Segments,
  SkeletonList,
  Text,
  useTheme,
  useToast,
} from "../../design-system";
import { useCatalogCar } from "../../catalog/catalog-car-provider";
import { formatTenge } from "../../catalog/format";
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
import { CompatibilityLine, SORT_HINT, SORT_TEXT, useReceiptText } from "./parts";

const OFFER_SORTS: ShowcaseOfferSort[] = ["recommended", "cheaper", "faster", "rating"];

export interface ItemScreenProps {
  itemId: string;
  /** The name the previous screen already showed: the top bar has it before the data does. */
  title?: string;
  /** An analog opens the same screen; its name is passed on for the top bar. */
  onOpenItem: (item: { id: string; name: string }) => void;
  /** «Дополнить автомобиль»: the steps of choosing a car, at the engine. */
  onCompleteCar: (car: GarageCar) => void;
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
 */
export function ItemScreen({
  itemId,
  title,
  onOpenItem,
  onCompleteCar,
  onBack,
  notice,
}: ItemScreenProps) {
  const { t } = useLanguage();
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
  const carName = carTitle(car);

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
      back={{ label: t("common.back"), onPress: onBack }}
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      refreshing={request.refreshing}
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
          <View style={styles.body}>
            {notice && (
              <Banner tone="warning">
                {notice === "offer_withdrawn"
                  ? t("item.noticeOfferWithdrawn")
                  : t("item.noticeSupplierUnavailable")}
              </Banner>
            )}
            <Photos
              photos={data.item.photos}
              icon={categoryIconOf(tree.data?.categories, data.item.category.id)}
              placeholder={t("item.photoPlaceholder")}
            />

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
                    {[data.item.brand?.name, data.item.article].filter(Boolean).join(" · ")}
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

              <CompatibilityLine
                result={data.compatibility}
                carName={carName}
                variant="card"
                onComplete={() => onCompleteCar(car)}
              />
            </View>

            {data.fitsFor.length > 0 && (
              <Section>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showFitsFor }}
                  onPress={() => setShowFitsFor((value) => !value)}
                  style={styles.collapsible}
                >
                  <Text variant="heading" style={styles.grow}>
                    {t("item.fitsFor")}
                  </Text>
                  <Icon name={showFitsFor ? "chevronDown" : "chevronRight"} size={20} />
                </Pressable>
                {showFitsFor &&
                  data.fitsFor.map((label, index) => (
                    <Text key={index} variant="bodyS" color="textMuted">
                      {[label.make, label.model, label.generation, label.engine, label.years]
                        .filter((part): part is string => Boolean(part))
                        .join(" · ")}
                    </Text>
                  ))}
              </Section>
            )}

            {data.item.attributes.length > 0 && (
              <Section title={t("item.characteristics")}>
                <ListGroup>
                  {data.item.attributes.map((attribute, index) => (
                    <ListRow
                      key={attribute.attributeId}
                      first={index === 0}
                      title={attribute.name.text}
                      trailing={
                        <Text variant="bodyStrong" style={styles.attributeValue}>
                          {attribute.display.text}
                        </Text>
                      }
                    />
                  ))}
                </ListGroup>
              </Section>
            )}

            <Section title={t("item.offers")}>
              {data.noOffers ? (
                <Text color="textMuted">{t("item.noOffers")}</Text>
              ) : (
                <>
                  {/* The same control as the list (TASK-030.A), with «Рейтинг». */}
                  {data.offers.length > 1 && (
                    <Segments
                      label={t("catalog.sort")}
                      value={sort}
                      onChange={setSort}
                      options={OFFER_SORTS.map((value) => ({
                        value,
                        label: t(SORT_TEXT[value]),
                        hint: t(SORT_HINT[value]),
                      }))}
                    />
                  )}
                  <View style={styles.offers}>
                    {data.offers.map((offer) => (
                      <OfferCard key={offer.id} offer={offer} onOrder={ordering.press} />
                    ))}
                  </View>
                </>
              )}
            </Section>

            {data.analogs.length > 0 && (
              <Section title={t("item.analogs")}>
                <ListGroup>
                  {data.analogs.map((analog, index) => (
                    <ListRow
                      key={analog.id}
                      first={index === 0}
                      title={analog.name.text}
                      subtitle={[analog.brand?.name, analog.article]
                        .filter((part): part is string => Boolean(part))
                        .join(" · ")}
                      navigates
                      onPress={() => onOpenItem({ id: analog.id, name: analog.name.text })}
                      trailing={<Text variant="priceS">{formatTenge(analog.offers.minPrice)}</Text>}
                    />
                  ))}
                </ListGroup>
              </Section>
            )}
          </View>
        )}
      </DataState>

      {ordering.sheets}
    </Screen>
  );
}

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

  if (photos.length === 0) {
    return (
      <View style={[styles.photoPlaceholder, { backgroundColor: theme.colors.surfaceRaised }]}>
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
            style={[styles.photo, { width: photoWidth, height: Math.round((photoWidth * 3) / 4) }]}
            resizeMode="cover"
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
  const [signInSheet, setSignInSheet] = useState(false);
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
        setSignInSheet(true);
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
          visible={signInSheet}
          onClose={() => setSignInSheet(false)}
          reason={t("auth.gateOrder")}
        />
        <ClubAccessSheet visible={clubSheet} onClose={() => setClubSheet(false)} />
      </>
    ),
  };
}

function OfferCard({
  offer,
  onOrder,
}: {
  offer: ShowcaseOffer;
  onOrder: (offerId: string) => void;
}) {
  const { t, lang } = useLanguage();
  const { theme } = useTheme();
  const receiptText = useReceiptText();
  const date = receiptText(offer.receipt, "withDate");
  const [signInSheet, setSignInSheet] = useState(false);
  // A guest taps «Поставщик клуба» to sign in (T-GATE-02, SCREENS M-AUTH-00);
  // a signed-in user without club access sees the same line, but nothing
  // here can get them access yet (a subscription — EPIC-14), so it stays inert.
  const opensSignIn = offer.supplier.kind === "hidden" && offer.supplier.reason === "auth_required";

  return (
    <View
      style={[
        styles.offer,
        // `surface` sets the offer apart from the page: no frame (DESIGN.md 7.6).
        { backgroundColor: theme.colors.surface },
      ]}
    >
      <View style={styles.offerTop}>
        <View style={styles.grow}>
          <Text variant="caption" color="accent">
            {t("item.clubPrice")}
          </Text>
          <Text variant="price">{formatTenge(offer.price)}</Text>
        </View>
        <Badge
          tone={offer.availability === "in_stock" ? "success" : "neutral"}
          icon={offer.availability === "in_stock" ? "package" : "clock"}
        >
          {offer.availability === "in_stock" ? t("catalog.inStock") : t("catalog.onOrder")}
        </Badge>
      </View>
      {date && (offer.pickup || offer.delivery) && (
        <View style={styles.offerDates}>
          {offer.pickup && (
            <View style={styles.offerLine}>
              <Icon name="mapPin" size={16} color="textMuted" />
              <Text variant="bodyS" style={styles.grow}>
                {t("item.pickupDate", { date })}
              </Text>
            </View>
          )}
          {offer.delivery && (
            <View style={styles.offerLine}>
              <Icon name="route" size={16} color="textMuted" />
              <Text variant="bodyS" style={styles.grow}>
                {t("item.deliveryDate", { date })}
              </Text>
            </View>
          )}
        </View>
      )}
      <View style={[styles.offerDivider, { backgroundColor: theme.colors.border }]} />

      {/* D-005: without club access there is no name in the answer at all. */}
      <Pressable
        disabled={!opensSignIn}
        accessibilityRole={opensSignIn ? "button" : undefined}
        onPress={() => setSignInSheet(true)}
        style={styles.supplierLine}
      >
        {offer.supplier.kind === "hidden" ? (
          <>
            <Icon name="lock" size={16} color="textMuted" />
            <Text variant="bodyS" color="textMuted">
              {t("item.supplierHidden")}
            </Text>
          </>
        ) : (
          <Text variant="bodyStrong">{offer.supplier.name}</Text>
        )}
      </Pressable>
      {opensSignIn && (
        <SignInSheet
          visible={signInSheet}
          onClose={() => setSignInSheet(false)}
          reason={t("auth.gateSupplierName")}
        />
      )}
      {offer.supplier.kind === "visible" && (offer.supplier.district ?? offer.supplier.address) && (
        <Text variant="bodyS" color="textMuted">
          {offer.supplier.district ?? offer.supplier.address}
        </Text>
      )}

      <View style={styles.offerMarks}>
        {offer.verifiedPartner && (
          <Badge tone="success" icon="circleCheck">
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
      <Text variant="bodyS" color="textMuted">
        {offer.inCity ? t("item.inYourCity") : offer.city.name.text}
      </Text>
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
      {canOrderOffer(offer) ? (
        <Button size="m" onPress={() => onOrder(offer.id)} style={styles.orderButton}>
          {t("item.order")}
        </Button>
      ) : (
        <Text variant="bodyS" color="textMuted" style={styles.orderLater}>
          {t("item.onOrderLater")}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 12 },
  head: { gap: 2 },
  grow: { flex: 1 },
  attributeValue: { flexShrink: 1, maxWidth: "60%", textAlign: "right" },
  article: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: size.touchTarget },
  articleText: { flexShrink: 1 },
  collapsible: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.touchTarget },
  photo: { borderRadius: radius.m },
  photoPlaceholder: {
    height: 200,
    borderRadius: radius.m,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  dots: { flexDirection: "row", justifyContent: "center", gap: 6, paddingTop: 8 },
  dot: { width: 6, height: 6, borderRadius: radius.full },
  offers: { gap: 12 },
  offer: { borderRadius: radius.m, padding: layout.cardPadding, gap: 6 },
  offerTop: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  offerDates: { gap: 4 },
  offerLine: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  offerDivider: { height: hairline, marginVertical: 6 },
  offerMarks: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  supplierLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  orderButton: { marginTop: 8 },
  orderLater: { paddingTop: 8 },
});

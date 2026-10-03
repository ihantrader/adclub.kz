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
  Icon,
  ListRow,
  OfflineBanner,
  Rating,
  Screen,
  Section,
  Sheet,
  useAfterDismiss,
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
import { useShowcaseItem } from "../../services/use-catalog";
import { useOnline } from "../../services/use-network";
import { cityIdOf } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useLanguage } from "../../state/language";
import { CompatibilityLine, useReceiptText } from "./parts";

const OFFER_SORTS: ShowcaseOfferSort[] = ["recommended", "cheaper", "faster", "rating"];
const SORT_TEXT = {
  recommended: "catalog.sort.recommended",
  cheaper: "catalog.sort.cheaper",
  faster: "catalog.sort.faster",
  rating: "catalog.sort.rating",
} as const satisfies Record<ShowcaseOfferSort, string>;

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
  const [sortSheet, setSortSheet] = useState(false);
  // The offers reorder once the sheet has gone, not while it is closing.
  const sortDismissed = useAfterDismiss(sortSheet);
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
              icon={null}
              placeholder={t("item.photoPlaceholder")}
            />

            <View style={styles.head}>
              <Text variant="heading" accessibilityRole="header">
                {data.item.name.text}
              </Text>
              {data.item.brand && (
                <Text variant="bodyS" color="textMuted">
                  {data.item.brand.name}
                </Text>
              )}
              {data.item.article && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${t("item.article")}: ${data.item.article}`}
                  accessibilityHint={t("item.articleCopied")}
                  onLongPress={() => copyArticle(data.item.article ?? "")}
                  style={styles.article}
                >
                  <Text variant="bodyS" color="textMuted">
                    {data.item.article}
                  </Text>
                  <Icon name="copy" size={16} color="textMuted" />
                </Pressable>
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
                <View>
                  {data.item.attributes.map((attribute, index) => (
                    <ListRow
                      key={attribute.attributeId}
                      first={index === 0}
                      title={attribute.name.text}
                      trailing={<Text variant="bodyStrong">{attribute.display.text}</Text>}
                    />
                  ))}
                </View>
              </Section>
            )}

            <Section title={t("item.offers")}>
              {data.noOffers ? (
                <Text color="textMuted">{t("item.noOffers")}</Text>
              ) : (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("catalog.sort")}
                    onPress={() => setSortSheet(true)}
                    style={styles.sortButton}
                  >
                    <Text variant="bodyS" color="textMuted">
                      {t("catalog.sort")}:
                    </Text>
                    <Text variant="bodyS">{t(SORT_TEXT[sort])}</Text>
                    <Icon name="chevronDown" size={16} color="textMuted" />
                  </Pressable>
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
                <View>
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
                </View>
              </Section>
            )}
          </View>
        )}
      </DataState>

      <Sheet
        visible={sortSheet}
        onClose={() => setSortSheet(false)}
        onDismissed={sortDismissed.onDismissed}
        title={t("catalog.sort")}
        closeLabel={t("common.close")}
      >
        {OFFER_SORTS.map((value, index) => (
          <ListRow
            key={value}
            first={index === 0}
            title={t(SORT_TEXT[value])}
            onPress={() => {
              sortDismissed.after(() => setSort(value));
              setSortSheet(false);
            }}
            trailing={value === sort ? <Icon name="check" color="accent" /> : null}
          />
        ))}
      </Sheet>
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
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      <Text variant="caption" color="accent">
        {t("item.offers")}
      </Text>
      <Text variant="price">{formatTenge(offer.price)}</Text>
      <Text variant="bodyS" color="textMuted">
        {offer.availability === "in_stock" ? t("catalog.inStock") : t("catalog.onOrder")}
      </Text>
      {date && offer.pickup && <Text variant="bodyS">{t("item.pickupDate", { date })}</Text>}
      {date && offer.delivery && <Text variant="bodyS">{t("item.deliveryDate", { date })}</Text>}

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
  head: { gap: 6 },
  grow: { flex: 1 },
  article: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: size.touchTarget },
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
  sortButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: size.touchTarget,
  },
  offers: { gap: 12 },
  offer: { borderWidth: 1, borderRadius: radius.m, padding: layout.cardPadding, gap: 4 },
  supplierLine: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 4 },
  orderButton: { marginTop: 8 },
  orderLater: { paddingTop: 8 },
});

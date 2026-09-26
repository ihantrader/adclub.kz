import type {
  CategoryIcon as CategoryIconName,
  ShowcaseOffer,
  ShowcaseOfferSort,
} from "@adclub/contracts";
import { layout, radius, size } from "@adclub/ui-core";
import { useFocusEffect } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useCallback, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import {
  Badge,
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
  SkeletonList,
  Text,
  useTheme,
  useToast,
} from "../../design-system";
import { useCatalogCar } from "../../catalog/catalog-car-provider";
import { formatTenge } from "../../catalog/format";
import { vehicleQuery } from "../../catalog/vehicle-query";
import { carTitle } from "../../garage/garage";
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
  onOpenItem: (itemId: string) => void;
  onAddCar: () => void;
  onCompleteCar: (carId: string) => void;
  onBack: () => void;
}

/**
 * M-CAT-07 — the card of an item. There is no «Оформить» here: orders are
 * TASK-030, and a button that does nothing is worse than no button.
 *
 * The supplier of an offer is shown **exactly** as the server hands it over
 * (D-005): without club access the answer carries no name, no id and no
 * address at all, only `kind: "hidden"`, and the card says «Поставщик
 * клуба». The app never tries to work the name out from anything else.
 */
export function ItemScreen({
  itemId,
  onOpenItem,
  onAddCar,
  onCompleteCar,
  onBack,
}: ItemScreenProps) {
  const { t } = useLanguage();
  const online = useOnline();
  const toast = useToast();
  const { selection } = useCity();
  const { car } = useCatalogCar();
  const [sort, setSort] = useState<ShowcaseOfferSort>("recommended");
  const [sortSheet, setSortSheet] = useState(false);
  const [showFitsFor, setShowFitsFor] = useState(false);

  const cityId = cityIdOf(selection);
  const request = useShowcaseItem(itemId, {
    ...(cityId ? { cityId } : {}),
    vehicle: vehicleQuery(car),
    sort,
  });

  useFocusEffect(
    useCallback(() => {
      request.reloadIfStale();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const data = request.data;
  const carName = car ? carTitle(car) : null;

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
      title={data?.item.name.text ?? t("tabs.catalog")}
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
                onComplete={() => (car ? onCompleteCar(car.id) : onAddCar())}
              />
              {!car && (
                <Button variant="text" size="m" onPress={onAddCar} style={styles.inlineButton}>
                  {t("compat.checkForCar")}
                </Button>
              )}
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
                      <OfferCard key={offer.id} offer={offer} />
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
                      onPress={() => onOpenItem(analog.id)}
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
        title={t("catalog.sort")}
        closeLabel={t("common.close")}
      >
        {OFFER_SORTS.map((value, index) => (
          <ListRow
            key={value}
            first={index === 0}
            title={t(SORT_TEXT[value])}
            onPress={() => {
              setSort(value);
              setSortSheet(false);
            }}
            trailing={value === sort ? <Icon name="check" color="accent" /> : null}
          />
        ))}
      </Sheet>
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

function OfferCard({ offer }: { offer: ShowcaseOffer }) {
  const { t, lang } = useLanguage();
  const { theme } = useTheme();
  const receiptText = useReceiptText();
  const date = receiptText(offer.receipt, "withDate");

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
      <View style={styles.supplierLine}>
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
      </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 12 },
  head: { gap: 6 },
  grow: { flex: 1 },
  article: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: size.touchTarget },
  inlineButton: { alignSelf: "flex-start", paddingHorizontal: 0 },
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
});

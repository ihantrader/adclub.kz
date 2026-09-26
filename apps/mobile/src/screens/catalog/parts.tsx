import type {
  CategoryIcon as CategoryIconName,
  CompatibilityItemResult,
  ItemPhotoImage,
  ShowcaseAttributeValue,
  ShowcaseOfferSummary,
} from "@adclub/contracts";
import { layout, radius, size } from "@adclub/ui-core";
import { Image, Pressable, StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  CategoryIcon,
  CompatibilityMark,
  Icon,
  Text,
  useTheme,
} from "../../design-system";
import {
  compatibilityMarkOf,
  compatibilityView,
  COMPATIBILITY_LEVEL_TEXT,
  type CompatibilityView,
} from "../../catalog/compatibility-view";
import { formatTenge, receiptDay } from "../../catalog/format";
import { useLanguage } from "../../state/language";

/**
 * The pieces of the catalog screens that more than one screen needs
 * (DESIGN 7.8): the compatibility mark, the photo or its placeholder, the
 * price line, and the row of an item.
 */

/**
 * The receipt date in words. A list card says just «Завтра» (M-CAT-02); an
 * offer says «Самовывоз: завтра, 14 марта» (M-CAT-07) — the word and the
 * date, because the date is what a person writes down.
 */
export function useReceiptText() {
  const { t, lang } = useLanguage();
  return (
    receipt: { date: string; confirmedOn: string },
    form: "short" | "withDate" = "short",
  ): string | null => {
    const day = receiptDay(receipt.date, receipt.confirmedOn);
    if (!day) return null;
    if (day.kind === "date") return `${day.day} ${t(`month.${day.month}` as "month.1")}`;
    const word = t(day.kind === "today" ? "catalog.today" : "catalog.tomorrow");
    if (form === "short") return word;
    const parts = receiptDay(receipt.date, "0000-01-01");
    const date =
      parts && parts.kind === "date"
        ? `${parts.day} ${t(`month.${parts.month}` as "month.1")}`
        : null;
    // Mid-sentence the word is not capitalised: «Самовывоз: завтра, 14 марта».
    const lower = word.toLocaleLowerCase(lang);
    return date ? `${lower}, ${date}` : lower;
  };
}

export interface CompatibilityLineProps {
  result: CompatibilityItemResult;
  /** The car the server matched against, as the garage names it. */
  carName: string | null;
  /** The list says «Подходит»; the card says «Подходит для {автомобиль}». */
  variant: "list" | "card";
  /** «Дополнить автомобиль» — only on a card, and only when a level is missing. */
  onComplete?: () => void;
}

/**
 * The compatibility of an item, **as the server decided it** — the client
 * reads `mark` and `missing` and shows them (D-029, ARCHITECTURE 4.25).
 */
export function CompatibilityLine({
  result,
  carName,
  variant,
  onComplete,
}: CompatibilityLineProps) {
  const { t } = useLanguage();
  const view = compatibilityView(result);
  const mark = compatibilityMarkOf(view);
  if (!mark) return null;

  if (view.kind === "doesNotFit" && variant === "card") {
    return (
      <Banner tone="danger" icon="circleX">
        {t("compat.doesNotFit", { car: carName ?? "" })}
      </Banner>
    );
  }

  return (
    <View style={styles.compat}>
      <CompatibilityMark value={mark}>{markText(view)}</CompatibilityMark>
      {view.kind === "needsDetails" && variant === "card" && onComplete && (
        <Button variant="text" size="m" onPress={onComplete} style={styles.completeButton}>
          {t("compat.completeCar")}
        </Button>
      )}
    </View>
  );

  function markText(current: CompatibilityView): string {
    switch (current.kind) {
      case "fits":
        return variant === "card" && carName
          ? t("compat.fitsFor", { car: carName })
          : t("compat.fits");
      case "needsDetails":
        // In Kazakh the parameter opens the sentence, so the finished line
        // is capitalised rather than the word in the dictionary (which is
        // also used mid-sentence).
        return sentenceCase(
          t("compat.needsDetails", {
            level: current.level ? t(COMPATIBILITY_LEVEL_TEXT[current.level]) : "",
          }),
        );
      case "doesNotFit":
        return t("compat.doesNotFit", { car: carName ?? "" });
      default:
        return t("compat.notSpecified");
    }
  }
}

function sentenceCase(text: string): string {
  return text.length === 0 ? text : text[0]?.toUpperCase() + text.slice(1);
}

export function ItemPhoto({
  photo,
  icon,
  side = size.thumbnail,
}: {
  photo: ItemPhotoImage | null;
  icon: CategoryIconName | null;
  side?: number;
}) {
  const { theme } = useTheme();
  if (photo) {
    return (
      <Image
        source={{ uri: photo.thumbUrl }}
        accessibilityIgnoresInvertColors
        style={[styles.photo, { width: side, height: side }]}
      />
    );
  }
  return (
    <View
      style={[
        styles.photo,
        styles.placeholder,
        { width: side, height: side, backgroundColor: theme.colors.surfaceRaised },
      ]}
    >
      <CategoryIcon name={icon} size={28} color="textMuted" />
    </View>
  );
}

export interface ItemRowProps {
  name: string;
  brand: string | null;
  article: string | null;
  photo: ItemPhotoImage | null;
  icon: CategoryIconName | null;
  keyAttributes: ShowcaseAttributeValue[];
  compatibility: CompatibilityItemResult;
  carName: string | null;
  offers: ShowcaseOfferSummary;
  cityName: string | null;
  first?: boolean;
  onPress: () => void;
}

/** A row of the list (DESIGN 7.8: rows, not tiles; the name up to three lines). */
export function ItemRow({
  name,
  brand,
  article,
  photo,
  icon,
  keyAttributes,
  compatibility,
  carName,
  offers,
  cityName,
  first,
  onPress,
}: ItemRowProps) {
  const { t, tn } = useLanguage();
  const { theme } = useTheme();
  const receiptText = useReceiptText();
  const subtitle = [brand, article].filter((part): part is string => Boolean(part)).join(" · ");
  const characteristics = keyAttributes.map((value) => value.display.text).join(" · ");
  const nearest = receiptText(offers.nearestReceipt);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? theme.colors.surfaceRaised : theme.colors.surface,
          borderTopColor: theme.colors.border,
          borderTopWidth: first ? 0 : 1,
        },
      ]}
    >
      <ItemPhoto photo={photo} icon={icon} />
      <View style={styles.rowBody}>
        <Text variant="bodyStrong" numberOfLines={3}>
          {name}
        </Text>
        {subtitle !== "" && (
          <Text variant="bodyS" color="textMuted">
            {subtitle}
          </Text>
        )}
        {characteristics !== "" && (
          <Text variant="caption" color="textMuted">
            {characteristics}
          </Text>
        )}
        <CompatibilityLine result={compatibility} carName={carName} variant="list" />
        <View style={styles.priceLine}>
          <Text variant="priceS">
            {t("catalog.priceFrom", { price: formatTenge(offers.minPrice) })}
          </Text>
          <Text variant="bodyS" color="textMuted">
            · {tn("catalog.offersCount", offers.count)}
          </Text>
        </View>
        <View style={styles.receiptLine}>
          <Icon name="clock" size={16} color="textMuted" />
          <Text variant="caption" color="textMuted">
            {offers.inCity && cityName ? t("catalog.inCity", { city: cityName }) : (nearest ?? "")}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  compat: { gap: 4 },
  completeButton: { alignSelf: "flex-start", paddingHorizontal: 0 },
  photo: { borderRadius: radius.m },
  placeholder: { alignItems: "center", justifyContent: "center" },
  row: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: layout.screenPadding,
    paddingVertical: layout.cardPaddingS,
  },
  rowBody: { flex: 1, gap: 4 },
  priceLine: { flexDirection: "row", alignItems: "baseline", gap: 4, flexWrap: "wrap" },
  receiptLine: { flexDirection: "row", alignItems: "center", gap: 4 },
});

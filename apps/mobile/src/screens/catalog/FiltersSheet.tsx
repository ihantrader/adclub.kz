import type { CategoryAttribute } from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button, Chip, Sheet, Text, TextField } from "../../design-system";
import type { VehicleQuery } from "../../catalog/vehicle-query";
import {
  EMPTY_FILTERS,
  filtersToQuery,
  hasFilters,
  setBoolean,
  setRange,
  toggleBrand,
  toggleOption,
  type FilterState,
} from "../../catalog/filters";
import { useDebounced, useShowcaseTotal } from "../../services/use-catalog";
import { useLanguage } from "../../state/language";

export interface FiltersSheetProps {
  visible: boolean;
  onClose: () => void;
  categoryId: string;
  cityId?: string;
  vehicle: VehicleQuery;
  attributes: CategoryAttribute[];
  brands: { id: string; name: string; count: number }[];
  /** The filters being edited; the list screen owns them so opening the
   * sheet is an ordinary event, not a state to synchronise. */
  draft: FilterState;
  onDraftChange: (update: (current: FilterState) => FilterState) => void;
  onApply: (next: FilterState) => void;
}

/**
 * M-CAT-03 — the filters. Every section but the three fixed ones is built
 * from the description the server gives for the category, so a new
 * characteristic appears here without a release. «Показать N позиций» is
 * the `total` of a request with the filters being edited, not a count made
 * on the device.
 */
export function FiltersSheet({
  visible,
  onClose,
  categoryId,
  cityId,
  vehicle,
  attributes,
  brands,
  draft,
  onDraftChange: setDraft,
  onApply,
}: FiltersSheetProps) {
  const { t, tn } = useLanguage();

  const filterable = useMemo(
    () =>
      attributes.filter((attribute) => attribute.isFilterable && attribute.valueType !== "text"),
    [attributes],
  );

  const query = filtersToQuery(draft, attributes);
  const settled = useDebounced(JSON.stringify(query), 300);
  const preview = useShowcaseTotal({
    categoryId,
    cityId,
    vehicle,
    filters: JSON.parse(settled) as typeof query,
    enabled: visible,
  });
  const total = preview.data?.total ?? null;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("catalog.filters")}
      closeLabel={t("common.close")}
    >
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        <Group title={t("catalog.availability")}>
          <Chip
            selected={draft.availability === "in_stock"}
            onPress={() =>
              setDraft((current) => ({
                ...current,
                availability: current.availability === "in_stock" ? null : "in_stock",
              }))
            }
          >
            {t("catalog.inStock")}
          </Chip>
          <Chip
            selected={draft.availability === "on_order"}
            onPress={() =>
              setDraft((current) => ({
                ...current,
                availability: current.availability === "on_order" ? null : "on_order",
              }))
            }
          >
            {t("catalog.onOrder")}
          </Chip>
        </Group>

        <Group title={t("catalog.receiving")}>
          <Chip
            selected={draft.receiving === "pickup"}
            onPress={() =>
              setDraft((current) => ({
                ...current,
                receiving: current.receiving === "pickup" ? null : "pickup",
              }))
            }
          >
            {t("catalog.pickup")}
          </Chip>
          <Chip
            selected={draft.receiving === "delivery"}
            onPress={() =>
              setDraft((current) => ({
                ...current,
                receiving: current.receiving === "delivery" ? null : "delivery",
              }))
            }
          >
            {t("catalog.delivery")}
          </Chip>
        </Group>

        <Group title={t("catalog.onlyMyCity")}>
          <Chip
            selected={draft.onlyMyCity}
            onPress={() => setDraft((current) => ({ ...current, onlyMyCity: !current.onlyMyCity }))}
          >
            {t("catalog.onlyMyCity")}
          </Chip>
        </Group>

        {brands.length > 0 && (
          <Group title={t("catalog.brand")}>
            {brands.map((brand) => (
              <Chip
                key={brand.id}
                selected={draft.brandIds.includes(brand.id)}
                onPress={() => setDraft((current) => toggleBrand(current, brand.id))}
              >
                {`${brand.name} (${brand.count})`}
              </Chip>
            ))}
          </Group>
        )}

        {filterable.map((attribute) => (
          <AttributeGroup
            key={attribute.id}
            attribute={attribute}
            draft={draft}
            setDraft={setDraft}
          />
        ))}
      </ScrollView>

      <View style={styles.actions}>
        <Button
          onPress={() => {
            onApply(draft);
            onClose();
          }}
        >
          {total === null ? t("catalog.filters") : tn("catalog.showItems", total)}
        </Button>
        <Button
          variant="text"
          disabled={!hasFilters(draft)}
          onPress={() => setDraft(() => EMPTY_FILTERS)}
        >
          {t("catalog.reset")}
        </Button>
      </View>
    </Sheet>
  );
}

function AttributeGroup({
  attribute,
  draft,
  setDraft,
}: {
  attribute: CategoryAttribute;
  draft: FilterState;
  setDraft: (update: (current: FilterState) => FilterState) => void;
}) {
  const { t } = useLanguage();
  const value = draft.attributes[attribute.id];
  const title = attribute.unit
    ? `${attribute.name.text}, ${attribute.unit.text}`
    : attribute.name.text;

  if (attribute.valueType === "enum") {
    const selected = value?.kind === "options" ? value.optionIds : [];
    return (
      <Group title={title}>
        {attribute.options.map((option) => (
          <Chip
            key={option.id}
            selected={selected.includes(option.id)}
            onPress={() => setDraft((current) => toggleOption(current, attribute.id, option.id))}
          >
            {option.name.text}
          </Chip>
        ))}
      </Group>
    );
  }

  if (attribute.valueType === "bool") {
    const current = value?.kind === "boolean" ? value.value : null;
    return (
      <Group title={title}>
        <Chip
          selected={current === true}
          onPress={() =>
            setDraft((state) => setBoolean(state, attribute.id, current === true ? null : true))
          }
        >
          {t("catalog.yes")}
        </Chip>
        <Chip
          selected={current === false}
          onPress={() =>
            setDraft((state) => setBoolean(state, attribute.id, current === false ? null : false))
          }
        >
          {t("catalog.no")}
        </Chip>
      </Group>
    );
  }

  const range = value?.kind === "range" ? value : { min: null, max: null };
  const bound = (text: string): number | null => {
    const parsed = Number(text.replace(",", "."));
    return text.trim() === "" || Number.isNaN(parsed) ? null : parsed;
  };
  return (
    <Group title={title}>
      <View style={styles.range}>
        <TextField
          label={t("catalog.rangeFrom")}
          keyboardType="numeric"
          value={range.min === null ? "" : String(range.min)}
          onChangeText={(text) =>
            setDraft((state) => setRange(state, attribute.id, { ...range, min: bound(text) }))
          }
        />
      </View>
      <View style={styles.range}>
        <TextField
          label={t("catalog.rangeTo")}
          keyboardType="numeric"
          value={range.max === null ? "" : String(range.max)}
          onChangeText={(text) =>
            setDraft((state) => setRange(state, attribute.id, { ...range, max: bound(text) }))
          }
        />
      </View>
    </Group>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <Text variant="heading" accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.chips}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { maxHeight: 420 },
  group: { gap: 8, paddingVertical: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "flex-end" },
  range: { flexGrow: 1, flexBasis: "45%" },
  actions: { gap: 4, paddingTop: layout.cardPaddingS },
});

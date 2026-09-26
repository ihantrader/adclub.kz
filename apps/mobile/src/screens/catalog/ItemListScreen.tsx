import type { ShowcaseListSort } from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, View } from "react-native";
import {
  Button,
  Chip,
  DataState,
  OfflineBanner,
  Screen,
  Segments,
  SkeletonList,
  useTheme,
} from "../../design-system";
import { useCatalogCar } from "../../catalog/catalog-car-provider";
import {
  EMPTY_FILTERS,
  filterCount,
  filtersToQuery,
  type FilterState,
} from "../../catalog/filters";
import { vehicleQuery } from "../../catalog/vehicle-query";
import { carTitle } from "../../garage/garage";
import { useCategoryAttributes, useShowcaseList } from "../../services/use-catalog";
import { useOnline } from "../../services/use-network";
import { cityIdOf } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useLanguage } from "../../state/language";
import { CatalogHeader } from "./CatalogHeader";
import { FiltersSheet } from "./FiltersSheet";
import { ItemRow } from "./parts";

export interface ItemListScreenProps {
  categoryId: string;
  onOpenItem: (itemId: string) => void;
  onAddCar: () => void;
  /** «Проверить параметры автомобиля» opens the car of the garage. */
  onCheckCar: (carId: string) => void;
  onBack: () => void;
}

/**
 * M-CAT-02 — the items of a subcategory. Everything on screen is the
 * server's answer: which items a car may see (D-029), their marks, their
 * prices and their receipt dates. Paging is the server's cursor, so the
 * list neither loses nor repeats an item while offers change underneath.
 */
export function ItemListScreen({
  categoryId,
  onOpenItem,
  onAddCar,
  onCheckCar,
  onBack,
}: ItemListScreenProps) {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const online = useOnline();
  const { selection } = useCity();
  const { car, showWithoutCar } = useCatalogCar();
  const [sort, setSort] = useState<ShowcaseListSort>("recommended");
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  // The filters being edited live here, not in the sheet: opening the sheet
  // is then an ordinary event instead of a state to synchronise.
  const [draftFilters, setDraftFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [sheet, setSheet] = useState(false);
  const openFilters = () => {
    setDraftFilters(filters);
    setSheet(true);
  };

  const attributes = useCategoryAttributes(categoryId);
  const cityId = cityIdOf(selection);
  const vehicle = vehicleQuery(car);
  const list = useShowcaseList({
    categoryId,
    ...(cityId ? { cityId } : {}),
    vehicle,
    filters: filtersToQuery(filters, attributes.data?.attributes ?? []),
    sort,
  });

  // Back on the screen after longer than the server's own cache window: the
  // price shown could have changed (ARCHITECTURE 4.29).
  useFocusEffect(
    useCallback(() => {
      list.reloadIfStale();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const page = list.page;
  const count = filterCount(filters);
  const carName = car ? carTitle(car) : null;
  const cityName = page?.city?.name.text ?? null;

  const status =
    !online && page === null
      ? "offline"
      : list.status === "loading"
        ? "loading"
        : list.status === "error"
          ? "error"
          : list.items.length === 0
            ? "empty"
            : "ready";

  return (
    <Screen
      title={page?.category.name.text ?? t("tabs.catalog")}
      back={{ label: t("common.back"), onPress: onBack }}
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      refreshing={list.refreshing}
      refreshingLabel={t("common.loading")}
      scroll={false}
      header={
        <>
          <CatalogHeader onAddCar={onAddCar} />
          <View style={styles.controls}>
            <Segments
              label={t("catalog.sort")}
              value={sort}
              onChange={setSort}
              options={[
                { value: "recommended", label: t("catalog.sort.recommended") },
                { value: "cheaper", label: t("catalog.sort.cheaper") },
                { value: "faster", label: t("catalog.sort.faster") },
              ]}
            />
            <View style={styles.filterRow}>
              <Chip icon="settings" selected={count > 0} onPress={openFilters}>
                {count > 0 ? t("catalog.filtersCount", { n: count }) : t("catalog.filters")}
              </Chip>
              {count > 0 && (
                <Button variant="text" size="m" onPress={() => setFilters(EMPTY_FILTERS)}>
                  {t("catalog.reset")}
                </Button>
              )}
            </View>
          </View>
        </>
      }
    >
      <DataState
        status={status}
        skeleton={<SkeletonList rows={5} label={t("common.loading")} />}
        error={errorState()}
        offline={{
          title: t("state.offline"),
          text: t("state.offlineText"),
          action: (
            <Button variant="secondary" size="m" icon="refresh" onPress={list.reload}>
              {t("common.retry")}
            </Button>
          ),
        }}
        empty={emptyState()}
      >
        <FlatList
          data={list.items}
          keyExtractor={(item) => item.id}
          onEndReachedThreshold={0.4}
          onEndReached={() => list.hasMore && list.loadMore()}
          ListFooterComponent={
            list.loadingMore ? (
              <ActivityIndicator style={styles.more} color={theme.colors.accent} />
            ) : null
          }
          renderItem={({ item, index }) => (
            <ItemRow
              first={index === 0}
              name={item.name.text}
              brand={item.brand?.name ?? null}
              article={item.article}
              photo={item.photo}
              icon={null}
              keyAttributes={item.keyAttributes}
              compatibility={item.compatibility}
              carName={carName}
              offers={item.offers}
              cityName={cityName}
              onPress={() => onOpenItem(item.id)}
            />
          )}
        />
      </DataState>

      <FiltersSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        categoryId={categoryId}
        {...(cityId ? { cityId } : {})}
        vehicle={vehicle}
        attributes={attributes.data?.attributes ?? []}
        brands={page?.brands ?? []}
        draft={draftFilters}
        onDraftChange={setDraftFilters}
        onApply={setFilters}
      />
    </Screen>
  );

  function errorState() {
    if (list.failure === "rate_limited") {
      return {
        title: t("state.tooManyRequests"),
        text: t("state.tooManyRequestsText"),
        retry: { label: t("common.retry"), onRetry: list.reload },
      };
    }
    if (list.failure === "vehicle") {
      // The car no longer makes sense to the server (an entry of the vehicle
      // catalog was removed): showing everything is better than a dead end.
      return {
        title: t("state.errorTitle"),
        text: t("catalog.emptyVehicleText"),
        retry: { label: t("catalog.showAll"), onRetry: showWithoutCar },
      };
    }
    return {
      title: t("state.errorTitle"),
      text: t("state.errorText"),
      retry: { label: t("common.retry"), onRetry: list.reload },
    };
  }

  function emptyState() {
    switch (page?.empty) {
      case "vehicle":
        return {
          icon: "car" as const,
          title: t("catalog.emptyVehicle", { car: carName ?? "" }),
          text: t("catalog.emptyVehicleText"),
          action: (
            <View style={styles.emptyActions}>
              <Button variant="secondary" size="m" onPress={showWithoutCar}>
                {t("catalog.showAll")}
              </Button>
              {car && (
                <Button variant="text" size="m" onPress={() => onCheckCar(car.id)}>
                  {t("catalog.checkCar")}
                </Button>
              )}
            </View>
          ),
        };
      case "filters":
        return {
          icon: "settings" as const,
          title: t("catalog.emptyFilters"),
          action: (
            <Button variant="secondary" size="m" onPress={() => setFilters(EMPTY_FILTERS)}>
              {t("catalog.resetFilters")}
            </Button>
          ),
        };
      case "city_required":
        return {
          icon: "mapPin" as const,
          title: t("catalog.emptyCity"),
          text: t("city.servicesNote"),
        };
      default:
        return {
          icon: "package" as const,
          title: t("catalog.emptyItems"),
          text: t("catalog.emptyItemsText"),
        };
    }
  }
}

const styles = StyleSheet.create({
  controls: { gap: 8, paddingHorizontal: layout.screenPadding, paddingBottom: 8 },
  filterRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  more: { paddingVertical: layout.cardPadding },
  emptyActions: { gap: 4, alignItems: "center" },
});

import type { ShowcaseListSort } from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, View } from "react-native";
import {
  Button,
  Chip,
  DataState,
  IconButton,
  OfflineBanner,
  Screen,
  Segments,
  SkeletonList,
  useDelayedIndicator,
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
import { categoryIconOf } from "../../catalog/category-icon";
import {
  useCategoryAttributes,
  useCategoryTree,
  useDebounced,
  useShowcaseList,
  useShowcaseTotal,
} from "../../services/use-catalog";
import { useOnline } from "../../services/use-network";
import { cityIdOf } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useLanguage } from "../../state/language";
import { CitySheet } from "../CitySheet";
import { CatalogHeader } from "./CatalogHeader";
import { FiltersSheet } from "./FiltersSheet";
import { ItemRow, SORT_HINT, SORT_TEXT } from "./parts";

const LIST_SORTS: ShowcaseListSort[] = ["recommended", "cheaper", "faster"];

export interface ItemListScreenProps {
  categoryId: string;
  /** The name the previous screen already showed: the top bar has it before the data does. */
  title?: string;
  /** What the previous screen knew of the subcategory; the answer's `category.kind` decides. */
  kind?: "goods" | "services";
  /** The name is passed on so the card's top bar has it while the card loads. */
  onOpenItem: (item: { id: string; name: string }) => void;
  onAddCar: () => void;
  /** «Проверить параметры автомобиля» opens the car of the garage. */
  onCheckCar: (carId: string) => void;
  onBack: () => void;
  /** M-CAT-04: the search icon of the top bar (TASK-044). */
  onSearch?: () => void;
}

/**
 * M-CAT-02 — the items of a subcategory. Everything on screen is the
 * server's answer: which items a car may see (D-029), their marks, their
 * prices and their receipt dates. Paging is the server's cursor, so the
 * list neither loses nor repeats an item while offers change underneath.
 *
 * The pinned header is short (TASK-078 M10): the car and the city, then the
 * sorts with «Фильтры (N)» on the same line, and one line of what the sort
 * means. The rows make one card group inside the fields of the screen (M9).
 *
 * The list does not jump. Changing the sort or the filters keeps the rows
 * on screen under the refresh line until the new ones arrive, and only then
 * — a reason: the order is new — goes back to the top; a reload of the same
 * list, one more page, opening the filters, none of them moves the reader.
 */
export function ItemListScreen({
  categoryId,
  title,
  kind,
  onOpenItem,
  onAddCar,
  onCheckCar,
  onBack,
  onSearch,
}: ItemListScreenProps) {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const online = useOnline();
  const { selection } = useCity();
  const { car } = useCatalogCar();
  const [citySheet, setCitySheet] = useState(false);
  const [sort, setSort] = useState<ShowcaseListSort>("recommended");
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  // The filters being edited live here, not in the sheet: opening the sheet
  // is then an ordinary event instead of a state to synchronise.
  const [draftFilters, setDraftFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [sheet, setSheet] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const openFilters = () => {
    setDraftFilters(filters);
    setSheet(true);
  };

  const attributes = useCategoryAttributes(categoryId);
  // The placeholder of an item without a photo is the icon of its category (DESIGN 7.8).
  const placeholderIcon = categoryIconOf(useCategoryTree().data?.categories, categoryId);
  const cityId = cityIdOf(selection);
  const vehicle = vehicleQuery(car);
  const list = useShowcaseList({
    categoryId,
    ...(cityId ? { cityId } : {}),
    vehicle,
    filters: filtersToQuery(filters, attributes.data?.attributes ?? []),
    sort,
  });
  // «Показать N позиций» of the sheet: the total of the filters being edited.
  const settledDraft = useDebounced(
    JSON.stringify(filtersToQuery(draftFilters, attributes.data?.attributes ?? [])),
    300,
  );
  const preview = useShowcaseTotal({
    categoryId,
    ...(cityId ? { cityId } : {}),
    vehicle,
    filters: JSON.parse(settledDraft) as ReturnType<typeof filtersToQuery>,
    enabled: sheet,
  });

  // Back on the screen after longer than the server's own cache window: the
  // price shown could have changed (ARCHITECTURE 4.29).
  useFocusEffect(
    useCallback(() => {
      list.reloadIfStale();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // The spinner under the rows only when the next page takes a while (D-069).
  const moreIndicator = useDelayedIndicator(list.loadingMore);

  // A new list took the place of the old one: back to its first row, in the
  // same frame as the swap. Nothing else scrolls the list (see `generation`).
  const listRef = useRef<FlatList>(null);
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [list.generation]);

  const page = list.page;
  const count = filterCount(filters);
  const carName = carTitle(car);
  const cityName = page?.city?.name.text ?? null;
  // Services (TASK-019): by a city, at the price for the car's model; no
  // availability, receipt or brand — so no filters and no «Быстрее».
  const services = (page?.category.kind ?? kind) === "services";
  const sorts = services ? LIST_SORTS.filter((value) => value !== "faster") : LIST_SORTS;

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
      title={page?.category.name.text ?? title ?? t("tabs.catalog")}
      back={{ label: t("common.back"), onPress: onBack }}
      actions={
        onSearch ? <IconButton icon="search" label={t("search.open")} onPress={onSearch} /> : null
      }
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      refreshing={list.refreshing}
      refreshingLabel={t("common.loading")}
      // Another sort or other filters: the new rows fade in over the old ones.
      contentKey={list.generation}
      scroll={false}
      scrolled={scrolled}
      header={
        <>
          <CatalogHeader onAddCar={onAddCar} services={services} />
          <View style={styles.controls}>
            <View style={styles.sortRow}>
              <View style={styles.sortCell}>
                <Segments
                  label={t("catalog.sort")}
                  value={sort}
                  onChange={setSort}
                  options={sorts.map((value) => ({
                    value,
                    label: t(SORT_TEXT[value]),
                    hint: t(SORT_HINT[value]),
                  }))}
                />
              </View>
              {!services && (
                <View style={styles.filterChip}>
                  <Chip icon="filters" selected={count > 0} onPress={openFilters}>
                    {count > 0 ? t("catalog.filtersCount", { n: count }) : t("catalog.filters")}
                  </Chip>
                </View>
              )}
            </View>
          </View>
        </>
      }
    >
      <DataState
        status={status}
        skeleton={
          <View style={styles.list}>
            <SkeletonList rows={5} label={t("common.loading")} />
          </View>
        }
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
          ref={listRef}
          data={list.items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 4)}
          scrollEventThrottle={32}
          onEndReachedThreshold={0.4}
          onEndReached={() => list.hasMore && list.loadMore()}
          ListFooterComponent={
            moreIndicator ? (
              <ActivityIndicator style={styles.more} color={theme.colors.accent} />
            ) : null
          }
          renderItem={({ item, index }) => (
            <ItemRow
              {...(services ? { serviceModel: car.model.label } : {})}
              first={index === 0}
              last={index === list.items.length - 1}
              name={item.name.text}
              brand={item.brand?.name ?? null}
              article={item.article}
              photo={item.photo}
              icon={placeholderIcon}
              keyAttributes={item.keyAttributes}
              compatibility={item.compatibility}
              carName={carName}
              offers={item.offers}
              cityName={cityName}
              onPress={() => onOpenItem({ id: item.id, name: item.name.text })}
            />
          )}
        />
      </DataState>

      <FiltersSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        total={preview.data?.total ?? null}
        attributes={attributes.data?.attributes ?? []}
        brands={page?.brands ?? []}
        draft={draftFilters}
        onDraftChange={setDraftFilters}
        onApply={setFilters}
      />
      <CitySheet visible={citySheet} onClose={() => setCitySheet(false)} services />
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
      // catalog was removed). There is no catalog without a car (D-062), so the
      // way out is the car itself: its card, where it can be completed again.
      return {
        title: t("state.errorTitle"),
        text: t("catalog.emptyVehicleText"),
        retry: { label: t("catalog.checkCar"), onRetry: () => onCheckCar(car.id) },
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
        // Nothing fits this car yet. There is no way to look at what does not
        // (D-062); the useful things are to check the car's parameters — an
        // engine or a generation that was left out narrows the list — or to
        // pick another car with the switch at the top of this same screen.
        return {
          icon: "car" as const,
          title: t("catalog.emptyVehicle", { car: carName }),
          text: t("catalog.emptyVehicleText"),
          action: (
            <Button variant="secondary" size="m" onPress={() => onCheckCar(car.id)}>
              {t("catalog.checkCar")}
            </Button>
          ),
        };
      case "filters":
        return {
          icon: "filters" as const,
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
          action: (
            <Button variant="secondary" size="m" onPress={() => setCitySheet(true)}>
              {t("catalog.chooseCity")}
            </Button>
          ),
        };
      case "no_items":
        // A service that no point of the city offers (SCREENS 2.2: «Пусто в
        // выбранном городе — Выбрать другой город»).
        if (services && cityName) {
          return {
            icon: "mapPin" as const,
            title: t("catalog.emptyServiceCity", { city: cityName }),
            action: (
              <Button variant="secondary" size="m" onPress={() => setCitySheet(true)}>
                {t("catalog.chooseOtherCity")}
              </Button>
            ),
          };
        }
        return {
          icon: "package" as const,
          title: t("catalog.emptyItems"),
          text: t("catalog.emptyItemsText"),
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
  controls: { paddingHorizontal: layout.screenPadding, paddingTop: 8 },
  sortRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  // The segments take what the chip leaves and scroll inside it; the hint ends in an ellipsis.
  sortCell: { flex: 1, minWidth: 0 },
  filterChip: { paddingTop: 2 },
  // The rows are a card group inside the fields of the screen (M9).
  list: { paddingHorizontal: layout.screenPadding, paddingTop: 12, paddingBottom: layout.blockGap },
  more: { paddingVertical: layout.cardPadding },
});

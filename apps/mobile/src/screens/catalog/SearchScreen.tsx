import type { CatalogSearchCategory, CatalogSearchItem } from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  CategoryIcon,
  Chip,
  DataState,
  ListGroup,
  ListRow,
  OfflineBanner,
  Screen,
  SearchField,
  Section,
  SkeletonList,
  Text,
  useDelayedIndicator,
  useTheme,
} from "../../design-system";
import { useCatalogCar } from "../../catalog/catalog-car-provider";
import { categoryIconOf } from "../../catalog/category-icon";
import {
  EMPTY_FILTERS,
  filterCount,
  filtersToQuery,
  hasFilters,
  type FilterQuery,
  type FilterState,
} from "../../catalog/filters";
import { joinDot } from "../../catalog/format";
import { rememberSearch, tidyQuery } from "../../catalog/recent-searches";
import { vehicleQuery } from "../../catalog/vehicle-query";
import { carTitle } from "../../garage/garage";
import { useCategoryAttributes, useCategoryTree, useDebounced } from "../../services/use-catalog";
import { useOnline } from "../../services/use-network";
import { useSearchResults, useSearchSuggestions, useSearchTotal } from "../../services/use-search";
import { cityIdOf } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useGarage } from "../../state/garage-provider";
import { useLanguage } from "../../state/language";
import { recentSearchesStore } from "../../state/stores";
import { CitySheet } from "../CitySheet";
import { CarSheet } from "./CarSheet";
import { CatalogHeader } from "./CatalogHeader";
import { FiltersSheet } from "./FiltersSheet";
import { ItemRow } from "./parts";

/** How long typing has to pause before the suggestions are asked for (M-CAT-04). */
const SUGGEST_AFTER_MS = 300;

export interface SearchScreenProps {
  onBack: () => void;
  onOpenItem: (item: { id: string; name: string }) => void;
  /** A node opens its subcategories, a subcategory its list. */
  onOpenCategory: (category: CatalogSearchCategory) => void;
  onAddCar: () => void;
}

/**
 * M-CAT-04 — the search of the catalog (TASK-044; ARCHITECTURE 4.64).
 *
 * - The header is the catalog's: the car and the city first, then the field,
 *   in the order of M-CAT-01 — the field does not jump when the search opens
 *   (TASK-078).
 * - Before typing: the recent queries of this device (at most ten,
 *   «Очистить»).
 * - Typing: after a pause, the server's suggestions — the article first,
 *   then categories, then items, and «Найти «…»» last; the keyboard's search
 *   key runs the search too. Every suggestion row keeps the icon column, so
 *   their texts stand in one line.
 * - The results: rows of M-CAT-02 for the car and the city of the header,
 *   with the marks of compatibility; T-CAT-08 when the server read the
 *   query otherwise (a typo forgiven, TASK-045); pages as the list scrolls.
 * - The chips of the subcategories of the results with their numbers
 *   (TASK-045, the server's facets): one keeps its items; then «Фильтры» —
 *   the sheet of M-CAT-03 with the numbers at the values, «Показать N
 *   позиций», «Сбросить».
 * - Nothing found: «Ничего не нашли по «…»», the tips — and, instead of the
 *   cancelled «Искать без фильтра по автомобилю» (D-062), «Искать для
 *   другого автомобиля из гаража»: the car switch of the header.
 * - Offline: «Нужна сеть» — the search is the server's.
 */
export function SearchScreen({ onBack, onOpenItem, onOpenCategory, onAddCar }: SearchScreenProps) {
  const { t, tn } = useLanguage();
  const { theme } = useTheme();
  const online = useOnline();
  const { selection } = useCity();
  const { car, chooseCar } = useCatalogCar();
  const { cars } = useGarage();
  const tree = useCategoryTree();
  const recent = useSyncExternalStore(recentSearchesStore.subscribe, recentSearchesStore.get);
  const [text, setText] = useState("");
  const [ran, setSubmitted] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"car" | "city" | "filters" | null>(null);
  const [scrolled, setScrolled] = useState(false);
  // The chip of a subcategory and its filters (TASK-045): a new query starts without them.
  const [category, setCategory] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [draftFilters, setDraftFilters] = useState<FilterState>(EMPTY_FILTERS);

  const typed = tidyQuery(text);
  // The search that was run, while the query is still the one it was run for:
  // editing the query goes back to the suggestions.
  const submitted = ran !== null && ran === typed ? ran : null;
  const settled = useDebounced(typed, SUGGEST_AFTER_MS);
  const cityId = cityIdOf(selection);
  const options = { ...(cityId ? { cityId } : {}), vehicle: vehicleQuery(car) };
  const attributes = useCategoryAttributes(category);
  const described = attributes.data?.attributes ?? [];
  const suggestions = useSearchSuggestions(
    submitted === null && online && settled.length >= 2 && settled === typed ? settled : null,
    options,
  );
  const results = useSearchResults(online ? submitted : null, {
    ...options,
    ...(category ? { categoryId: category, filters: filtersToQuery(filters, described) } : {}),
  });
  const settledDraft = useDebounced(JSON.stringify(filtersToQuery(draftFilters, described)), 300);
  const preview = useSearchTotal(
    submitted,
    {
      ...options,
      ...(category
        ? { categoryId: category, filters: JSON.parse(settledDraft) as FilterQuery }
        : {}),
    },
    online && sheet === "filters" && category !== null,
  );
  const moreIndicator = useDelayedIndicator(results.loadingMore);
  const carName = carTitle(car);

  const run = (query: string) => {
    const tidy = tidyQuery(query);
    if (tidy.length < 2) return;
    recentSearchesStore.set(rememberSearch(recentSearchesStore.get(), tidy));
    setText(tidy);
    setSubmitted(tidy);
    chooseCategory(null);
  };

  const chooseCategory = (id: string | null) => {
    setCategory(id);
    setFilters(EMPTY_FILTERS);
  };
  const openFilters = () => {
    setDraftFilters(filters);
    setSheet("filters");
  };

  const iconOf = (item: CatalogSearchItem) =>
    categoryIconOf(tree.data?.categories, item.category.id);
  const openItem = (item: CatalogSearchItem) => {
    if (typed.length >= 2)
      recentSearchesStore.set(rememberSearch(recentSearchesStore.get(), typed));
    onOpenItem({ id: item.id, name: item.name.text });
  };
  const onScroll = (y: number) => setScrolled(y > 4);

  const header = (
    <>
      <CatalogHeader onAddCar={onAddCar} />
      <View style={styles.field}>
        <SearchField
          label={t("search.label")}
          placeholder={t("search.placeholder")}
          value={text}
          onChangeText={setText}
          clearLabel={t("search.clearField")}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          onSubmitEditing={() => run(text)}
        />
      </View>
    </>
  );

  return (
    <Screen
      title={t("search.title")}
      back={{ label: t("common.back"), onPress: onBack }}
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      refreshing={submitted !== null && results.first.refreshing}
      refreshingLabel={t("common.loading")}
      scroll={false}
      scrolled={scrolled}
      header={header}
    >
      {!online && typed.length >= 2 ? (
        <DataState
          status="offline"
          skeleton={null}
          error={{ title: t("state.errorTitle") }}
          empty={{ icon: "search", title: "" }}
          offline={{ title: t("search.needsNetwork"), text: t("search.needsNetworkText") }}
        >
          {null}
        </DataState>
      ) : submitted !== null ? (
        renderResults()
      ) : typed.length >= 2 ? (
        renderSuggestions()
      ) : (
        renderRecent()
      )}
      <CarSheet
        visible={sheet === "car"}
        onClose={() => setSheet(null)}
        onPickCar={chooseCar}
        onAddCar={onAddCar}
      />
      <CitySheet visible={sheet === "city"} onClose={() => setSheet(null)} services />
      <FiltersSheet
        visible={sheet === "filters"}
        onClose={() => setSheet(null)}
        total={preview.data?.total ?? null}
        counts={preview.data?.facets.attributes ?? results.first.data?.facets.attributes ?? []}
        attributes={described}
        brands={results.first.data?.facets.brands ?? []}
        draft={draftFilters}
        onDraftChange={setDraftFilters}
        onApply={setFilters}
      />
    </Screen>
  );

  function renderRecent() {
    if (recent.length === 0) {
      return (
        <View style={styles.body}>
          <Text variant="body" color="textMuted">
            {t("search.recentEmpty")}
          </Text>
        </View>
      );
    }
    return (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.body}
        onScroll={(event) => onScroll(event.nativeEvent.contentOffset.y)}
        scrollEventThrottle={32}
      >
        <Section
          first
          title={t("search.recent")}
          action={
            <Button variant="text" size="m" onPress={() => recentSearchesStore.set([])}>
              {t("search.recentClear")}
            </Button>
          }
        >
          <ListGroup>
            {recent.map((query, index) => (
              <ListRow
                key={query}
                first={index === 0}
                icon="clock"
                title={query}
                onPress={() => run(query)}
              />
            ))}
          </ListGroup>
        </Section>
      </ScrollView>
    );
  }

  function renderSuggestions() {
    const answer = suggestions.data;
    const byArticle = (answer?.items ?? []).filter((item) => item.match === "article");
    const others = (answer?.items ?? []).filter((item) => item.match !== "article");
    return (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.body}
        onScroll={(event) => onScroll(event.nativeEvent.contentOffset.y)}
        scrollEventThrottle={32}
      >
        {answer?.usedQuery && (
          <Text variant="bodyS" color="textMuted" style={styles.note}>
            {t("search.usedQuery", { query: answer.usedQuery })}
          </Text>
        )}
        {byArticle.length > 0 && (
          <SuggestionGroup title={t("search.byArticle")} first>
            {byArticle.map((item, index) => (
              <ListRow
                key={item.id}
                first={index === 0}
                iconSlot
                title={joinDot([item.article, item.brand?.name, item.category.name.text])}
                subtitle={item.name.text}
                navigates
                onPress={() => openItem(item)}
              />
            ))}
          </SuggestionGroup>
        )}
        {(answer?.categories.length ?? 0) > 0 && (
          <SuggestionGroup title={t("search.categories")} first={byArticle.length === 0}>
            {answer!.categories.map((category, index) => (
              <ListRow
                key={category.id}
                first={index === 0}
                leading={
                  <CategoryIcon
                    name={categoryIconOf(tree.data?.categories, category.id)}
                    size={24}
                    color="textMuted"
                  />
                }
                title={category.name.text}
                {...(category.parentName ? { subtitle: category.parentName.text } : {})}
                navigates
                onPress={() => onOpenCategory(category)}
              />
            ))}
          </SuggestionGroup>
        )}
        {others.length > 0 && (
          <SuggestionGroup
            title={t("search.items")}
            first={byArticle.length === 0 && (answer?.categories.length ?? 0) === 0}
          >
            {others.map((item, index) => (
              <ListRow
                key={item.id}
                first={index === 0}
                iconSlot
                title={item.name.text}
                subtitle={joinDot([item.brand?.name, item.article])}
                navigates
                onPress={() => openItem(item)}
              />
            ))}
          </SuggestionGroup>
        )}
        {/* «Найти «…»» — the last row: the exact article comes first (SCREENS M-CAT-04). */}
        <View style={styles.find}>
          <ListGroup>
            <ListRow
              first
              icon="search"
              title={t("search.find", { query: typed })}
              onPress={() => run(typed)}
            />
          </ListGroup>
        </View>
      </ScrollView>
    );
  }

  function renderResults() {
    const answer = results.first.data;
    const status =
      results.first.status === "loading" || (results.first.status === "idle" && !answer)
        ? "loading"
        : results.first.status === "error" && !answer
          ? results.first.failure === "network"
            ? "offline"
            : "error"
          : (answer?.total ?? 0) === 0
            ? "empty"
            : "ready";
    return (
      <DataState
        status={status}
        skeleton={
          <View style={styles.body}>
            <SkeletonList rows={5} label={t("common.loading")} />
          </View>
        }
        error={{
          title:
            results.first.failure === "rate_limited"
              ? t("state.tooManyRequests")
              : t("state.errorTitle"),
          text:
            results.first.failure === "rate_limited"
              ? t("state.tooManyRequestsText")
              : t("state.errorText"),
          retry: { label: t("common.retry"), onRetry: results.first.reload },
        }}
        offline={{ title: t("search.needsNetwork"), text: t("search.needsNetworkText") }}
        empty={emptyState()}
      >
        <FlatList
          data={results.items}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.body}
          onScroll={(event) => onScroll(event.nativeEvent.contentOffset.y)}
          scrollEventThrottle={32}
          onEndReachedThreshold={0.4}
          onEndReached={() => results.hasMore && results.loadMore()}
          ListHeaderComponent={resultsHead()}
          ListFooterComponent={
            moreIndicator ? (
              <ActivityIndicator style={styles.more} color={theme.colors.accent} />
            ) : null
          }
          renderItem={({ item, index }) => (
            <ItemRow
              {...(item.type === "service" ? { serviceModel: car.model.label } : {})}
              first={index === 0}
              last={index === results.items.length - 1}
              name={item.name.text}
              brand={item.brand?.name ?? null}
              article={item.article}
              photo={item.photo}
              icon={iconOf(item)}
              keyAttributes={item.keyAttributes}
              compatibility={item.compatibility}
              carName={carName}
              offers={item.offers}
              cityName={answer?.city?.name.text ?? null}
              onPress={() => openItem(item)}
            />
          )}
        />
      </DataState>
    );
  }

  function resultsHead() {
    const answer = results.first.data;
    if (!answer) return null;
    return (
      <View style={styles.head}>
        {answer.usedQuery && (
          <Banner tone="neutral" icon="info">
            {t("search.usedQuery", { query: answer.usedQuery })}
          </Banner>
        )}
        {answer.cityRequired && (
          <Banner
            tone="neutral"
            icon="mapPin"
            action={
              <Button variant="text" size="m" onPress={() => setSheet("city")}>
                {t("catalog.chooseCity")}
              </Button>
            }
          >
            {t("search.servicesNeedCity")}
          </Banner>
        )}
        {answer.facets.categories.length > 1 || category !== null ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.chipRow}
          >
            <Chip selected={category === null} onPress={() => chooseCategory(null)}>
              {t("search.allCategories")}
            </Chip>
            {answer.facets.categories.map((facet) => (
              <Chip
                key={facet.id}
                selected={category === facet.id}
                onPress={() => chooseCategory(category === facet.id ? null : facet.id)}
              >
                {joinDot([facet.name.text, String(facet.count)])}
              </Chip>
            ))}
          </ScrollView>
        ) : null}
        {/* Services have no filters (as their list, TASK-019). */}
        {answer.facets.categories.find((facet) => facet.id === category)?.kind === "goods" ? (
          <View style={styles.chips}>
            <Chip icon="filters" selected={filterCount(filters) > 0} onPress={openFilters}>
              {filterCount(filters) > 0
                ? t("catalog.filtersCount", { n: filterCount(filters) })
                : t("catalog.filters")}
            </Chip>
          </View>
        ) : null}
        <Text variant="bodyS" color="textMuted">
          {tn("search.found", answer.total)}
        </Text>
      </View>
    );
  }

  function emptyState() {
    const answer = results.first.data;
    const query = answer?.usedQuery ?? submitted ?? "";
    if (category !== null && hasFilters(filters)) {
      return {
        icon: "filters" as const,
        title: t("catalog.emptyFilters"),
        action: (
          <Button variant="secondary" size="m" onPress={() => setFilters(EMPTY_FILTERS)}>
            {t("catalog.resetFilters")}
          </Button>
        ),
      };
    }
    if (answer?.empty === "city_required") {
      return {
        icon: "mapPin" as const,
        title: t("search.emptyTitle", { query }),
        text: t("search.servicesNeedCity"),
        action: (
          <Button variant="secondary" size="m" onPress={() => setSheet("city")}>
            {t("catalog.chooseCity")}
          </Button>
        ),
      };
    }
    // D-062: no «search without the car» — another car of the garage instead.
    const otherCar =
      cars.length > 1 ? (
        <Button variant="secondary" size="m" icon="car" onPress={() => setSheet("car")}>
          {t("search.otherCar")}
        </Button>
      ) : undefined;
    return {
      icon: "search" as const,
      title: t("search.emptyTitle", { query }),
      text:
        answer?.empty === "vehicle"
          ? t("search.emptyVehicle", { car: carName })
          : t("search.emptyTips"),
      ...(otherCar ? { action: otherCar } : {}),
    };
  }
}

/** A group of suggestions: a muted caption, then a card group of rows. */
function SuggestionGroup({
  title,
  first,
  children,
}: {
  title: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={[styles.group, first && styles.groupFirst]}>
      <Text variant="bodyS" color="textMuted" style={styles.groupTitle}>
        {title}
      </Text>
      <ListGroup>{children}</ListGroup>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { paddingHorizontal: layout.screenPadding, paddingTop: 8 },
  body: { paddingHorizontal: layout.screenPadding, paddingTop: 12, paddingBottom: layout.blockGap },
  note: { paddingBottom: 8 },
  group: { paddingTop: 16 },
  groupFirst: { paddingTop: 0 },
  groupTitle: { paddingBottom: 8 },
  find: { paddingTop: 16 },
  head: { gap: 12, paddingBottom: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipRow: { flexDirection: "row", gap: 8 },
  more: { paddingVertical: layout.cardPadding },
});

import type { CatalogSearchCategory, CatalogSearchItem } from "@adclub/contracts";
import { layout, size } from "@adclub/ui-core";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  Chip,
  DataState,
  ListRow,
  OfflineBanner,
  Screen,
  SearchField,
  SkeletonList,
  Text,
  useDelayedIndicator,
  useTheme,
} from "../../design-system";
import { useCatalogCar } from "../../catalog/catalog-car-provider";
import { categoryIconOf } from "../../catalog/category-icon";
import { rememberSearch, tidyQuery } from "../../catalog/recent-searches";
import { vehicleQuery } from "../../catalog/vehicle-query";
import { carTitle } from "../../garage/garage";
import { useCategoryTree, useDebounced } from "../../services/use-catalog";
import { useOnline } from "../../services/use-network";
import { useSearchResults, useSearchSuggestions } from "../../services/use-search";
import { cityIdOf } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useGarage } from "../../state/garage-provider";
import { useLanguage } from "../../state/language";
import { recentSearchesStore } from "../../state/stores";
import { CitySheet } from "../CitySheet";
import { CarSheet } from "./CarSheet";
import { CatalogHeader } from "./CatalogHeader";
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
 * - Before typing: the recent queries of this device (at most ten,
 *   «Очистить»).
 * - Typing: after a pause, the server's suggestions — the article first,
 *   then categories, then items; «Найти «…»» or the keyboard's search key
 *   runs the search.
 * - The results: rows of M-CAT-02 for the car and the city of the header,
 *   with the marks of compatibility; T-CAT-08 when the server read the
 *   query otherwise; pages as the list scrolls.
 * - Nothing found: «Ничего не нашли по „…“», the tips — and, instead of the
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
  const [sheet, setSheet] = useState<"car" | "city" | null>(null);

  const typed = tidyQuery(text);
  // The search that was run, while the query is still the one it was run for:
  // editing the query goes back to the suggestions.
  const submitted = ran !== null && ran === typed ? ran : null;
  const settled = useDebounced(typed, SUGGEST_AFTER_MS);
  const cityId = cityIdOf(selection);
  const options = { ...(cityId ? { cityId } : {}), vehicle: vehicleQuery(car) };
  const suggestions = useSearchSuggestions(
    submitted === null && online && settled.length >= 2 && settled === typed ? settled : null,
    options,
  );
  const results = useSearchResults(online ? submitted : null, options);
  const moreIndicator = useDelayedIndicator(results.loadingMore);
  const carName = carTitle(car);

  const run = (query: string) => {
    const tidy = tidyQuery(query);
    if (tidy.length < 2) return;
    recentSearchesStore.set(rememberSearch(recentSearchesStore.get(), tidy));
    setText(tidy);
    setSubmitted(tidy);
  };

  const iconOf = (item: CatalogSearchItem) =>
    categoryIconOf(tree.data?.categories, item.category.id);
  const openItem = (item: CatalogSearchItem) => {
    if (typed.length >= 2)
      recentSearchesStore.set(rememberSearch(recentSearchesStore.get(), typed));
    onOpenItem({ id: item.id, name: item.name.text });
  };

  const header = (
    <>
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
      <CatalogHeader onAddCar={onAddCar} />
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
    </Screen>
  );

  function renderRecent() {
    if (recent.length === 0) {
      return (
        <View style={styles.hint}>
          <Text variant="body" color="textMuted">
            {t("search.recentEmpty")}
          </Text>
        </View>
      );
    }
    return (
      <ScrollView keyboardShouldPersistTaps="handled">
        <View style={styles.sectionHead}>
          <Text variant="heading" accessibilityRole="header">
            {t("search.recent")}
          </Text>
          <Button variant="text" size="m" onPress={() => recentSearchesStore.set([])}>
            {t("search.recentClear")}
          </Button>
        </View>
        {recent.map((query, index) => (
          <ListRow
            key={query}
            first={index === 0}
            icon="clock"
            title={query}
            onPress={() => run(query)}
          />
        ))}
      </ScrollView>
    );
  }

  function renderSuggestions() {
    const answer = suggestions.data;
    const byArticle = (answer?.items ?? []).filter((item) => item.match === "article");
    const others = (answer?.items ?? []).filter((item) => item.match !== "article");
    return (
      <ScrollView keyboardShouldPersistTaps="handled">
        <ListRow
          first
          icon="search"
          title={t("search.find", { query: typed })}
          onPress={() => run(typed)}
        />
        {answer?.usedQuery && (
          <View style={styles.note}>
            <Text variant="bodyS" color="textMuted">
              {t("search.usedQuery", { query: answer.usedQuery })}
            </Text>
          </View>
        )}
        {byArticle.length > 0 && (
          <SuggestionGroup title={t("search.byArticle")}>
            {byArticle.map((item, index) => (
              <ListRow
                key={item.id}
                first={index === 0}
                title={[item.article, item.brand?.name, item.category.name.text]
                  .filter(Boolean)
                  .join(" · ")}
                subtitle={item.name.text}
                navigates
                onPress={() => openItem(item)}
              />
            ))}
          </SuggestionGroup>
        )}
        {(answer?.categories.length ?? 0) > 0 && (
          <SuggestionGroup title={t("search.categories")}>
            {answer!.categories.map((category, index) => (
              <ListRow
                key={category.id}
                first={index === 0}
                icon="category"
                title={category.name.text}
                {...(category.parentName ? { subtitle: category.parentName.text } : {})}
                navigates
                onPress={() => onOpenCategory(category)}
              />
            ))}
          </SuggestionGroup>
        )}
        {others.length > 0 && (
          <SuggestionGroup title={t("search.items")}>
            {others.map((item, index) => (
              <ListRow
                key={item.id}
                first={index === 0}
                title={item.name.text}
                subtitle={[item.brand?.name, item.article].filter(Boolean).join(" · ")}
                navigates
                onPress={() => openItem(item)}
              />
            ))}
          </SuggestionGroup>
        )}
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
        skeleton={<SkeletonList rows={5} label={t("common.loading")} />}
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
        {answer.categories.length > 0 && (
          <View style={styles.chips}>
            {answer.categories.map((category) => (
              <Chip key={category.id} icon="category" onPress={() => onOpenCategory(category)}>
                {category.name.text}
              </Chip>
            ))}
          </View>
        )}
        <Text variant="bodyS" color="textMuted">
          {tn("search.found", answer.total)}
        </Text>
      </View>
    );
  }

  function emptyState() {
    const answer = results.first.data;
    const query = answer?.usedQuery ?? submitted ?? "";
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

function SuggestionGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.group}>
      <Text variant="bodyS" color="textMuted" style={styles.groupTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { paddingHorizontal: layout.screenPadding, paddingTop: 4, paddingBottom: 8 },
  hint: { paddingHorizontal: layout.screenPadding, paddingTop: layout.blockGap },
  note: { paddingHorizontal: layout.screenPadding, paddingVertical: 8 },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: layout.screenPadding,
    paddingVertical: 8,
    minHeight: size.button.m,
  },
  group: { paddingTop: 16 },
  groupTitle: { paddingHorizontal: layout.screenPadding, paddingBottom: 8 },
  head: { gap: 12, paddingHorizontal: layout.screenPadding, paddingBottom: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  more: { paddingVertical: layout.cardPadding },
});

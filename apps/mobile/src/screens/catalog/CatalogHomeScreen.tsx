import type { CategoryNode, CategorySubcategory } from "@adclub/contracts";
import { layout, radius } from "@adclub/ui-core";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  CategoryIcon,
  DataState,
  ListGroup,
  ListRow,
  OfflineBanner,
  Screen,
  ScreenBody,
  SearchEntry,
  Section,
  SkeletonList,
  Text,
  useTheme,
} from "../../design-system";
import { useCatalogCar } from "../../catalog/catalog-car-provider";
import { tileRows } from "../../catalog/tile-rows";
import type { GarageCar } from "../../garage/garage";
import { useCategoryTree } from "../../services/use-catalog";
import { useOnline } from "../../services/use-network";
import { useCity } from "../../state/city-provider";
import { useT } from "../../state/language";
import { CitySheet } from "../CitySheet";
import { CatalogHeader } from "./CatalogHeader";

export interface CatalogHomeScreenProps {
  onOpenNode: (node: CategoryNode) => void;
  /** «Услуги в {город}»: a subcategory of services opens its list (M-CAT-08 behind it). */
  onOpenServices: (subcategory: CategorySubcategory) => void;
  onAddCar: () => void;
  /** «Уточните двигатель» opens the car at that step. */
  onCompleteEngine: (car: GarageCar) => void;
  /** «Артикул или название» opens the search (M-CAT-04, TASK-044). */
  onOpenSearch: () => void;
}

/**
 * M-CAT-01 — the main screen of the catalog: the car and the city in the
 * header, one hint card, the top-level categories of goods as tiles and
 * «Услуги в {город}» — the subcategories of services as rows of a card
 * group (TASK-019; TASK-078: rows, so a long Kazakh name is a line, not a
 * tile three lines tall). Services are shown only by a city (PRODUCT 11):
 * with «Весь Казахстан» the block says so (T-CITY-01) and offers to choose
 * one. There is no advertising anywhere. The catalog is for a car (D-062),
 * so the card that used to ask for one is gone — the only hint left is to
 * say which engine it has.
 */
export function CatalogHomeScreen({
  onOpenNode,
  onOpenServices,
  onAddCar,
  onCompleteEngine,
  onOpenSearch,
}: CatalogHomeScreenProps) {
  const t = useT();
  const online = useOnline();
  const tree = useCategoryTree();
  const { car } = useCatalogCar();
  const { selection } = useCity();
  const [citySheet, setCitySheet] = useState(false);

  const nodes = (tree.data?.categories ?? []).filter((node) => node.kind === "goods");
  // A subcategory of services with its own icon, or its node's (M8).
  const services = (tree.data?.categories ?? [])
    .filter((node) => node.kind === "services")
    .flatMap((node) =>
      node.children.map((child) => ({ child, icon: child.icon ?? node.icon ?? null })),
    );

  const status =
    !online && tree.data === null
      ? "offline"
      : tree.status === "loading"
        ? "loading"
        : tree.status === "error"
          ? "error"
          : nodes.length === 0
            ? "empty"
            : "ready";

  // One card (M-CAT-01): the engine the compatibility depends on.
  const hint =
    car.engine === null ? (
      <Banner
        tone="warning"
        action={
          <Button variant="text" size="m" onPress={() => onCompleteEngine(car)}>
            {t("compat.completeCar")}
          </Button>
        }
      >
        {t("catalog.hintRefineEngine")}
      </Banner>
    ) : null;

  return (
    <Screen
      title={t("tabs.catalog")}
      root
      // Without a network the catalog cannot search; the orders can still be read (SCREENS 2.4).
      banner={!online ? <OfflineBanner label={t("catalog.offlineBanner")} /> : null}
      refreshing={tree.refreshing}
      refreshingLabel={t("common.loading")}
      header={
        <>
          <CatalogHeader onAddCar={onAddCar} />
          <View style={styles.search}>
            <SearchEntry
              label={t("search.open")}
              placeholder={t("search.placeholder")}
              onPress={onOpenSearch}
              disabled={!online}
              disabledHint={t("search.needsNetwork")}
            />
          </View>
        </>
      }
    >
      <ScreenBody>
        {hint && <View style={styles.hint}>{hint}</View>}
        <DataState
          status={status}
          skeleton={<SkeletonList rows={4} label={t("common.loading")} />}
          error={{
            title: t("state.errorTitle"),
            text: t("state.errorText"),
            retry: { label: t("common.retry"), onRetry: tree.reload },
          }}
          offline={{
            title: t("state.offline"),
            text: t("state.offlineText"),
            action: (
              <Button variant="secondary" size="m" icon="refresh" onPress={tree.reload}>
                {t("common.retry")}
              </Button>
            ),
          }}
          empty={{
            icon: "category",
            title: t("catalog.emptyTitle"),
            text: t("catalog.emptyText"),
          }}
        >
          <Section title={t("catalog.goods")} first={!hint}>
            <View style={styles.tiles}>
              {tileRows(nodes).map((row) => (
                <View
                  key={row.map((node) => node?.id ?? "spacer").join(":")}
                  style={styles.tileRow}
                >
                  {row.map((node) =>
                    node ? (
                      <CategoryTile key={node.id} node={node} onPress={() => onOpenNode(node)} />
                    ) : (
                      <View key="spacer" style={styles.spacer} />
                    ),
                  )}
                </View>
              ))}
            </View>
          </Section>
          {services.length > 0 && (
            <Section
              title={
                selection.kind === "city"
                  ? t("catalog.servicesIn", { city: selection.name })
                  : t("catalog.services")
              }
            >
              {selection.kind === "city" ? (
                <ListGroup>
                  {services.map(({ child, icon }, index) => (
                    <ListRow
                      key={child.id}
                      first={index === 0}
                      title={child.name.text}
                      leading={<CategoryIcon name={icon} size={24} color="accent" />}
                      navigates
                      onPress={() => onOpenServices(child)}
                    />
                  ))}
                </ListGroup>
              ) : (
                // «Весь Казахстан»: services are only by a city (T-CITY-01).
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
              )}
            </Section>
          )}
        </DataState>
      </ScreenBody>
      <CitySheet visible={citySheet} onClose={() => setCitySheet(false)} services />
    </Screen>
  );
}

/**
 * A tile: the icon 32 of `accent` in the middle, without a plate (D-068), the name under
 * it in the middle, up to two lines (a Kazakh name is never cut: the tile
 * grows). Tiles of one row are as tall as the tallest of them; the content
 * stands in the middle of the tile (TASK-078 M-CAT-01).
 */
function CategoryTile({
  node,
  onPress,
}: {
  node: Pick<CategoryNode, "icon" | "name">;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={node.name.text}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        {
          // `surface` sets the tile apart from the page: no frame (DESIGN.md 7.6).
          backgroundColor: pressed ? theme.colors.surfaceRaised : theme.colors.surface,
        },
      ]}
    >
      <CategoryIcon name={node.icon} size={32} color="accent" />
      <Text variant="bodyStrong" style={styles.tileName}>
        {node.name.text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: layout.screenPadding, paddingTop: 8 },
  hint: { paddingBottom: 12 },
  tiles: { gap: 12 },
  tileRow: { flexDirection: "row", gap: 12, alignItems: "stretch" },
  tile: {
    flex: 1,
    minHeight: 104,
    borderRadius: radius.m,
    padding: layout.cardPadding,
    gap: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  tileName: { textAlign: "center" },
  spacer: { flex: 1 },
});

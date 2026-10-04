import type { CategoryNode } from "@adclub/contracts";
import { layout, radius } from "@adclub/ui-core";
import { Pressable, StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  CategoryIcon,
  DataState,
  OfflineBanner,
  Screen,
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
import { useT } from "../../state/language";
import { CatalogHeader } from "./CatalogHeader";

export interface CatalogHomeScreenProps {
  onOpenNode: (node: CategoryNode) => void;
  onAddCar: () => void;
  /** «Уточните двигатель» opens the car at that step. */
  onCompleteEngine: (car: GarageCar) => void;
}

/**
 * M-CAT-01 — the main screen of the catalog: the car and the city in the
 * header, one hint card, and the top-level categories of goods as tiles.
 * Services are stage C; there is no advertising anywhere. The catalog is
 * for a car (D-062), so the card that used to ask for one is gone — the only
 * hint left is to say which engine it has.
 */
export function CatalogHomeScreen({
  onOpenNode,
  onAddCar,
  onCompleteEngine,
}: CatalogHomeScreenProps) {
  const t = useT();
  const online = useOnline();
  const tree = useCategoryTree();
  const { car } = useCatalogCar();

  const nodes = (tree.data?.categories ?? []).filter((node) => node.kind === "goods");

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
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      refreshing={tree.refreshing}
      refreshingLabel={t("common.loading")}
      header={<CatalogHeader onAddCar={onAddCar} />}
    >
      <View style={styles.content}>
        {hint}
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
          <Section title={t("catalog.goods")}>
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
        </DataState>
      </View>
    </Screen>
  );
}

/**
 * A tile: the icon 32 of `accent` in the middle, without a plate (D-068), the name under
 * it in the middle, up to two lines (a Kazakh name is never cut: the tile
 * grows). Tiles of one row are as tall as the tallest of them, and their
 * icons stand on one line.
 */
function CategoryTile({ node, onPress }: { node: CategoryNode; onPress: () => void }) {
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
  content: { paddingHorizontal: layout.screenPadding, gap: 12 },
  tiles: { gap: 12 },
  tileRow: { flexDirection: "row", gap: 12, alignItems: "stretch" },
  tile: {
    flex: 1,
    minHeight: 120,
    borderRadius: radius.m,
    padding: layout.cardPadding,
    gap: 12,
    alignItems: "center",
    justifyContent: "flex-start",
  },
  tileName: { textAlign: "center" },
  spacer: { flex: 1 },
});

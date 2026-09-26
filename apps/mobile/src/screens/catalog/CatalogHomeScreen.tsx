import type { CategoryNode } from "@adclub/contracts";
import { layout, radius } from "@adclub/ui-core";
import { useCallback } from "react";
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
import { useCategoryTree } from "../../services/use-catalog";
import { useOnline } from "../../services/use-network";
import { useT } from "../../state/language";
import { CatalogHeader } from "./CatalogHeader";

export interface CatalogHomeScreenProps {
  onOpenNode: (node: CategoryNode) => void;
  onAddCar: () => void;
  /** «Уточните двигатель» opens the car at that step. */
  onCompleteEngine: (carId: string) => void;
}

/**
 * M-CAT-01 — the main screen of the catalog: the car and the city in the
 * header, one hint card by priority, and the top-level categories of goods
 * as tiles. Services are stage C; there is no advertising anywhere.
 */
export function CatalogHomeScreen({
  onOpenNode,
  onAddCar,
  onCompleteEngine,
}: CatalogHomeScreenProps) {
  const t = useT();
  const online = useOnline();
  const tree = useCategoryTree();
  const { car, filterOff } = useCatalogCar();

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

  const hint = useCallback(() => {
    // One card, by the priority of M-CAT-01.
    if (!car) {
      if (filterOff) return null;
      return (
        <Banner
          icon="car"
          action={
            <Button variant="text" size="m" onPress={onAddCar}>
              {t("garage.add")}
            </Button>
          }
        >
          {t("catalog.hintAddCar")}
        </Banner>
      );
    }
    if (car.engine === null) {
      return (
        <Banner
          tone="warning"
          action={
            <Button variant="text" size="m" onPress={() => onCompleteEngine(car.id)}>
              {t("compat.completeCar")}
            </Button>
          }
        >
          {t("catalog.hintRefineEngine")}
        </Banner>
      );
    }
    return null;
  }, [car, filterOff, onAddCar, onCompleteEngine, t]);

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
        {hint()}
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
              {nodes.map((node) => (
                <CategoryTile key={node.id} node={node} onPress={() => onOpenNode(node)} />
              ))}
            </View>
          </Section>
        </DataState>
      </View>
    </Screen>
  );
}

function CategoryTile({ node, onPress }: { node: CategoryNode; onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        {
          backgroundColor: pressed ? theme.colors.surfaceRaised : theme.colors.surface,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <CategoryIcon name={node.icon} size={28} color="accent" />
      <Text variant="bodyStrong" numberOfLines={2}>
        {node.name.text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, gap: 12 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  tile: {
    // Two per row with a 12 gap inside the screen's 16 padding.
    flexGrow: 1,
    flexBasis: "45%",
    minHeight: 96,
    borderWidth: 1,
    borderRadius: radius.m,
    padding: layout.cardPadding,
    gap: 8,
    justifyContent: "space-between",
  },
});

import type { CategorySubcategory } from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import { StyleSheet, View } from "react-native";
import {
  Button,
  CategoryIcon,
  DataState,
  ListRow,
  OfflineBanner,
  Screen,
  SkeletonList,
} from "../../design-system";
import { useCategoryTree } from "../../services/use-catalog";
import { useOnline } from "../../services/use-network";
import { useT } from "../../state/language";

export interface SubcategoriesScreenProps {
  categoryId: string;
  onOpen: (subcategory: CategorySubcategory) => void;
  onBack: () => void;
}

/**
 * M-CAT-10 — the subcategories of a node. Emptiness under a car is decided
 * in the list of items (M-CAT-02), so this screen shows every subcategory
 * the server has.
 */
export function SubcategoriesScreen({ categoryId, onOpen, onBack }: SubcategoriesScreenProps) {
  const t = useT();
  const online = useOnline();
  const tree = useCategoryTree();
  const node = tree.data?.categories.find((candidate) => candidate.id === categoryId) ?? null;
  const children = node?.children ?? [];

  const status =
    !online && tree.data === null
      ? "offline"
      : tree.status === "loading"
        ? "loading"
        : tree.status === "error"
          ? "error"
          : children.length === 0
            ? "empty"
            : "ready";

  return (
    <Screen
      title={node?.name.text ?? t("tabs.catalog")}
      back={{ label: t("common.back"), onPress: onBack }}
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      refreshing={tree.refreshing}
      refreshingLabel={t("common.loading")}
    >
      <View style={styles.content}>
        <DataState
          status={status}
          skeleton={<SkeletonList rows={5} label={t("common.loading")} />}
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
            title: t("catalog.emptyItems"),
            text: t("catalog.emptyItemsText"),
          }}
        >
          <View>
            {children.map((child, index) => (
              <ListRow
                key={child.id}
                first={index === 0}
                title={child.name.text}
                navigates
                onPress={() => onOpen(child)}
                trailing={<CategoryIcon name={child.icon} size={24} color="textMuted" />}
              />
            ))}
          </View>
        </DataState>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12 },
});

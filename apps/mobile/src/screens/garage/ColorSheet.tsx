import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon, Sheet, Text, useAfterDismiss, useTheme } from "../../design-system";
import { CAR_COLORS, type CarColorId } from "../../garage/car-color";
import { useT } from "../../state/language";

export interface ColorSheetProps {
  visible: boolean;
  onClose: () => void;
  /** `null` — «Не указан», always the first row. */
  value: CarColorId | null;
  onPick: (color: CarColorId | null) => void;
}

/**
 * The colour step of the car (D-063, TASK-028.B): a fixed list, so there is
 * nothing to load and no offline state — the sheet is the whole of it, the
 * same shape as the other choices of a car (a list of rows in a sheet), with
 * a swatch instead of the usual leading icon (`ListRow` has none, so the row
 * is drawn here rather than changing a component every other list uses).
 * Colour never gates another parameter, so — unlike the vehicle-catalog
 * steps — picking one here never asks to clear anything below it.
 */
export function ColorSheet({ visible, onClose, value, onPick }: ColorSheetProps) {
  const t = useT();
  const dismissed = useAfterDismiss(visible);

  const pick = (color: CarColorId | null) => {
    dismissed.after(() => onPick(color));
    onClose();
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      onDismissed={dismissed.onDismissed}
      title={t("car.colorSheetTitle")}
      closeLabel={t("common.close")}
    >
      <ScrollView style={styles.list}>
        <ColorRow
          first
          label={t("common.notSet")}
          selected={value === null}
          onPress={() => pick(null)}
        />
        {CAR_COLORS.map((option) => (
          <ColorRow
            key={option.id}
            label={t(`car.color.${option.id}`)}
            swatch={option.swatch}
            selected={value === option.id}
            onPress={() => pick(option.id)}
          />
        ))}
      </ScrollView>
    </Sheet>
  );
}

function ColorRow({
  label,
  swatch,
  selected,
  first,
  onPress,
}: {
  label: string;
  swatch?: string;
  selected: boolean;
  first?: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
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
      {swatch ? (
        <View
          style={[styles.swatch, { backgroundColor: swatch, borderColor: theme.colors.border }]}
        />
      ) : (
        <View
          style={[styles.swatch, styles.swatchEmpty, { borderColor: theme.colors.borderField }]}
        />
      )}
      <Text variant="bodyStrong" style={styles.grow}>
        {label}
      </Text>
      {selected && <Icon name="check" color="accent" />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { maxHeight: 400 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 4 },
  grow: { flex: 1 },
  swatch: { width: 24, height: 24, borderRadius: 12, borderWidth: 1 },
  swatchEmpty: { borderStyle: "dashed" },
});

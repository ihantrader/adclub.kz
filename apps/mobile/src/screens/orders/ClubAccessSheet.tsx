import { StyleSheet, View } from "react-native";
import { Button, Icon, Sheet, Text } from "../../design-system";
import { useT } from "../../state/language";

/**
 * The stand-in for the subscription on stage B (TASK-030 requirement 2):
 * subscriptions come with EPIC-14 (M-SUB-01), and until then club access
 * is given by invitation (`club-access:grant`). A member without it who
 * presses «Оформить» sees this one sheet with a plain working text — not a
 * subscription screen that cannot be paid, not an error — and it leads
 * nowhere else. When M-SUB-01 arrives, this sheet is the one place that
 * changes. Whether the person has club access is never worked out here:
 * the server said so (`viewer.clubAccess`, `SUBSCRIPTION_REQUIRED`).
 */
export function ClubAccessSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <Sheet visible={visible} onClose={onClose} closeLabel={t("common.close")}>
      <View style={styles.content}>
        <Icon name="lock" size={28} color="textMuted" />
        <Text variant="heading" accessibilityRole="header">
          {t("club.title")}
        </Text>
        <Text color="textMuted">{t("club.text")}</Text>
        <Button onPress={onClose}>{t("club.ok")}</Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12, paddingBottom: 8 },
});

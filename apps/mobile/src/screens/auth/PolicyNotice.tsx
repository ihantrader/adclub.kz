import { Linking, StyleSheet } from "react-native";
import { Text, useToast } from "../../design-system";
import { useClubInfo } from "../../services/use-club-info";
import { useT } from "../../state/language";

/**
 * «Продолжая, вы принимаете Политику конфиденциальности» (M-AUTH-01,
 * M-AUTH-03): the policy is a link of the accent colour (TASK-078), opening
 * the address the club set (`club_privacy_url`, M-PRO-06); without one the
 * line is plain text. The link is the dictionary's own words, found inside
 * the sentence, so every language keeps its grammar.
 */
export function PolicyNotice() {
  const t = useT();
  const info = useClubInfo();
  const toast = useToast();
  const sentence = t("auth.policyNotice");
  const link = t("auth.policyLinkText");
  const url = info.data?.privacyUrl ?? null;
  const at = sentence.indexOf(link);
  if (at < 0 || !url) {
    return (
      <Text variant="caption" color="textMuted">
        {sentence}
      </Text>
    );
  }
  return (
    <Text variant="caption" color="textMuted">
      {sentence.slice(0, at)}
      <Text
        variant="caption"
        color="accent"
        accessibilityRole="link"
        onPress={() => Linking.openURL(url).catch(() => toast.show(t("documents.openFailed")))}
        style={styles.link}
      >
        {link}
      </Text>
      {sentence.slice(at + link.length)}
    </Text>
  );
}

const styles = StyleSheet.create({
  link: { textDecorationLine: "underline" },
});

import { languages, mobileText, type Lang } from "@adclub/i18n";
import { layout } from "@adclub/ui-core";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Text, useTheme } from "../design-system";

/**
 * M-START-02: the heading in all three languages (T-START-01), the options
 * in their own language, no flags. Shown only on a first run whose system
 * language is not kk/ru/en; the choice applies at once.
 */
export function LanguageScreen({ onSelect }: { onSelect: (lang: Lang) => void }) {
  const { theme } = useTheme();
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      <View style={styles.content}>
        <Text variant="title" accessibilityRole="header" style={styles.heading}>
          {/* The same text in every language — it is read before one is chosen. */}
          {mobileText("ru", "start.chooseLanguage")}
        </Text>
        <View style={styles.options}>
          {languages.map((lang) => (
            <Button key={lang} variant="secondary" onPress={() => onSelect(lang)}>
              {mobileText(lang, `language.${lang}`)}
            </Button>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: layout.screenPadding,
    gap: layout.blockGap,
  },
  heading: { textAlign: "center" },
  options: { gap: 12 },
});

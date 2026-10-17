import { languages, mobileText, type Lang } from "@adclub/i18n";
import { brandSvg, layout } from "@adclub/ui-core";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SvgXml } from "react-native-svg";
import { Button, Text, useTheme } from "../design-system";

const MARK_WIDTH = 96;
const MARK_RATIO = 300 / 605.08;

/**
 * M-START-02: the heading in all three languages (T-START-01), one language
 * a line — the text is one string, read before a language is chosen, and it
 * is split at its «·» only to stand in three lines (TASK-078); the options
 * in their own language, no flags; the mark of the club above, so the
 * screen is the club's like the steps that follow. Shown only on a first
 * run whose system language is not kk/ru/en; the choice applies at once.
 */
export function LanguageScreen({ onSelect }: { onSelect: (lang: Lang) => void }) {
  const { theme } = useTheme();
  const lines = mobileText("ru", "start.chooseLanguage").split(" · ");
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      <View style={styles.content}>
        <SvgXml
          xml={brandSvg[theme.name === "dark" ? "mark-ad-champagne" : "mark-ad-graphite"]}
          width={MARK_WIDTH}
          height={MARK_WIDTH * MARK_RATIO}
        />
        <View accessibilityRole="header" style={styles.heading}>
          {lines.map((line) => (
            <Text key={line} variant="title" style={styles.headingLine}>
              {line}
            </Text>
          ))}
        </View>
      </View>
      <View style={styles.options}>
        {languages.map((lang) => (
          <Button key={lang} variant="secondary" onPress={() => onSelect(lang)}>
            {mobileText(lang, `language.${lang}`)}
          </Button>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: layout.screenPadding,
    gap: layout.blockGap,
  },
  heading: { gap: 4 },
  headingLine: { textAlign: "center" },
  options: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 12,
  },
});

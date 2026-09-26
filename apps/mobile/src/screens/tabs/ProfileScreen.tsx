import { languages, mobileText, type Lang, type MobileTextKey } from "@adclub/i18n";
import { layout, radius, themeModes, type ThemeMode } from "@adclub/ui-core";
import { lazy, Suspense, useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { appInfo } from "../../config/environment";
import {
  Button,
  Icon,
  ListRow,
  OfflineBanner,
  Radio,
  Screen,
  Section,
  Sheet,
  Text,
  useTheme,
} from "../../design-system";
import { useOnline } from "../../services/use-network";
import { cityLabel } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useLanguage, useT } from "../../state/language";
import { CitySheet } from "../CitySheet";

const APPEARANCE_LABEL: Record<ThemeMode, MobileTextKey> = {
  dark: "profile.appearanceDark",
  light: "profile.appearanceLight",
  system: "profile.appearanceSystem",
};

// Development builds only (Expo Go): in production `__DEV__` is false and the
// showcase is never loaded or reachable (ARCHITECTURE 4.10 I94).
const ShowcaseScreen = __DEV__ ? lazy(() => import("../../dev/ShowcaseScreen")) : null;

/**
 * M-PRO-01 for a guest (TASK-029 adds the account half): the city, the
 * interface language and "Оформление" — the three things that already live
 * on the device and change here.
 */
export function ProfileScreen() {
  const t = useT();
  const { lang, setLanguage } = useLanguage();
  const { theme, mode, setMode } = useTheme();
  const { selection } = useCity();
  const online = useOnline();
  const [sheet, setSheet] = useState<"city" | "language" | "appearance" | null>(null);
  const [showcase, setShowcase] = useState(false);

  return (
    <Screen
      title={t("tabs.profile")}
      root
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
    >
      <View style={styles.content}>
        {/* A guest: the invitation to sign in; the action itself is TASK-029. */}
        <View
          style={[
            styles.guestCard,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
        >
          <Icon name="user" size={24} color="textMuted" />
          <View style={styles.guestText}>
            <Text variant="bodyStrong">{t("profile.guestTitle")}</Text>
            <Text variant="bodyS" color="textMuted">
              {t("profile.guestText")}
            </Text>
          </View>
        </View>

        <Section>
          <View style={[styles.rows, { borderColor: theme.colors.border }]}>
            <ListRow
              first
              icon="mapPin"
              title={t("profile.city")}
              subtitle={cityLabel(selection, t("city.all"))}
              navigates
              onPress={() => setSheet("city")}
            />
            <ListRow
              icon="language"
              title={t("profile.language")}
              subtitle={mobileText(lang, `language.${lang}`)}
              navigates
              onPress={() => setSheet("language")}
            />
            <ListRow
              icon="contrast"
              title={t("profile.appearance")}
              subtitle={t(APPEARANCE_LABEL[mode])}
              navigates
              onPress={() => setSheet("appearance")}
            />
          </View>
        </Section>

        <Text variant="caption" color="textMuted" style={styles.version}>
          {t("profile.version")}: {appInfo.version}
        </Text>

        {ShowcaseScreen && (
          <Button variant="text" size="m" icon="category" onPress={() => setShowcase(true)}>
            Витрина компонентов (dev)
          </Button>
        )}
      </View>

      <CitySheet visible={sheet === "city"} onClose={() => setSheet(null)} />

      {/* Язык интерфейса: applies at once (M-PRO-01). */}
      <Sheet
        visible={sheet === "language"}
        onClose={() => setSheet(null)}
        title={t("profile.language")}
        closeLabel={t("common.close")}
      >
        <View style={styles.choices}>
          {languages.map((option: Lang) => (
            <Radio
              key={option}
              label={mobileText(option, `language.${option}`)}
              checked={option === lang}
              onSelect={() => {
                setLanguage(option);
                setSheet(null);
              }}
            />
          ))}
        </View>
      </Sheet>

      {/* Оформление: dark by default, kept on the device (DESIGN 7.3). */}
      <Sheet
        visible={sheet === "appearance"}
        onClose={() => setSheet(null)}
        title={t("profile.appearance")}
        closeLabel={t("common.close")}
      >
        <View style={styles.choices}>
          {themeModes.map((option) => (
            <Radio
              key={option}
              label={t(APPEARANCE_LABEL[option])}
              checked={option === mode}
              onSelect={() => {
                setMode(option);
                setSheet(null);
              }}
            />
          ))}
        </View>
      </Sheet>

      {ShowcaseScreen && showcase && (
        <Modal visible animationType="slide" onRequestClose={() => setShowcase(false)}>
          <Suspense fallback={null}>
            <ShowcaseScreen onClose={() => setShowcase(false)} />
          </Suspense>
        </Modal>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12 },
  guestCard: {
    flexDirection: "row",
    gap: 12,
    padding: layout.cardPadding,
    borderWidth: 1,
    borderRadius: radius.m,
  },
  guestText: { flex: 1, gap: 4 },
  rows: { borderWidth: 1, borderRadius: radius.m, overflow: "hidden" },
  choices: { paddingBottom: 8 },
  version: { paddingTop: layout.blockGap },
});

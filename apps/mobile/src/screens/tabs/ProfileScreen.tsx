import { languages, mobileText, type Lang, type MobileTextKey } from "@adclub/i18n";
import { layout, radius, themeModes, type ThemeMode } from "@adclub/ui-core";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { lazy, Suspense, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { appInfo } from "../../config/environment";
import {
  Button,
  Dialog,
  Icon,
  IconBadge,
  ListGroup,
  ListRow,
  OfflineBanner,
  Radio,
  Screen,
  Section,
  Sheet,
  Text,
  useTheme,
} from "../../design-system";
import type { ProfileStackParams } from "../../navigation/routes";
import { useSignIn } from "../../navigation/use-sign-in";
import { useOnline } from "../../services/use-network";
import { cityLabel } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useLanguage, useT } from "../../state/language";
import { useSession } from "../../state/session-provider";
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
 * M-PRO-01, guest and signed in (TASK-029): a guest sees the invitation to
 * sign in; a signed-in member sees their name and phone, "Мои данные" and
 * "Устройства", and can sign out (T-PRO-01). City, language and appearance
 * are shown either way — they already live on the device (TASK-027) and,
 * once signed in, in the account too (`SessionProvider` keeps them in step).
 * Items the app doesn't have yet (subscription, notifications, documents,
 * deleting the account) are left out on purpose, not shown disabled.
 */
export function ProfileScreen({
  navigation,
}: NativeStackScreenProps<ProfileStackParams, "profile-home">) {
  const t = useT();
  const { lang, setLanguage } = useLanguage();
  const { mode, setMode } = useTheme();
  const { selection } = useCity();
  const online = useOnline();
  const session = useSession();
  const signIn = useSignIn();
  const [sheet, setSheet] = useState<"city" | "language" | "appearance" | null>(null);
  const [showcase, setShowcase] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  return (
    <Screen
      title={t("tabs.profile")}
      root
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
    >
      <View style={styles.content}>
        {session.status === "signed_in" ? (
          <SignedInCard
            name={session.profile?.name ?? null}
            phone={session.profile?.phone ?? null}
            onResumeRegistration={
              session.profile && !session.profile.registrationCompleted
                ? signIn.resumeRegistration
                : undefined
            }
          />
        ) : (
          <PersonCard
            title={t("profile.guestTitle")}
            text={t("profile.guestText")}
            onPress={signIn.start}
          />
        )}

        <Section>
          <ListGroup>
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
          </ListGroup>
        </Section>

        {session.status === "signed_in" && (
          <Section>
            <ListGroup>
              <ListRow
                first
                icon="user"
                title={t("profile.myData")}
                navigates
                onPress={() => navigation.navigate("profile-my-data")}
              />
              <ListRow
                icon="devices"
                title={t("profile.devices")}
                navigates
                onPress={() => navigation.navigate("profile-devices")}
              />
            </ListGroup>
          </Section>
        )}

        {session.status === "signed_in" && (
          <Button
            variant="text"
            size="m"
            icon="logout"
            destructive
            onPress={() => setConfirmSignOut(true)}
          >
            {t("profile.signOut")}
          </Button>
        )}

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

      {/* T-PRO-01: signing out drops the saved codes of active orders too. */}
      <Dialog
        visible={confirmSignOut}
        onClose={() => setConfirmSignOut(false)}
        title={t("profile.signOutConfirmTitle")}
        actions={
          <>
            <Button
              variant="secondary"
              destructive
              onPress={() => {
                setConfirmSignOut(false);
                void session.signOut();
              }}
            >
              {t("profile.signOut")}
            </Button>
            <Button variant="text" onPress={() => setConfirmSignOut(false)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        {t("profile.signOutConfirmText")}
      </Dialog>

      {ShowcaseScreen && showcase && (
        // A fade, not the platform's slide of the whole window: with «Уменьшить
        // движение» only opacity may change (DESIGN 7.6). Development only.
        <Modal visible animationType="fade" onRequestClose={() => setShowcase(false)}>
          <Suspense fallback={null}>
            <ShowcaseScreen onClose={() => setShowcase(false)} />
          </Suspense>
        </Modal>
      )}
    </Screen>
  );
}

function SignedInCard({
  name,
  phone,
  onResumeRegistration,
}: {
  name: string | null;
  phone: string | null;
  /** Set only while registration isn't finished (SCREENS M-AUTH-03): tapping opens it. */
  onResumeRegistration?: () => void;
}) {
  const t = useT();
  return (
    <PersonCard
      title={name ?? t("profile.finishRegistration")}
      text={phone}
      {...(onResumeRegistration ? { onPress: onResumeRegistration } : {})}
    />
  );
}

/**
 * The card at the top of the profile: the person on the round accent plate,
 * a title and a line under it; with `onPress` it reads as a button — it
 * darkens when pressed and has a chevron (TASK-030.A: the guest's «Войдите»
 * looked like a note).
 */
function PersonCard({
  title,
  text,
  onPress,
}: {
  title: string;
  text: string | null;
  onPress?: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.personCard,
        {
          backgroundColor: pressed ? theme.colors.surfaceRaised : theme.colors.surface,
        },
      ]}
    >
      <IconBadge size={24}>
        <Icon name="user" size={24} color="accent" />
      </IconBadge>
      <View style={styles.personText}>
        <Text variant="bodyStrong">{title}</Text>
        {text ? (
          <Text variant="bodyS" color="textMuted">
            {text}
          </Text>
        ) : null}
      </View>
      {onPress && <Icon name="chevronRight" size={20} color="textMuted" />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 4 },
  personCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: layout.cardPadding,
    borderRadius: radius.m,
  },
  personText: { flex: 1, gap: 2 },
  choices: { paddingBottom: 8 },
  version: { paddingTop: layout.blockGap },
});

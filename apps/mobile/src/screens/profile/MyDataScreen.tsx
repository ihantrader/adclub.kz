import { accountNameSchema, ACCOUNT_NAME_MAX_LENGTH } from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Button,
  Checkbox,
  DataState,
  Screen,
  Text,
  TextField,
  useToast,
} from "../../design-system";
import type { ProfileStackParams } from "../../navigation/routes";
import { useT } from "../../state/language";
import { useSession } from "../../state/session-provider";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** M-PRO-02 «Мои данные»: name, read-only phone, optional e-mail and its newsletter consent. */
export function MyDataScreen({
  navigation,
}: NativeStackScreenProps<ProfileStackParams, "profile-my-data">) {
  const t = useT();
  const session = useSession();
  const { show } = useToast();
  const profile = session.profile;

  const [name, setName] = useState(profile?.name ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [newsConsent, setNewsConsent] = useState(profile?.emailNewsConsent ?? false);
  const [error, setError] = useState<string | null>(null);

  // The screen may open before `SessionProvider`'s own load has finished
  // (a cold start straight into this screen from a deep link, say); once it
  // has, the fields start from the real profile.
  useEffect(() => {
    if (!profile) return;
    // Syncing local field state from the external `profile` object once it
    // (re)loads, not deriving it every render: the fields must stay freely
    // editable in between (the rule's own exception applies).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(profile.name ?? "");
    setEmail(profile.email ?? "");
    setNewsConsent(profile.emailNewsConsent);
  }, [profile]);

  const trimmedName = name.trim();
  const nameValid = trimmedName.length > 0 && accountNameSchema.safeParse(trimmedName).success;
  const trimmedEmail = email.trim();
  const emailValid = trimmedEmail.length === 0 || EMAIL_PATTERN.test(trimmedEmail);
  const hasEmail = trimmedEmail.length > 0;
  const canSave = nameValid && emailValid;

  const save = async () => {
    if (!canSave) return;
    setError(null);
    try {
      await session.updateProfile({
        name: trimmedName,
        email: hasEmail ? trimmedEmail.toLowerCase() : null,
        emailNewsConsent: hasEmail && newsConsent,
      });
      show(t("profile.saved"));
      navigation.goBack();
    } catch {
      setError(t("state.errorText"));
    }
  };

  return (
    <Screen
      title={t("profile.myData")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
      bottomInset
      footer={
        <Button onPress={save} disabled={!canSave}>
          {t("common.save")}
        </Button>
      }
    >
      <DataState
        status={profile ? "ready" : "loading"}
        skeleton={null}
        error={{ title: t("state.errorTitle"), text: t("state.errorText") }}
        empty={{ icon: "user", title: t("state.errorTitle") }}
      >
        <View style={styles.content}>
          <TextField
            label={t("auth.nameLabel")}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            textContentType="name"
            maxLength={ACCOUNT_NAME_MAX_LENGTH}
            error={
              error ?? (trimmedName.length > 0 && !nameValid ? t("auth.nameInvalid") : undefined)
            }
          />
          <TextField
            label={t("profile.phone")}
            value={profile?.phone ?? ""}
            onChangeText={() => undefined}
            disabled
            hint={t("profile.phoneReadOnly")}
          />
          <TextField
            label={t("profile.email")}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoCapitalize="none"
            autoComplete="email"
            error={trimmedEmail.length > 0 && !emailValid ? t("profile.emailInvalid") : undefined}
          />
          <Checkbox
            label={t("profile.emailNewsConsent")}
            checked={hasEmail && newsConsent}
            onChange={setNewsConsent}
            disabled={!hasEmail}
          />
          {!hasEmail && (
            <Text variant="caption" color="textMuted">
              {t("profile.emailNewsNeedsEmail")}
            </Text>
          )}
        </View>
      </DataState>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 8, gap: 16 },
});

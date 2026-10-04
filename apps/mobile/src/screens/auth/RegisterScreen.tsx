import { isApiError } from "@adclub/api-client";
import { leaveAuthFlow } from "../../navigation/use-sign-in";
import { accountNameSchema, ACCOUNT_NAME_MAX_LENGTH } from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Checkbox, Screen, Text, TextField } from "../../design-system";
import type { RootParams } from "../../navigation/routes";
import { useT } from "../../state/language";
import { useSession } from "../../state/session-provider";

/**
 * M-AUTH-03 «Завершение регистрации»: the account already exists (the code
 * was verified) — this only gives it a name and the mandatory consent
 * (T-AUTH-05). The city comes from the switcher, not asked here (SCREENS).
 */
export function RegisterScreen({
  navigation,
}: NativeStackScreenProps<RootParams, "auth-register">) {
  const t = useT();
  const session = useSession();
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const nameLooksUsable = trimmed.length > 0 && accountNameSchema.safeParse(trimmed).success;
  const canSubmit = nameLooksUsable && consent;

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      await session.completeRegistration(trimmed);
      // The root stack's history starts at "tabs" (see `CodeScreen`) — this
      // returns to whatever asked to sign in, with the transfer already
      // under way in the background (`SessionProvider`).
      leaveAuthFlow(navigation);
    } catch (thrown) {
      setError(
        isApiError(thrown) && thrown.code === "VALIDATION_ERROR"
          ? t("auth.nameInvalid")
          : t("state.errorText"),
      );
    }
  };

  return (
    <Screen
      title={t("auth.registerTitle")}
      bottomInset
      footer={
        <Button onPress={submit} disabled={!canSubmit}>
          {t("common.done")}
        </Button>
      }
    >
      <View style={styles.content}>
        <TextField
          label={t("auth.nameLabel")}
          value={name}
          onChangeText={setName}
          autoFocus
          autoCapitalize="words"
          textContentType="name"
          maxLength={ACCOUNT_NAME_MAX_LENGTH}
          error={
            error ?? (trimmed.length > 0 && !nameLooksUsable ? t("auth.nameInvalid") : undefined)
          }
        />
        <Checkbox label={t("auth.consentLabel")} checked={consent} onChange={setConsent} />
        <Text variant="caption" color="textMuted">
          {t("auth.policyNotice")}
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 16 },
});

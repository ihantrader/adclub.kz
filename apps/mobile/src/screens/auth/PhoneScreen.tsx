import { normalizeKzMobilePhone } from "@adclub/domain";
import { layout } from "@adclub/ui-core";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Screen, Text, TextField } from "../../design-system";
import type { RootParams } from "../../navigation/routes";
import { apiClient } from "../../services/api";
import { useT } from "../../state/language";
import { loginErrorText } from "./auth-errors";

/**
 * M-AUTH-01 «Телефон»: one flow for signing in and registering — nothing on
 * this screen, and nothing about how it answers, says whether the number
 * already has an account (TASK-029 requirement 4, "наличие аккаунта не
 * раскрывается").
 */
export function PhoneScreen({ navigation }: NativeStackScreenProps<RootParams, "auth-phone">) {
  const t = useT();
  const [raw, setRaw] = useState("+7 ");
  const [error, setError] = useState<string | null>(null);
  const phone = normalizeKzMobilePhone(raw);
  const showsInvalid = error === null && raw.trim().length > 2 && phone === null;

  const send = async (channel?: "sms") => {
    if (!phone) return;
    setError(null);
    try {
      const response = await apiClient.requestLoginCode({ phone, ...(channel ? { channel } : {}) });
      navigation.navigate("auth-code", {
        phone: response.phone,
        channel: response.channel,
        codeLength: response.codeLength,
        resendAvailableAt: response.resendAvailableAt,
      });
    } catch (thrown) {
      setError(loginErrorText(thrown, t));
    }
  };

  return (
    <Screen
      title={t("auth.phoneTitle")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
      bottomInset
      footer={
        <Button onPress={() => send()} disabled={!phone}>
          {t("auth.getCode")}
        </Button>
      }
    >
      <View style={styles.content}>
        <TextField
          label={t("auth.phoneLabel")}
          value={raw}
          onChangeText={setRaw}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          autoFocus
          error={error ?? (showsInvalid ? t("auth.phoneInvalid") : undefined)}
          hint={!error && !showsInvalid ? t("auth.channelHint") : undefined}
        />
        <Button variant="text" size="m" onPress={() => send("sms")} disabled={!phone}>
          {t("auth.noWhatsapp")}
        </Button>
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

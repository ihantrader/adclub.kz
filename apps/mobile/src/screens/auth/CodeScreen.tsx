import { layout } from "@adclub/ui-core";
import { leaveAuthFlow } from "../../navigation/use-sign-in";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, CodeCells, Screen, Text } from "../../design-system";
import type { RootParams } from "../../navigation/routes";
import { apiClient } from "../../services/api";
import { useT } from "../../state/language";
import { toStoredSession, useSession } from "../../state/session-provider";
import { loginErrorText } from "./auth-errors";

/** M-AUTH-02 «Код»: the six digits, the resend countdown, the switch to SMS. */
export function CodeScreen({ navigation, route }: NativeStackScreenProps<RootParams, "auth-code">) {
  const t = useT();
  const session = useSession();
  const { phone } = route.params;
  const [channel, setChannel] = useState(route.params.channel);
  const [codeLength, setCodeLength] = useState(route.params.codeLength);
  const [resendAvailableAt, setResendAvailableAt] = useState(route.params.resendAvailableAt);
  const [switchedToSms, setSwitchedToSms] = useState(route.params.channel === "sms");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((new Date(resendAvailableAt).getTime() - now) / 1000));

  const verify = useCallback(
    async (value: string) => {
      setError(null);
      setPending(true);
      try {
        const response = await apiClient.verifyLoginCode({ phone, code: value });
        const profile = await session.beginSession(
          toStoredSession(response.accountId, response.session),
        );
        if (!navigation.isFocused()) return;
        if (profile && !profile.registrationCompleted) {
          // Drop "auth-phone" too: once signed in, «назад» from M-AUTH-03
          // has nothing useful to return to on this stack (SCREENS M-AUTH-03).
          navigation.pop(1);
          navigation.replace("auth-register");
        } else {
          // Registration was already finished (a returning member): back to
          // whatever asked to sign in — the remembered action (SCREENS M-AUTH-00).
          // The root stack's history starts at "tabs" (`RootNavigator` resets it
          // there once the first run ends), so the top of it is always what
          // opened the sign-in flow, with its own nested state untouched.
          leaveAuthFlow(navigation);
        }
      } catch (thrown) {
        setCode("");
        setError(loginErrorText(thrown, t));
      } finally {
        setPending(false);
      }
    },
    [navigation, phone, session, t],
  );

  const onChangeCode = (value: string) => {
    setCode(value);
    if (value.length === codeLength && !pending) void verify(value);
  };

  const resend = async (forceSms: boolean) => {
    setError(null);
    try {
      const response = await apiClient.requestLoginCode({
        phone,
        ...(forceSms ? { channel: "sms" as const } : {}),
      });
      setChannel(response.channel);
      setCodeLength(response.codeLength);
      setResendAvailableAt(response.resendAvailableAt);
      if (forceSms || response.channel === "sms") setSwitchedToSms(true);
      setCode("");
    } catch (thrown) {
      setError(loginErrorText(thrown, t));
    }
  };

  return (
    <Screen
      title={switchedToSms ? t("auth.codeTitleSms") : t("auth.codeTitleWhatsapp")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
      bottomInset
    >
      <View style={styles.content}>
        <View style={styles.phoneRow}>
          <Text color="textMuted">{phone}</Text>
          <Button variant="text" size="m" onPress={navigation.goBack}>
            {t("auth.changeNumber")}
          </Button>
        </View>
        {switchedToSms && channel === "sms" && route.params.channel === "whatsapp" && (
          <Text variant="bodyS" color="textMuted">
            {t("auth.fellBackToSms")}
          </Text>
        )}
        <CodeCells
          label={t("auth.codeLabel")}
          value={code}
          onChangeText={onChangeCode}
          error={error ?? undefined}
          autoFocus
        />
        {secondsLeft > 0 ? (
          <Text variant="bodyS" color="textMuted">
            {t("auth.resendIn", { seconds: String(secondsLeft) })}
          </Text>
        ) : (
          <Button variant="text" size="m" onPress={() => resend(false)}>
            {t("auth.resend")}
          </Button>
        )}
        {channel === "whatsapp" && (
          <Button variant="text" size="m" onPress={() => resend(true)}>
            {t("auth.sendSms")}
          </Button>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 16 },
  phoneRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});

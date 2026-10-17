import { kzPhoneDigits, normalizeKzMobilePhone } from "@adclub/domain";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Button, PhoneField, Screen, ScreenBody, Section, Text } from "../../design-system";
import type { RootParams } from "../../navigation/routes";
import { apiClient } from "../../services/api";
import { useT } from "../../state/language";
import { loginErrorText } from "./auth-errors";
import { PolicyNotice } from "./PolicyNotice";

/**
 * M-AUTH-01 «Телефон»: one flow for signing in and registering — nothing on
 * this screen, and nothing about how it answers, says whether the number
 * already has an account (TASK-029 requirement 4, "наличие аккаунта не
 * раскрывается").
 *
 * TASK-078: the number is typed into the mask «+7 7__ ___ __ __» (M4); an
 * incomplete number is told by the hint «Введите мобильный номер
 * Казахстана» under the field, not an error; «У меня нет WhatsApp» is a
 * text button at the left, always available — it switches the channel to
 * SMS before the code is asked for; the policy line stands with the button.
 */
export function PhoneScreen({ navigation }: NativeStackScreenProps<RootParams, "auth-phone">) {
  const t = useT();
  const [raw, setRaw] = useState("+7 ");
  const [channel, setChannel] = useState<"whatsapp" | "sms">("whatsapp");
  const [error, setError] = useState<string | null>(null);
  const phone = normalizeKzMobilePhone(raw);
  const typed = kzPhoneDigits(raw).length > 0;
  const incomplete = phone === null;

  const send = async () => {
    if (!phone) return;
    setError(null);
    try {
      const response = await apiClient.requestLoginCode({
        phone,
        ...(channel === "sms" ? { channel: "sms" as const } : {}),
      });
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
        <>
          <PolicyNotice />
          <Button onPress={send} disabled={!phone}>
            {t("auth.getCode")}
          </Button>
        </>
      }
    >
      <ScreenBody>
        <Section first>
          <PhoneField
            label={t("auth.phoneLabel")}
            value={raw}
            onChangeText={(next) => {
              setRaw(next);
              setError(null);
            }}
            autoFocus
            {...(error ? { error } : {})}
            hint={
              typed && incomplete
                ? t("auth.phoneInvalid")
                : t(channel === "sms" ? "auth.channelHintSms" : "auth.channelHint")
            }
          />
          {channel === "whatsapp" ? (
            <Button variant="text" size="m" onPress={() => setChannel("sms")}>
              {t("auth.noWhatsapp")}
            </Button>
          ) : (
            <>
              <Text variant="bodyS" color="textMuted">
                {t("auth.channelHintSms")}
              </Text>
              <Button variant="text" size="m" onPress={() => setChannel("whatsapp")}>
                {t("auth.useWhatsapp")}
              </Button>
            </>
          )}
        </Section>
      </ScreenBody>
    </Screen>
  );
}

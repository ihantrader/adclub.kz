import { StyleSheet, View } from "react-native";
import { Button, Sheet, Text, useAfterDismiss } from "../../design-system";
import { useSignIn } from "../../navigation/use-sign-in";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";

export interface SignInSheetProps {
  visible: boolean;
  onClose: () => void;
  /** One phrase saying why (T-GATE-01, T-GATE-02). */
  reason: string;
}

/**
 * M-AUTH-00 «Нужен вход»: a reason, "Ваши автомобили сохранятся" when the
 * guest garage has a car, "Войти" and "Не сейчас". The sign-in flow opens
 * only once the sheet has gone (`useAfterDismiss`) — the platform's push
 * must not play out under a sheet still sliding away (DESIGN 7.6).
 */
export function SignInSheet({ visible, onClose, reason }: SignInSheetProps) {
  const t = useT();
  const { cars } = useGarage();
  const signIn = useSignIn();
  const dismissed = useAfterDismiss(visible);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      onDismissed={dismissed.onDismissed}
      closeLabel={t("common.close")}
    >
      <View style={styles.content}>
        <Text variant="bodyStrong">{reason}</Text>
        {cars.length > 0 && (
          <Text variant="bodyS" color="textMuted">
            {t("auth.carsWillBeSaved")}
          </Text>
        )}
        <Button
          onPress={() => {
            dismissed.after(signIn.start);
            onClose();
          }}
        >
          {t("auth.signIn")}
        </Button>
        <Button variant="text" onPress={onClose}>
          {t("auth.notNow")}
        </Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12, paddingBottom: 8 },
});

import { assistantComplaintReasonSchema, type AssistantComplaintReason } from "@adclub/contracts";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Radio, Sheet, Text, TextField, useAfterDismiss } from "../../design-system";
import type { AssistantLimitSheet } from "../../assistant/assistant-rules";
import { useT } from "../../state/language";

/**
 * M-AI-02 (SCREENS): the three cases of a limit spent, one sheet. Which one
 * it is the server said (`assistantLimitSheetOf`); «Войти» opens the sign-in
 * above the tab (F11) and comes back to the dialog with the text in its field.
 */
export function AssistantLimitSheetView({
  sheet,
  onClose,
  onSignIn,
  onCatalog,
}: {
  sheet: AssistantLimitSheet | null;
  onClose: () => void;
  onSignIn: () => void;
  onCatalog: () => void;
}) {
  const t = useT();
  const dismissed = useAfterDismiss(sheet !== null);
  // The sheet itself keeps showing what it showed while it goes away (`Sheet`, `Held`).
  const shown: AssistantLimitSheet = sheet ?? "guest_trial";
  const close = (then?: () => void) => {
    if (then) dismissed.after(then);
    onClose();
  };
  const title =
    shown === "guest_trial"
      ? t("assistant.limitTrialTitle")
      : shown === "guest_budget"
        ? t("assistant.limitBudgetTitle")
        : t("assistant.limitDayTitle");
  const text =
    shown === "guest_trial"
      ? t("assistant.limitTrialText")
      : shown === "guest_budget"
        ? t("assistant.limitBudgetText")
        : t("assistant.limitDayText");
  return (
    <Sheet
      visible={sheet !== null}
      onClose={() => close()}
      onDismissed={dismissed.onDismissed}
      title={title}
      closeLabel={t("common.close")}
    >
      <View style={styles.body}>
        <Text color="textMuted">{text}</Text>
        {shown === "day" ? (
          <Button onPress={() => close(onCatalog)}>{t("assistant.limitToCatalog")}</Button>
        ) : (
          <>
            <Button onPress={() => close(onSignIn)}>{t("auth.signIn")}</Button>
            <Button variant="secondary" onPress={() => close()}>
              {shown === "guest_trial" ? t("assistant.limitContinue") : t("assistant.limitOk")}
            </Button>
          </>
        )}
      </View>
    </Sheet>
  );
}

/**
 * «Пожаловаться на ответ» (M-AI-01): the reasons of the contract in words,
 * a text if the person wants one (the contract asks for none, «Другое»
 * included). Sending again is safe: the server answers with the same complaint.
 */
export function AssistantComplaintSheet({
  visible,
  online,
  onClose,
  onSend,
}: {
  visible: boolean;
  online: boolean;
  onClose: () => void;
  /** Rejects when the complaint did not reach the server. */
  onSend: (reason: AssistantComplaintReason, text: string) => Promise<void>;
}) {
  const t = useT();
  const [reason, setReason] = useState<AssistantComplaintReason | null>(null);
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const dismissed = useAfterDismiss(visible);
  const reset = () => {
    setReason(null);
    setText("");
    setFailed(false);
  };
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      onDismissed={() => {
        dismissed.onDismissed();
        reset();
      }}
      title={t("assistant.complaintTitle")}
      closeLabel={t("common.close")}
    >
      <View style={styles.body}>
        <View accessibilityRole="radiogroup">
          {assistantComplaintReasonSchema.options.map((option) => (
            <Radio
              key={option}
              label={t(`assistant.reason.${option}`)}
              checked={reason === option}
              onSelect={() => setReason(option)}
            />
          ))}
        </View>
        <TextField
          label={t("assistant.complaintText")}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={1000}
          {...(text.length > 900
            ? { counter: { count: text.length, max: 1000, text: `${text.length} / 1000` } }
            : {})}
        />
        {failed && (
          <Text variant="bodyS" color="danger">
            {t("assistant.sendFailed")}
          </Text>
        )}
        {!online && (
          <Text variant="bodyS" color="textMuted">
            {t("order.needsNetwork")}
          </Text>
        )}
        <Button
          disabled={reason === null || !online}
          onPress={async () => {
            if (reason === null) return;
            setFailed(false);
            try {
              await onSend(reason, text);
            } catch {
              setFailed(true);
            }
          }}
        >
          {t("assistant.send")}
        </Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12, paddingBottom: 8 },
});

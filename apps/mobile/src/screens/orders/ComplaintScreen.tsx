import type { ComplaintReasonValue, UserOrder } from "@adclub/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { randomUUID } from "expo-crypto";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  DataState,
  OfflineBanner,
  Radio,
  Screen,
  ScreenBody,
  Section,
  SkeletonList,
  Text,
  TextField,
  useToast,
} from "../../design-system";
import type { RootParams } from "../../navigation/routes";
import { useLeaveWhenSignedOut } from "../../navigation/use-leave-when-signed-out";
import {
  complaintCanSend,
  complaintFailure,
  complaintFailureKeys,
  complaintReasonKeys,
  initialComplaintReason,
  leavesForm,
  sentText,
  type ComplaintFailure,
} from "../../orders/order-feedback";
import { joinDot } from "../../catalog/format";
import { apiClient } from "../../services/api";
import { orderAnswers, orderRequestKey } from "../../services/order-answers";
import { useOnline } from "../../services/use-network";
import { useRequest } from "../../services/use-request";
import { useLanguage } from "../../state/language";

type Props = NativeStackScreenProps<RootParams, "order-complaint">;

/**
 * M-ORD-06 «Жалоба» (TASK-049.B) — over the order, the system «назад» back.
 * The reasons are those the server allows now (`complaintReasons`); T-ORD-08
 * opens it with «Не получил товар или услугу» chosen. A text is required for
 * «Другое», free for the rest; one key for the screen, like the checkout.
 */
export function ComplaintScreen({ route, navigation }: Props) {
  const { orderId, reason: asked } = route.params;
  const { t, lang } = useLanguage();
  const online = useOnline();
  const toast = useToast();
  useLeaveWhenSignedOut(navigation);

  const request = useRequest(
    orderRequestKey(orderId, lang),
    (signal) => apiClient.getUserOrder({ orderId }, { signal }),
    { staleAfterMs: 60_000, cache: orderAnswers },
  );
  const order: UserOrder | null = request.data?.order ?? null;
  const allowed = order?.complaintReasons ?? [];

  // `undefined` — not touched yet: the reason T-ORD-08 asked for, if allowed.
  const [choice, setChoice] = useState<ComplaintReasonValue | null | undefined>(undefined);
  const reason = choice === undefined ? initialComplaintReason(asked, allowed) : choice;
  const [text, setText] = useState("");
  const [key] = useState(() => randomUUID());
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<ComplaintFailure | null>(null);

  const maxLength = order?.feedbackLimits.complaintText ?? 0;
  const canSend =
    complaintCanSend({ reason, allowed, text, maxLength }) && online && !sending && !!order;

  const send = async () => {
    if (!canSend || reason === null) return;
    const sent = { reason, text: sentText(text) };
    setFailure(null);
    setSending(true);
    try {
      await apiClient.createComplaint({
        orderId,
        reason,
        text: sent.text,
        idempotencyKey: key,
      });
      toast.show(t("complaint.sent"));
      orderAnswers.clear();
      navigation.goBack();
    } catch (error) {
      const problem = complaintFailure(error, sent);
      if (problem.kind === "session_ended") return;
      if (leavesForm(problem)) {
        toast.show(t(complaintFailureKeys[problem.kind]));
        orderAnswers.clear();
        navigation.goBack();
        return;
      }
      // The reasons allowed (or the limit) changed: the order brings them now.
      if (problem.kind === "not_received_requires_completed" || problem.kind === "too_long") {
        setChoice(null);
        request.reload();
      }
      setFailure(problem);
    } finally {
      setSending(false);
    }
  };

  const status = order
    ? allowed.length > 0
      ? "ready"
      : "empty"
    : !online
      ? "offline"
      : request.status === "error"
        ? "error"
        : "loading";
  const textRequired = reason === "other";

  return (
    <Screen
      title={t("complaint.title")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      bottomInset
      footer={
        order && allowed.length > 0 ? (
          <>
            {/* Why the button is off: no network, or no reason chosen yet (TASK-078 M-ORD-06). */}
            {!online ? (
              <Text variant="caption" color="textMuted">
                {t("order.needsNetwork")}
              </Text>
            ) : reason === null ? (
              <Text variant="caption" color="textMuted">
                {t("complaint.chooseReason")}
              </Text>
            ) : null}
            <Button onPress={() => void send()} loading={sending} disabled={!canSend}>
              {t("complaint.send")}
            </Button>
          </>
        ) : null
      }
    >
      <DataState
        status={status}
        skeleton={<SkeletonList rows={3} label={t("common.loading")} />}
        error={
          request.failure === "not_found"
            ? { title: t("order.notFound"), text: t("order.notFoundText") }
            : {
                title: t("state.errorTitle"),
                text: t("state.errorText"),
                retry: { label: t("common.retry"), onRetry: request.reload },
              }
        }
        offline={{ title: t("state.offline"), text: t("state.offlineText") }}
        empty={{
          icon: "receipt",
          title: t(
            order?.complaint?.status === "in_review"
              ? "complaint.failed.exists"
              : "complaint.noReasons",
          ),
          action: (
            <Button variant="secondary" onPress={navigation.goBack}>
              {t("common.back")}
            </Button>
          ),
        }}
      >
        {order && (
          <ScreenBody>
            <View style={styles.stack}>
              <View>
                <Text variant="bodyStrong">{order.supplier.name}</Text>
                <Text variant="bodyS" color="textMuted">
                  {joinDot([t("order.title", { number: order.number }), order.item.name.text])}
                </Text>
              </View>
              <Section title={t("complaint.reasonTitle")}>
                {allowed.map((value) => (
                  <Radio
                    key={value}
                    checked={reason === value}
                    onSelect={() => setChoice(value)}
                    label={t(complaintReasonKeys[value])}
                  />
                ))}
              </Section>
              <TextField
                label={t(textRequired ? "complaint.textLabelRequired" : "complaint.textLabel")}
                value={text}
                onChangeText={setText}
                multiline
                maxLength={maxLength}
                {...(textRequired && text.trim() === ""
                  ? { hint: t("complaint.textRequired") }
                  : {})}
                counter={{
                  count: text.length,
                  max: maxLength,
                  text: t("feedback.counter", { n: text.length, max: maxLength }),
                }}
              />
              {failure && failure.kind !== "session_ended" && (
                <Banner
                  tone="warning"
                  action={
                    failure.kind === "network" || failure.kind === "other" ? (
                      <Button variant="text" size="m" icon="refresh" onPress={() => void send()}>
                        {t("common.retry")}
                      </Button>
                    ) : undefined
                  }
                >
                  {t(
                    complaintFailureKeys[failure.kind],
                    failure.kind === "rate_limited" ? { minutes: failure.minutes } : {},
                  )}
                </Banner>
              )}
            </View>
          </ScreenBody>
        )}
      </DataState>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 16 },
});

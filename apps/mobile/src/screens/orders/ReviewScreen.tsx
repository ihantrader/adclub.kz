import type { UserOrder } from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  DataState,
  OfflineBanner,
  Screen,
  Section,
  SkeletonList,
  StarsInput,
  Text,
  TextField,
  useToast,
} from "../../design-system";
import type { RootParams } from "../../navigation/routes";
import { useLeaveWhenSignedOut } from "../../navigation/use-leave-when-signed-out";
import {
  leavesForm,
  reviewCanSend,
  reviewFailure,
  reviewFailureKeys,
  sentText,
  type ReviewFailure,
} from "../../orders/order-feedback";
import { apiClient } from "../../services/api";
import { orderAnswers, orderRequestKey } from "../../services/order-answers";
import { useOnline } from "../../services/use-network";
import { useRequest } from "../../services/use-request";
import { useLanguage } from "../../state/language";

type Props = NativeStackScreenProps<RootParams, "order-review">;

/**
 * M-ORD-05 «Оценка поставщика» (TASK-049.B) — a screen of the order's stack,
 * over it, the system «назад» back. `new`: five stars (required), a text if
 * the person likes, T-ORD-09, «Отправить» with one key for the whole screen
 * — a lost answer sent again is the same review. `edit` («Исправить текст»
 * after T-REV-02): the score only shown, the text refused before in the
 * field, «Исправить можно один раз». Whether the order may be reviewed or
 * the text corrected is the server's word — read from the order it gives.
 */
export function ReviewScreen({ route, navigation }: Props) {
  const { orderId, mode } = route.params;
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
  const review = order?.review ?? null;

  const [score, setScore] = useState<number | null>(null);
  const [text, setText] = useState("");
  // The refused text is put into the field once, when the order first arrives.
  const filled = useRef(false);
  useEffect(() => {
    if (mode === "edit" && review && !filled.current) {
      filled.current = true;
      setText(review.text ?? "");
    }
  }, [mode, review]);
  // One key for the screen: the same review sent again after a lost answer.
  const [key] = useState(() => randomUUID());
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<ReviewFailure | null>(null);

  const maxLength = order?.feedbackLimits.reviewText ?? 0;
  const editable =
    mode === "edit"
      ? review?.status === "text_rejected" && review.canEditText
      : (order?.canReview ?? false);
  const shownScore = mode === "edit" ? (review?.score ?? null) : score;
  const canSend =
    editable && reviewCanSend({ mode, score: shownScore, text, maxLength }) && online && !sending;

  const send = async () => {
    if (!order || !canSend) return;
    setFailure(null);
    setSending(true);
    try {
      if (mode === "edit" && review) {
        await apiClient.editReviewText({ reviewId: review.id }, { text });
        toast.show(t("review.sent"));
      } else {
        const answer = await apiClient.createReview({
          orderId,
          score: shownScore!,
          text: sentText(text),
          idempotencyKey: key,
        });
        // A score alone is published at once; a text waits for its check (T-REV-01).
        toast.show(
          t(answer.review.status === "published" ? "review.sentPublished" : "review.sent"),
        );
      }
      // The order kept from before says «Оценить» still: it is asked anew.
      orderAnswers.clear();
      navigation.goBack();
    } catch (error) {
      const problem = reviewFailure(error);
      if (problem.kind === "session_ended") return;
      if (leavesForm(problem)) {
        // Nothing more to send here: the order shows what is true now.
        toast.show(t(reviewFailureKeys[problem.kind]));
        orderAnswers.clear();
        navigation.goBack();
        return;
      }
      // The limit may have been lowered: the order brings the new one.
      if (problem.kind === "too_long") request.reload();
      setFailure(problem);
    } finally {
      setSending(false);
    }
  };

  const status = order
    ? editable
      ? "ready"
      : "empty"
    : !online
      ? "offline"
      : request.status === "error"
        ? "error"
        : "loading";
  const blockedText =
    mode === "edit"
      ? t(review?.canEditText === false ? "review.failed.editUsed" : "review.failed.notRejected")
      : review
        ? t("review.failed.exists")
        : order?.reviewUnavailable === "test_order"
          ? t("review.testOrder")
          : t("review.failed.notCompleted");

  return (
    <Screen
      title={t("review.title")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      bottomInset
      footer={
        order && editable ? (
          <>
            {!online ? (
              <Text variant="caption" color="textMuted" style={styles.center}>
                {t("order.needsNetwork")}
              </Text>
            ) : mode === "new" && score === null ? (
              <Text variant="caption" color="textMuted" style={styles.center}>
                {t("review.scoreRequired")}
              </Text>
            ) : null}
            <Button onPress={() => void send()} loading={sending} disabled={!canSend}>
              {t("review.send")}
            </Button>
          </>
        ) : null
      }
    >
      <DataState
        status={status}
        skeleton={<SkeletonList rows={2} label={t("common.loading")} />}
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
          icon: "star",
          title: blockedText,
          action: (
            <Button variant="secondary" onPress={navigation.goBack}>
              {t("common.back")}
            </Button>
          ),
        }}
      >
        {order && (
          <View style={styles.body}>
            <View>
              <Text variant="bodyStrong">{order.supplier.name}</Text>
              <Text variant="bodyS" color="textMuted">
                {t("order.title", { number: order.number })} · {order.item.name.text}
              </Text>
            </View>
            <Section title={t("review.scoreTitle")}>
              <StarsInput
                value={shownScore}
                starLabel={(n) => t("review.scoreLabel", { n })}
                disabled={mode === "edit"}
                {...(mode === "new" ? { onChange: setScore } : {})}
              />
            </Section>
            <View>
              <TextField
                label={t(mode === "edit" ? "review.editTextLabel" : "review.textLabel")}
                value={text}
                onChangeText={setText}
                multiline
                maxLength={maxLength}
                hint={t("review.hint")}
              />
              <Text
                variant="caption"
                color={text.length > maxLength ? "danger" : "textMuted"}
                style={styles.counter}
              >
                {t("feedback.counter", { n: text.length, max: maxLength })}
              </Text>
            </View>
            {mode === "edit" && (
              <Text variant="bodyS" color="textMuted">
                {t("review.editOnce")}
              </Text>
            )}
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
                  reviewFailureKeys[failure.kind],
                  failure.kind === "rate_limited" ? { minutes: failure.minutes } : {},
                )}
              </Banner>
            )}
          </View>
        )}
      </DataState>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 16 },
  center: { textAlign: "center" },
  counter: { textAlign: "right", marginTop: 4 },
});

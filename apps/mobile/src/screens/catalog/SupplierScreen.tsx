import type {
  PublicReview,
  SupplierProfileResponse,
  SupplierReviewsResponse,
} from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Badge,
  Button,
  DataState,
  OfflineBanner,
  Rating,
  Screen,
  Section,
  SkeletonList,
  StarsInput,
  Text,
} from "../../design-system";
import {
  reviewMonthText,
  shareText,
  supplierName,
  supplierReviewsView,
} from "../../catalog/supplier-page";
import type { RootParams } from "../../navigation/routes";
import { useSignIn } from "../../navigation/use-sign-in";
import { apiClient } from "../../services/api";
import { useOnline } from "../../services/use-network";
import { useRequest } from "../../services/use-request";
import { useLanguage } from "../../state/language";
import { useSession } from "../../state/session-provider";
import { SignInSheet } from "../auth/SignInSheet";
import { ClubAccessSheet } from "../orders/ClubAccessSheet";

type Props = NativeStackScreenProps<RootParams, "supplier-page">;

/** Reviews per page of the list. */
const PAGE = 20;

/**
 * M-CAT-09 «Поставщик: рейтинг и отзывы» (TASK-050): opened by the supplier
 * or the rating of an offer (M-CAT-07) and by the supplier of the user's own
 * order (M-ORD-03). The rating, «Проверенный партнёр» and the two shares —
 * to everyone, as the offer shows them; the name and the published reviews —
 * to a member of the club, by the server's word (`supplier.kind`). Anyone
 * else reads «Отзывы видят участники клуба» and the way in that «Оформить»
 * has. The screen counts nothing itself.
 */
export function SupplierScreen({ route, navigation }: Props) {
  const { offerId, orderId } = route.params;
  const { t, lang } = useLanguage();
  const online = useOnline();
  const session = useSession();
  const signIn = useSignIn();
  const [signInOpen, setSignInOpen] = useState(false);
  const [clubOpen, setClubOpen] = useState(false);

  // The account is part of the key: back from signing in, the page is asked
  // again as this account sees it.
  const who = session.accountId ?? "guest";
  const request = useRequest<SupplierProfileResponse>(
    `supplier-page:${offerId ?? ""}:${orderId ?? ""}:${who}:${lang}`,
    (signal) =>
      orderId
        ? apiClient.getOrderSupplier({ orderId }, { signal })
        : apiClient.getOfferSupplier({ offerId: offerId! }, { signal }),
    { staleAfterMs: 60_000 },
  );
  const profile = request.data ?? null;
  const reviewsView = profile
    ? supplierReviewsView(
        profile,
        session.status,
        session.status === "signed_in" ? (session.profile?.registrationCompleted ?? null) : null,
      )
    : null;

  const status = profile
    ? "ready"
    : !online
      ? "offline"
      : request.status === "error"
        ? "error"
        : "loading";

  const askMembership = () => {
    if (!reviewsView || reviewsView.kind !== "members-only") return;
    switch (reviewsView.action) {
      case "sign-in":
        setSignInOpen(true);
        return;
      case "register":
        signIn.resumeRegistration();
        return;
      case "club-access":
        setClubOpen(true);
        return;
      default:
        request.reload();
    }
  };

  return (
    <Screen
      title={t("supplier.title")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      refreshing={request.refreshing}
      refreshingLabel={t("common.loading")}
      bottomInset
    >
      <DataState
        status={status}
        skeleton={<SkeletonList rows={3} label={t("common.loading")} />}
        error={
          request.failure === "not_found"
            ? { title: t("supplier.unavailable"), text: t("supplier.unavailableText") }
            : {
                title: t("state.errorTitle"),
                text: t("state.errorText"),
                retry: { label: t("common.retry"), onRetry: request.reload },
              }
        }
        offline={{ title: t("state.offline"), text: t("state.offlineText") }}
        empty={{ icon: "store", title: t("supplier.unavailable") }}
      >
        {profile && (
          <View style={styles.body}>
            <View style={styles.head}>
              <Text variant="title">{supplierName(profile) ?? t("item.supplierHidden")}</Text>
              {profile.verifiedPartner && (
                <View style={styles.verified}>
                  <Badge tone="success" icon="circleCheck">
                    {t("item.verifiedPartner")}
                  </Badge>
                  <Text variant="bodyS" color="textMuted">
                    {t("supplier.verifiedNote")}
                  </Text>
                </View>
              )}
            </View>

            <Section title={t("item.rating")}>
              <View style={styles.rating}>
                <Rating
                  value={profile.rating?.value ?? null}
                  count={profile.rating?.count ?? 0}
                  emptyText={t("item.newSupplier")}
                  label={t("item.rating")}
                  locale={lang}
                />
                <View style={styles.share}>
                  <Text variant="caption" color="textMuted">
                    {t("supplier.responseLabel")}
                  </Text>
                  <Text variant="body">
                    {shareText(profile.responsePercent, {
                      share: (n) => t("supplier.responseShare", { n }),
                      fewOrders: t("supplier.fewOrders"),
                    })}
                  </Text>
                </View>
                <View style={styles.share}>
                  <Text variant="caption" color="textMuted">
                    {t("supplier.onTimeLabel")}
                  </Text>
                  <Text variant="body">
                    {shareText(profile.onTimePercent, {
                      share: (n) => t("supplier.onTimeShare", { n }),
                      fewOrders: t("supplier.fewOrders"),
                    })}
                  </Text>
                </View>
              </View>
            </Section>

            <Section title={t("supplier.reviews")}>
              {reviewsView?.kind === "list" ? (
                <ReviewsList supplierId={reviewsView.supplierId} />
              ) : (
                <View style={styles.membersOnly}>
                  <Text color="textMuted">{t("supplier.membersOnly")}</Text>
                  <Button variant="secondary" onPress={askMembership}>
                    {reviewsView?.kind === "members-only" &&
                    (reviewsView.action === "sign-in" || reviewsView.action === "register")
                      ? t("auth.signIn")
                      : t("club.title")}
                  </Button>
                </View>
              )}
            </Section>
          </View>
        )}
      </DataState>
      <SignInSheet
        visible={signInOpen}
        onClose={() => setSignInOpen(false)}
        reason={t("supplier.signInReason")}
      />
      <ClubAccessSheet visible={clubOpen} onClose={() => setClubOpen(false)} />
    </Screen>
  );
}

/** The published reviews of a supplier the server showed, newest first, a page at a time. */
function ReviewsList({ supplierId }: { supplierId: string }) {
  const { t, lang } = useLanguage();
  const [more, setMore] = useState<{ reviews: PublicReview[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const first = useRequest<SupplierReviewsResponse>(
    `supplier-reviews:${supplierId}:${lang}`,
    (signal) => apiClient.getSupplierReviews({ supplierId }, { signal, query: { limit: PAGE } }),
    { staleAfterMs: 60_000 },
  );

  const loadMore = useCallback(async () => {
    const cursor = more ? more.cursor : (first.data?.nextCursor ?? null);
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await apiClient.getSupplierReviews(
        { supplierId },
        { query: { limit: PAGE, cursor } },
      );
      setMore((now) => ({
        reviews: [...(now?.reviews ?? []), ...page.reviews],
        cursor: page.nextCursor,
      }));
    } catch {
      // The button stays; pressing it again asks again.
    } finally {
      setLoadingMore(false);
    }
  }, [first.data, more, supplierId]);

  if (!first.data) {
    return first.status === "error" ? (
      <Button variant="text" icon="refresh" onPress={first.reload}>
        {t("common.retry")}
      </Button>
    ) : (
      <SkeletonList rows={2} label={t("common.loading")} />
    );
  }
  const reviews = [...first.data.reviews, ...(more?.reviews ?? [])];
  const cursor = more ? more.cursor : first.data.nextCursor;
  if (reviews.length === 0) {
    return <Text color="textMuted">{t("supplier.noReviews")}</Text>;
  }
  return (
    <View style={styles.reviews}>
      {reviews.map((review) => (
        <View key={review.id} style={styles.review}>
          <StarsInput
            value={review.score}
            starLabel={(n) => t("review.scoreLabel", { n })}
            disabled
            small
          />
          {review.text ? <Text variant="body">{review.text}</Text> : null}
          <Text variant="caption" color="textMuted">
            {review.author ?? t("supplier.memberAuthor")} ·{" "}
            {reviewMonthText(review.publishedMonth, lang)}
          </Text>
        </View>
      ))}
      {cursor && (
        <Button variant="secondary" loading={loadingMore} onPress={() => void loadMore()}>
          {t("catalog.loadMore")}
        </Button>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 20 },
  head: { gap: 8 },
  verified: { gap: 4 },
  rating: { gap: 12 },
  share: { gap: 2 },
  membersOnly: { gap: 12 },
  reviews: { gap: 16 },
  review: { gap: 6 },
});

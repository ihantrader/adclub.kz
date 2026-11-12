import type { AssistantCard, AssistantReply } from "@adclub/contracts";
import { layout, radius } from "@adclub/ui-core";
import { StyleSheet, View } from "react-native";
import { AiPilot, Banner, Button, Chip, Icon, Text, useTheme } from "../../design-system";
import { assistantCharacter } from "../../assistant/assistant-rules";
import { categoryIconOf } from "../../catalog/category-icon";
import { formatTenge } from "../../catalog/format";
import { formatKm } from "../../garage/mileage";
import { useCategoryTree } from "../../services/use-catalog";
import { useLanguage } from "../../state/language";
import { ItemRow } from "../catalog/parts";

/**
 * The messages of M-AI-01 (DESIGN 7.9): the person's — a `fill` bubble at
 * the right; an answer — no fill, a `border` frame, the avatar 32 and the
 * name «AI Pilot» at the left. Everything an answer shows is what the server
 * sent: the cards are the rows of the catalog's list (no supplier, no mark
 * of AI — catalog data is not AI data), the groups, the total, the
 * disclaimer.
 */

export function UserBubble({ text, muted }: { text: string; muted?: boolean }) {
  const { theme } = useTheme();
  return (
    <View style={styles.userRow}>
      <View style={[styles.userBubble, { backgroundColor: theme.colors.fill }]}>
        <Text color={muted ? "textMuted" : "text"}>{text}</Text>
      </View>
    </View>
  );
}

/** The avatar of AI Pilot: `on-graphite` on a `fill` circle (DESIGN 7.9). */
export function Avatar({ state }: { state: Parameters<typeof AiPilot>[0]["state"] }) {
  const { theme } = useTheme();
  return (
    <View style={[styles.avatar, { backgroundColor: theme.colors.fill }]}>
      <AiPilot state={state} colorway="on-graphite" size={28} accessibilityLabel={null} />
    </View>
  );
}

export interface ReplyBlockProps {
  reply: AssistantReply;
  carName: string;
  modelName: string;
  /** The question of this answer takes quick replies (the last answer only, online). */
  live: boolean;
  online: boolean;
  /** T-AI-02, once a dialog, above its first answer. */
  first: boolean;
  complained: boolean;
  /** The mileage suggestion: `saved` once written. */
  mileage: "ask" | "saved" | null;
  onQuickReply: (option: string) => void;
  onOpenCard: (card: AssistantCard) => void;
  onComplain: () => void;
  onUpdateMileage: (km: number) => Promise<void>;
  onSearch: () => void;
}

export function ReplyBlock({
  reply,
  carName,
  modelName,
  live,
  online,
  first,
  complained,
  mileage,
  onQuickReply,
  onOpenCard,
  onComplain,
  onUpdateMileage,
  onSearch,
}: ReplyBlockProps) {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const tree = useCategoryTree();
  const cards = new Map(reply.cards.map((card) => [card.id, card]));
  const grouped = new Set(reply.groups.flatMap((group) => group.itemIds));
  const loose = reply.cards.filter((card) => !grouped.has(card.id));

  const row = (card: AssistantCard, index: number, count: number) => (
    <ItemRow
      key={card.id}
      {...(card.type === "service" ? { serviceModel: modelName } : {})}
      first={index === 0}
      last={index === count - 1}
      name={card.name.text}
      brand={card.brand?.name ?? null}
      article={card.article}
      photo={card.photo}
      icon={categoryIconOf(tree.data?.categories, card.category.id)}
      keyAttributes={card.keyAttributes}
      compatibility={card.compatibility}
      carName={carName}
      offers={card.offers}
      cityName={null}
      onPress={() => onOpenCard(card)}
    />
  );

  return (
    <View style={styles.reply}>
      {first && (
        <Text variant="caption" color="textMuted" style={styles.mayErr}>
          {t("assistant.mayErr")}
        </Text>
      )}
      <View style={styles.replyHead}>
        <Avatar state={assistantCharacter(false, reply)} />
        <Text variant="caption" color="accent">
          {t("assistant.name")}
        </Text>
      </View>
      <View style={[styles.replyBox, { borderColor: theme.colors.border }]}>
        <Text>{reply.text}</Text>
        {reply.question && reply.question.options.length > 0 && (
          <View style={styles.options}>
            {reply.question.options.map((option) => (
              <Chip key={option} disabled={!live || !online} onPress={() => onQuickReply(option)}>
                {option}
              </Chip>
            ))}
          </View>
        )}
        {reply.kind === "unavailable" && (
          <Button variant="secondary" size="m" icon="search" onPress={onSearch}>
            {t("assistant.search")}
          </Button>
        )}
      </View>

      {reply.groups.map((group) => {
        const groupCards = group.itemIds.flatMap((id) => {
          const card = cards.get(id);
          return card ? [card] : [];
        });
        if (groupCards.length === 0) return null;
        return (
          <View key={group.title} style={styles.group}>
            <View style={styles.groupHead}>
              <Text variant="bodyStrong" style={styles.flex}>
                {group.title}
              </Text>
              {group.minPrice !== null && (
                <Text variant="bodyS" color="textMuted">
                  {t("catalog.priceFrom", { price: formatTenge(group.minPrice) })}
                </Text>
              )}
            </View>
            <View>{groupCards.map((card, index) => row(card, index, groupCards.length))}</View>
          </View>
        );
      })}
      {loose.length > 0 && (
        <View style={styles.cards}>
          {loose.map((card, index) => row(card, index, loose.length))}
        </View>
      )}
      {reply.total && (
        <Text variant="bodyStrong">
          {t("assistant.total", { price: formatTenge(reply.total.minPrice) })}
        </Text>
      )}
      {reply.orderEachItem && (
        <Text variant="bodyS" color="textMuted">
          {t("assistant.orderEachItem")}
        </Text>
      )}
      {reply.notOnPlatform.length > 0 && (
        <Text variant="bodyS" color="textMuted">
          {t("assistant.notOnPlatform", { items: reply.notOnPlatform.join(", ") })}
        </Text>
      )}
      {reply.disclaimer && (
        <Banner tone="neutral" icon="info">
          {reply.disclaimer}
        </Banner>
      )}
      {reply.mileageSuggestion && mileage === "ask" && (
        <View style={styles.mileage}>
          <Text variant="bodyS" style={styles.flex}>
            {t("assistant.mileageAsk", { km: formatKm(reply.mileageSuggestion.km) })}
          </Text>
          <Button
            variant="secondary"
            size="m"
            disabled={!online}
            onPress={() => onUpdateMileage(reply.mileageSuggestion!.km)}
          >
            {t("assistant.mileageUpdate")}
          </Button>
        </View>
      )}
      {reply.mileageSuggestion && mileage === "saved" && (
        <View style={styles.saved}>
          <Icon name="circleCheck" size={16} color="success" />
          <Text variant="bodyS" color="textMuted">
            {t("mileage.saved")}
          </Text>
        </View>
      )}
      {reply.kind !== "unavailable" && (
        <View style={styles.complain}>
          {complained ? (
            <Text variant="bodyS" color="textMuted">
              {t("assistant.complained")}
            </Text>
          ) : (
            <Button variant="text" size="m" tone="neutral" icon="flag" onPress={onComplain}>
              {t("assistant.complain")}
            </Button>
          )}
        </View>
      )}
    </View>
  );
}

/** «Подбираю…» with «Остановить»: the character thinking (DESIGN 6). */
export function ThinkingRow({ onStop }: { onStop: () => void }) {
  const { t } = useLanguage();
  return (
    <View style={styles.thinking} accessibilityLiveRegion="polite">
      <Avatar state="thinking" />
      <Text color="textMuted" style={styles.flex}>
        {t("assistant.thinking")}
      </Text>
      <Button variant="secondary" size="m" onPress={onStop}>
        {t("assistant.stop")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  userRow: { flexDirection: "row", justifyContent: "flex-end", paddingLeft: 48 },
  userBubble: {
    borderRadius: radius.m,
    paddingHorizontal: 12,
    paddingVertical: 10,
    maxWidth: "100%",
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  reply: { gap: 12 },
  mayErr: { paddingBottom: 4 },
  replyHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  replyBox: {
    borderWidth: 1,
    borderRadius: radius.m,
    padding: layout.cardPadding,
    gap: 12,
  },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  group: { gap: 8 },
  groupHead: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  cards: { paddingTop: 0 },
  mileage: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  saved: { flexDirection: "row", alignItems: "center", gap: 6 },
  complain: { flexDirection: "row" },
  thinking: { flexDirection: "row", alignItems: "center", gap: 8 },
});

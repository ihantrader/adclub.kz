import type { MobileTextKey } from "@adclub/i18n";
import { layout, radius } from "@adclub/ui-core";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Badge, Icon, StatusBadge, Text, useTheme } from "../../design-system";
import { formatTenge } from "../../catalog/format";
import { listStatusKey, orderStatusView, type OrderStateInput } from "../../orders/order-status";
import {
  CLUB_TIME_ZONE,
  clockText,
  dayText,
  deadlineText,
  updatedLabel,
  zonedParts,
} from "../../orders/order-time";
import { useLanguage } from "../../state/language";

/**
 * Pieces of the order screens (M-ORD-02…04) that more than one of them
 * needs: moments of the server in words, the status mark and the card of
 * an order in a list.
 */

/** The current minute, ticking: «Обновлено в…» and deadlines say «today» against it. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Moments of an order in the words of the current language. */
export function useOrderTime() {
  const { t } = useLanguage();
  const monthName = (month: number) => t(`month.${month}` as MobileTextKey);
  return {
    /** «15:30» today, «15:30, 15 марта» on another day — in the point's zone (the club's before it is known). */
    deadline: (iso: string, timeZone: string | null, now: Date) =>
      deadlineText(iso, timeZone ?? CLUB_TIME_ZONE, now, monthName) ?? "",
    /** «3 октября» and «14:05» apart, for «Получено {дата} в {время}». */
    dateAndTime: (iso: string, timeZone: string | null) => {
      const parts = zonedParts(iso, timeZone ?? CLUB_TIME_ZONE);
      return parts
        ? { date: dayText(parts, monthName), time: clockText(parts) }
        : { date: "", time: "" };
    },
    /** «Обновлено в 10:12» / «Обновлено 3 октября»; the key family is the caller's. */
    updated: (
      serverTime: string,
      now: Date,
      keys: { time: MobileTextKey; date: MobileTextKey },
    ): string => {
      const label = updatedLabel(serverTime, now);
      if (!label) return "";
      return label.kind === "time"
        ? t(keys.time, { time: label.time })
        : t(keys.date, { date: dayText(label.date, monthName) });
    },
  };
}

/** The status of an order as a mark: text and icon, the colour of its group (DESIGN 7.8; never red). */
export function OrderStatusMark({ order }: { order: OrderStateInput }) {
  const { t } = useLanguage();
  const view = orderStatusView(order);
  return <StatusBadge group={view.group}>{t(listStatusKey(order))}</StatusBadge>;
}

export interface OrderRowProps {
  order: OrderStateInput & {
    id: string;
    quantity: number;
    total: number;
    item: { name: { text: string } };
    supplier: { name: string };
  };
  /** The line under the item: the main date of an active order, the date of a finished one. */
  dateLine?: string | null;
  /** «Нужен ваш ответ» (M-ORD-02). */
  needsAnswer?: boolean;
  onPress: () => void;
  /** «Повторить» under a finished order. */
  footer?: React.ReactNode;
}

/** A card of «Мои заявки»: the status, the item and its quantity, the supplier, the main date. */
export function OrderRow({ order, dateLine, needsAnswer, onPress, footer }: OrderRowProps) {
  const { t } = useLanguage();
  const { theme } = useTheme();
  return (
    <View
      style={[
        styles.row,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.rowBody, pressed && { opacity: 0.7 }]}
      >
        <View style={styles.rowTop}>
          <OrderStatusMark order={order} />
          {needsAnswer && (
            <Badge tone="warning" icon="alertTriangle">
              {t("orders.needsAnswer")}
            </Badge>
          )}
        </View>
        <Text variant="bodyStrong">{order.item.name.text}</Text>
        <Text variant="bodyS" color="textMuted">
          {[t("orders.quantityShort", { n: order.quantity }), formatTenge(order.total)].join(" · ")}
        </Text>
        <Text variant="bodyS">{order.supplier.name}</Text>
        {dateLine ? (
          <View style={styles.dateLine}>
            <Icon name="clock" size={16} color="textMuted" />
            <Text variant="caption" color="textMuted" style={styles.shrink}>
              {dateLine}
            </Text>
          </View>
        ) : null}
      </Pressable>
      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderRadius: radius.m, overflow: "hidden" },
  rowBody: { padding: layout.cardPadding, gap: 4 },
  rowTop: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingBottom: 4 },
  dateLine: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 2 },
  shrink: { flexShrink: 1 },
});

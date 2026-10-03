import { codeScreenColors, formatOrderCode, qr, size } from "@adclub/ui-core";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Icon, QrCode, Text } from "../../design-system";
import type { RootParams } from "../../navigation/routes";
import { useLeaveWhenSignedOut } from "../../navigation/use-leave-when-signed-out";
import { qrPages } from "../../orders/active-orders";
import { openedOrder } from "../../orders/opened-orders";
import { orderViewOfCopy, type OrderView } from "../../orders/order-view";
import { useOnline } from "../../services/use-network";
import { useLanguage } from "../../state/language";
import { useOrdersCopy } from "../../state/orders-provider";
import { useNow, useOrderTime } from "./parts";
import { useScreenLight } from "./use-screen-light";

type Props = NativeStackScreenProps<RootParams, "order-qr">;

/**
 * M-ORD-04 — the QR at a counter (SCREENS 9.2, DESIGN 7.10): white in any
 * theme, the QR as large as the screen allows (width − 48, at most 360,
 * quiet zone of four modules, level M), the code in large digits in groups,
 * the item, the quantity and the supplier; «Обновлено в…» without a
 * network. The brightness is at its maximum and the screen does not go dark
 * while it is open (`useScreenLight`). The active orders of the same
 * supplier leaf sideways, «1 из 3». The QR is drawn here from `qrPayload`;
 * nothing of it leaves the phone. A screenshot is not forbidden (D4).
 */
export function OrderQrScreen({ route, navigation }: Props) {
  const { t } = useLanguage();
  const { width } = useWindowDimensions();
  const online = useOnline();
  const now = useNow();
  const time = useOrderTime();
  const orders = useOrdersCopy();
  useScreenLight();
  useLeaveWhenSignedOut(navigation);

  const copy = (orders.copy?.orders ?? []).map(orderViewOfCopy);
  const opened: OrderView | null =
    openedOrder(route.params.orderId) ??
    copy.find((order) => order.id === route.params.orderId) ??
    null;
  const [{ pages, index: startIndex }] = useState(() =>
    opened ? qrPages(opened, copy) : { pages: [] as OrderView[], index: 0 },
  );
  const [index, setIndex] = useState(startIndex);
  const side = Math.min(width - qr.fullScreenInset, qr.fullScreenMax);
  const updated =
    !online && orders.copy
      ? time.updated(orders.copy.serverTime, now, {
          time: "orders.updatedAt",
          date: "orders.updatedOn",
        })
      : null;

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.top}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          onPress={navigation.goBack}
          style={styles.close}
        >
          <Icon name="x" size={24} colorValue={codeScreenColors.text} />
        </Pressable>
      </View>
      <FlatList
        data={pages}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={startIndex}
        getItemLayout={(_, item) => ({ length: width, offset: width * item, index: item })}
        keyExtractor={(order) => order.id}
        onMomentumScrollEnd={(event) => {
          const page = Math.round(event.nativeEvent.contentOffset.x / Math.max(1, width));
          setIndex(Math.min(Math.max(page, 0), pages.length - 1));
        }}
        renderItem={({ item: order }) => (
          <View style={[styles.page, { width }]}>
            {order.confirmation && (
              <>
                <QrCode
                  value={order.confirmation.qrPayload}
                  size={side}
                  label={t("order.qrLabel", { code: formatOrderCode(order.confirmation.code) })}
                />
                <Text
                  variant="codeXL"
                  style={styles.code}
                  maxFontSizeMultiplier={1.2}
                  accessibilityLabel={`${t("order.codeLabel")}: ${order.confirmation.code.split("").join(" ")}`}
                >
                  {formatOrderCode(order.confirmation.code)}
                </Text>
              </>
            )}
            <Text style={styles.text} numberOfLines={2}>
              {order.item.name.text}
            </Text>
            <Text style={styles.text}>{t("order.quantity", { n: order.quantity })}</Text>
            <Text style={styles.text}>{order.supplier.name}</Text>
          </View>
        )}
      />
      <View style={styles.bottom}>
        {updated && (
          <Text variant="caption" style={styles.muted}>
            {updated}
          </Text>
        )}
        {pages.length > 1 && (
          <>
            <View style={styles.dots}>
              {pages.map((order, at) => (
                <View
                  key={order.id}
                  style={[
                    styles.dot,
                    {
                      backgroundColor:
                        at === index ? codeScreenColors.dotActive : codeScreenColors.dotInactive,
                    },
                  ]}
                />
              ))}
            </View>
            <Text variant="caption" style={styles.muted}>
              {t("qr.pageOf", { n: index + 1, total: pages.length })}
            </Text>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: codeScreenColors.background },
  top: { flexDirection: "row", paddingHorizontal: 8, minHeight: size.touchTarget },
  close: {
    width: size.touchTarget,
    height: size.touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  page: { alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 24 },
  code: { color: codeScreenColors.code, textAlign: "center" },
  text: { color: codeScreenColors.text, textAlign: "center" },
  muted: { color: codeScreenColors.textMuted, textAlign: "center" },
  bottom: { alignItems: "center", gap: 8, paddingBottom: 16 },
  dots: { flexDirection: "row", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});

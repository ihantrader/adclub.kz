import {
  codeScreenColors,
  createQrMatrix,
  formatOrderCode,
  HIDDEN_ORDER_CODE,
  qr,
  qrPath,
  radius,
} from "@adclub/ui-core";
import { useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { Text } from "./text";
import { useTheme } from "./theme";

export interface QrCodeProps {
  value: string;
  /** Side in dp, quiet zone included. */
  size: number;
  label: string;
}

/** QR at level M, 4-module quiet zone, black on white in any theme (DESIGN.md 7.10). */
export function QrCode({ value, size, label }: QrCodeProps) {
  const { d, viewBoxSize } = useMemo(() => qrPath(createQrMatrix(value)), [value]);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg width={size} height={size} viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}>
        <Rect width={viewBoxSize} height={viewBoxSize} fill={codeScreenColors.background} />
        <Path d={d} fill={codeScreenColors.code} />
      </Svg>
    </View>
  );
}

/** Stand-in pattern shown dimmed before acceptance: the real QR is not rendered yet. */
const PENDING_QR_VALUE = "adclub:pending";

export interface CodeBlockProps {
  code: string;
  qrValue: string;
  codeLabel: string;
  qrLabel: string;
  /** "Можно забирать": QR 208 instead of 176. */
  ready?: boolean;
  /** Before acceptance: 30 % with T-ORD-06 on top; code hidden, QR a placeholder. */
  pending?: { text: ReactNode };
}

/**
 * Code block of the order card (M-ORD-03): `surface`, radius 6; white square
 * 176 (208 when ready) with the QR and 12 padding; code `code` in groups of three.
 */
export function CodeBlock({ code, qrValue, codeLabel, qrLabel, ready, pending }: CodeBlockProps) {
  const { theme } = useTheme();
  const square = ready ? qr.cardReady : qr.card;
  return (
    <View
      style={[
        styles.block,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      <View
        style={[styles.content, pending && { opacity: qr.pendingOpacity }]}
        importantForAccessibility={pending ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={Boolean(pending)}
      >
        <View
          style={[
            styles.qrBox,
            { width: square, height: square, backgroundColor: theme.colors.qrBg },
          ]}
        >
          <QrCode
            value={pending ? PENDING_QR_VALUE : qrValue}
            size={square - 2 * qr.padding}
            label={qrLabel}
          />
        </View>
        <View>
          <Text variant="caption" color="textMuted">
            {codeLabel}
          </Text>
          <Text variant="code" maxFontSizeMultiplier={1.3}>
            {pending ? HIDDEN_ORDER_CODE : formatOrderCode(code)}
          </Text>
        </View>
      </View>
      {pending && (
        <View style={styles.overlay}>
          <Text
            variant="bodyS"
            style={[styles.overlayText, { backgroundColor: theme.colors.surface }]}
          >
            {pending.text}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { borderRadius: radius.m, borderWidth: 1, padding: 16 },
  content: { alignItems: "center", gap: 16 },
  qrBox: { padding: qr.padding, borderRadius: radius.s },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  overlayText: {
    textAlign: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.s,
    overflow: "hidden",
  },
});

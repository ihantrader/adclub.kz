import {
  codeScreenColors,
  createQrMatrix,
  formatOrderCode,
  qr,
  qrPath,
  radius,
} from "@adclub/ui-core";
import { useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { Icon } from "./Icon";
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

export interface CodeBlockProps {
  code: string;
  qrValue: string;
  codeLabel: string;
  qrLabel: string;
  /** T-ORD-05 «Покажите QR или назовите код сотруднику», inside the block under the code. */
  note?: string;
  /** "Можно забирать": QR 208 instead of 176. */
  ready?: boolean;
  /** Before acceptance: a muted square with a lock and T-ORD-06 in it; no code yet. */
  pending?: { text: ReactNode };
}

/**
 * Code block of the order card (M-ORD-03): `surface`, radius 6; white square
 * 176 (208 when ready) with the QR — its four quiet modules are the white
 * fields of the square, so the pattern is as large as the square allows
 * (TASK-078 M-ORD-03) — and the code `code` in groups of three under it,
 * centred with the square. Before acceptance the square is `surfaceRaised`
 * with a lock and T-ORD-06 inside it: nothing is drawn that is not a code yet.
 */
export function CodeBlock({
  code,
  qrValue,
  codeLabel,
  qrLabel,
  note,
  ready,
  pending,
}: CodeBlockProps) {
  const { theme } = useTheme();
  const square = ready ? qr.cardReady : qr.card;
  return (
    <View
      style={[
        styles.block,
        // `surface` sets the block apart from the page: no frame (DESIGN.md 7.6).
        { backgroundColor: theme.colors.surface },
      ]}
    >
      {pending ? (
        <View
          accessibilityRole="text"
          style={[
            styles.pendingBox,
            { width: square, height: square, backgroundColor: theme.colors.surfaceRaised },
          ]}
        >
          <Icon name="lock" size={32} color="textMuted" />
          <Text variant="bodyS" color="textMuted" style={styles.pendingText}>
            {pending.text}
          </Text>
        </View>
      ) : (
        <>
          <View
            style={[
              styles.qrBox,
              { width: square, height: square, backgroundColor: theme.colors.qrBg },
            ]}
          >
            <QrCode value={qrValue} size={square} label={qrLabel} />
          </View>
          <View style={styles.codeColumn}>
            <Text variant="caption" color="textMuted">
              {codeLabel}
            </Text>
            <Text variant="code" maxFontSizeMultiplier={1.3}>
              {formatOrderCode(code)}
            </Text>
          </View>
          {note !== undefined && (
            <Text variant="caption" color="textMuted" style={styles.note}>
              {note}
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { borderRadius: radius.m, padding: 16, alignItems: "center", gap: 16 },
  qrBox: { borderRadius: radius.s, overflow: "hidden" },
  codeColumn: { alignItems: "center", gap: 2 },
  note: { textAlign: "center" },
  pendingBox: {
    borderRadius: radius.s,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 16,
  },
  pendingText: { textAlign: "center" },
});

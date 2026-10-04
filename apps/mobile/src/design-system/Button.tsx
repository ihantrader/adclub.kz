import {
  createPressGuard,
  isPressBlocked,
  motion,
  radius,
  size,
  type ColorToken,
  type IconName,
} from "@adclub/ui-core";
import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Icon } from "./Icon";
import { Text } from "./text";
import { useTheme } from "./theme";

export type ButtonVariant = "primary" | "secondary" | "text" | "danger";

export interface ButtonProps {
  children: ReactNode;
  /** A returned promise keeps the button loading; presses meanwhile are ignored. */
  onPress?: () => unknown;
  /** Primary — one per screen; danger — irreversible actions only (DESIGN.md 7.7). */
  variant?: ButtonVariant;
  /** L 52 — main action at the bottom of the screen; M 44 — in cards. */
  size?: "l" | "m";
  loading?: boolean;
  disabled?: boolean;
  /** Secondary button with danger text ("Отменить заявку"). */
  destructive?: boolean;
  icon?: IconName;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

const palette: Record<ButtonVariant, { background: ColorToken | null; text: ColorToken }> = {
  primary: { background: "primary", text: "onPrimary" },
  secondary: { background: "fill", text: "text" },
  text: { background: null, text: "accent" },
  danger: { background: "danger", text: "onDanger" },
};

export function Button({
  children,
  onPress,
  variant = "primary",
  size: buttonSize = "l",
  loading = false,
  disabled = false,
  destructive = false,
  icon,
  accessibilityHint,
  style,
}: ButtonProps) {
  const { theme } = useTheme();
  const [pending, setPending] = useState(false);
  const [guard] = useState(() => createPressGuard(setPending));
  const busy = loading || pending;
  const blocked = isPressBlocked({ loading: busy, disabled });

  const colors = palette[variant];
  const textColor: ColorToken = disabled
    ? "textDisabled"
    : destructive && variant === "secondary"
      ? "danger"
      : colors.text;
  const background = disabled
    ? variant === "text"
      ? "transparent"
      : theme.colors.fill
    : colors.background
      ? theme.colors[colors.background]
      : "transparent";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: blocked, busy }}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      hitSlop={buttonSize === "m" ? (size.touchTarget - size.button.m) / 2 : undefined}
      onPress={() => {
        if (blocked || guard.isBusy()) return;
        guard.run(() => onPress?.());
      }}
      style={({ pressed }) => [
        styles.base,
        { minHeight: size.button[buttonSize], backgroundColor: background },
        pressed && !blocked && variant === "text" && { backgroundColor: theme.colors.fill },
        style,
      ]}
    >
      {({ pressed }) => (
        <>
          {pressed && !blocked && variant !== "text" && <View style={styles.pressed} />}
          {/* The label keeps its place while loading, so the width does not change. */}
          <View style={[styles.content, busy && styles.hidden]}>
            {icon && <Icon name={icon} size={20} color={textColor} />}
            <Text variant="label" color={textColor} style={styles.label}>
              {children}
            </Text>
          </View>
          {busy && (
            <ActivityIndicator style={StyleSheet.absoluteFill} color={theme.colors[textColor]} />
          )}
        </>
      )}
    </Pressable>
  );
}

/**
 * Two equal actions side by side, 50 × 50 across the width (TASK-030.A:
 * «Маршрут | Позвонить»). One child takes the whole row. With a large
 * system font the labels wrap inside their halves (DESIGN 7.11), they are
 * never cut.
 */
export function ButtonRow({ children }: { children: ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).filter(
    (child) => child !== null && child !== undefined && child !== false,
  );
  return (
    <View style={styles.row}>
      {items.map((child, index) => (
        <View key={index} style={styles.rowItem}>
          {child}
        </View>
      ))}
    </View>
  );
}

export interface IconButtonProps {
  icon: IconName;
  /** Screen reader text — required, the button has no visible label. */
  label: string;
  onPress: () => void;
  color?: ColorToken;
  colorValue?: string;
  disabled?: boolean;
}

/** 48 × 48 icon-only button: close, back, search, flashlight. */
export function IconButton({ icon, label, onPress, color, colorValue, disabled }: IconButtonProps) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && { backgroundColor: theme.colors.fill },
      ]}
    >
      <Icon name={icon} size={24} color={color} colorValue={colorValue} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.s,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  // Pressed: darken by 12 % (DESIGN.md 7.7).
  pressed: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.s,
    backgroundColor: `rgba(0, 0, 0, ${motion.pressedDarken})`,
  },
  content: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  hidden: { opacity: 0 },
  row: { flexDirection: "row", gap: 8 },
  rowItem: { flex: 1, minWidth: 0 },
  label: { textAlign: "center", flexShrink: 1 },
  iconButton: {
    width: size.touchTarget,
    height: size.touchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.s,
  },
});

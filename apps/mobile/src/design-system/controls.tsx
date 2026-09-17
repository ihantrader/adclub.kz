import {
  clampQuantity,
  fontFamily,
  line,
  motion,
  quantityControls,
  radius,
  size,
  type IconName,
} from "@adclub/ui-core";
import { useEffect, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { Icon } from "./Icon";
import { Text } from "./text";
import { useTheme } from "./theme";

const touchSlop = (height: number) => Math.max(0, (size.touchTarget - height) / 2);

export interface ChipProps {
  children: ReactNode;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
  disabled?: boolean;
}

/** Filter chip: 36 high (touch zone 48); selected — tint and a check mark. */
export function Chip({ children, selected = false, onPress, icon, disabled }: ChipProps) {
  const { theme } = useTheme();
  const { colors } = theme;
  const textColor = disabled ? "textDisabled" : selected ? "accentOnTint" : "text";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={touchSlop(size.chip)}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? colors.accentTint : pressed ? colors.fill : "transparent",
          borderColor: selected ? colors.accentTint : colors.border,
        },
      ]}
    >
      {selected ? (
        <Icon name="check" size={16} color="accentOnTint" />
      ) : (
        icon && <Icon name={icon} size={16} color={textColor} />
      )}
      <Text variant="bodyS" color={textColor} style={styles.shrink}>
        {children}
      </Text>
    </Pressable>
  );
}

export interface SegmentsProps<T extends string> {
  label: string;
  options: readonly { value: T; label: string; icon?: IconName }[];
  value: T;
  onChange: (value: T) => void;
}

/** Up to three options, 40 high; four or long Kazakh labels — a list instead. */
export function Segments<T extends string>({ label, options, value, onChange }: SegmentsProps<T>) {
  const { theme } = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[styles.segments, { backgroundColor: theme.colors.fill }]}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              on && {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                borderWidth: 1,
              },
            ]}
          >
            {option.icon && <Icon name={option.icon} size={16} color={on ? "text" : "textMuted"} />}
            <Text variant="bodyS" color={on ? "text" : "textMuted"} style={styles.segmentLabel}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface ToggleRowProps {
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  control: ReactNode;
  onPress: () => void;
  role: "switch" | "checkbox" | "radio";
  checked: boolean;
  controlFirst?: boolean;
}

function ToggleRow({
  label,
  description,
  disabled,
  control,
  onPress,
  role,
  checked,
  controlFirst,
}: ToggleRowProps) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.toggleRow, controlFirst ? styles.controlFirst : styles.controlLast]}
    >
      {controlFirst && control}
      <View style={styles.toggleText}>
        <Text color={disabled ? "textDisabled" : "text"}>{label}</Text>
        {description && (
          <Text variant="bodyS" color={disabled ? "textDisabled" : "textMuted"}>
            {description}
          </Text>
        )}
      </View>
      {!controlFirst && control}
    </Pressable>
  );
}

export interface ToggleProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** Switch 52 × 32: on — `primary`; off — `fill` with a `borderField` border. */
export function Switch({ label, description, checked, onChange, disabled }: ToggleProps) {
  const { theme, reduceMotion } = useTheme();
  const { colors } = theme;
  const [position] = useState(() => new Animated.Value(checked ? 1 : 0));
  useEffect(() => {
    const target = checked ? 1 : 0;
    if (reduceMotion) {
      position.setValue(target);
      return;
    }
    Animated.timing(position, {
      toValue: target,
      duration: motion.fast,
      useNativeDriver: true,
    }).start();
  }, [checked, position, reduceMotion]);

  return (
    <ToggleRow
      role="switch"
      label={label}
      description={description}
      checked={checked}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      control={
        <View
          style={[
            styles.switch,
            {
              backgroundColor: disabled ? colors.fill : checked ? colors.primary : colors.fill,
              borderColor: disabled ? colors.border : checked ? colors.primary : colors.borderField,
            },
          ]}
        >
          <Animated.View
            style={[
              styles.thumb,
              {
                backgroundColor: disabled
                  ? colors.textDisabled
                  : checked
                    ? colors.onPrimary
                    : colors.textMuted,
                transform: [
                  {
                    translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }),
                  },
                ],
              },
            ]}
          />
        </View>
      }
    />
  );
}

/** Checkbox 24, radius 2. */
export function Checkbox({ label, description, checked, onChange, disabled }: ToggleProps) {
  const { theme } = useTheme();
  const { colors } = theme;
  return (
    <ToggleRow
      role="checkbox"
      controlFirst
      label={label}
      description={description}
      checked={checked}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      control={
        <View
          style={[
            styles.box,
            {
              backgroundColor: disabled ? colors.fill : checked ? colors.primary : colors.surface,
              borderColor: disabled ? colors.border : checked ? colors.primary : colors.borderField,
            },
          ]}
        >
          {checked && (
            <Icon name="check" size={16} color={disabled ? "textDisabled" : "onPrimary"} />
          )}
        </View>
      }
    />
  );
}

export interface RadioProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

export function Radio({ label, description, checked, onSelect, disabled }: RadioProps) {
  const { theme } = useTheme();
  const { colors } = theme;
  return (
    <ToggleRow
      role="radio"
      controlFirst
      label={label}
      description={description}
      checked={checked}
      disabled={disabled}
      onPress={onSelect}
      control={
        <View
          style={[
            styles.box,
            styles.radio,
            {
              backgroundColor: disabled ? colors.fill : colors.surface,
              borderColor: disabled ? colors.border : checked ? colors.primary : colors.borderField,
              borderWidth: checked ? 7 : line.width,
            },
          ]}
        />
      }
    />
  );
}

export interface QuantityProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  label: string;
  decreaseLabel: string;
  increaseLabel: string;
}

/** "−" value "+": buttons 44 (touch zone 48); "−" disabled at 1. */
export function Quantity({
  value,
  onChange,
  min = 1,
  max,
  label,
  decreaseLabel,
  increaseLabel,
}: QuantityProps) {
  const { theme } = useTheme();
  const { canDecrease, canIncrease } = quantityControls(value, min, max);
  const button = (icon: IconName, enabled: boolean, next: number, a11y: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      hitSlop={touchSlop(size.quantityButton)}
      onPress={() => onChange(clampQuantity(next, min, max))}
      style={({ pressed }) => [
        styles.quantityButton,
        { backgroundColor: pressed ? theme.colors.surfaceRaised : theme.colors.fill },
      ]}
    >
      <Icon name={icon} size={20} color={enabled ? "text" : "textDisabled"} />
    </Pressable>
  );
  return (
    <View accessible={false} accessibilityLabel={label} style={styles.quantity}>
      {button("minus", canDecrease, value - 1, decreaseLabel)}
      <Text
        variant="bodyStrong"
        style={styles.quantityValue}
        accessibilityLabel={`${label}: ${value}`}
      >
        {value}
      </Text>
      {button("plus", canIncrease, value + 1, increaseLabel)}
    </View>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: size.chip,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.s,
    borderWidth: line.width,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  segments: { flexDirection: "row", minHeight: size.segments, padding: 2, borderRadius: radius.s },
  segment: {
    flex: 1,
    flexDirection: "row",
    minHeight: 36,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: radius.s,
  },
  segmentLabel: { textAlign: "center", flexShrink: 1, fontFamily: fontFamily.native[500] },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: size.touchTarget,
    paddingVertical: 8,
  },
  controlFirst: { alignItems: "flex-start" },
  controlLast: { justifyContent: "space-between" },
  toggleText: { flex: 1 },
  switch: {
    width: size.switch.width,
    height: size.switch.height,
    borderRadius: radius.full,
    borderWidth: line.width,
    padding: 3,
  },
  thumb: { width: 24, height: 24, borderRadius: 12, marginTop: -1, marginLeft: -1 },
  box: {
    width: size.checkbox,
    height: size.checkbox,
    borderRadius: radius.xs,
    borderWidth: line.width,
    alignItems: "center",
    justifyContent: "center",
  },
  radio: { borderRadius: radius.full },
  quantity: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" },
  quantityButton: {
    width: size.quantityButton,
    height: size.quantityButton,
    borderRadius: radius.s,
    alignItems: "center",
    justifyContent: "center",
  },
  quantityValue: { minWidth: 40, textAlign: "center" },
});

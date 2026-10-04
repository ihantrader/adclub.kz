import {
  clampQuantity,
  fontFamily,
  fontScale,
  line,
  quantityControls,
  radius,
  size,
  typography,
  type IconName,
} from "@adclub/ui-core";
import { useEffect, useState, type ReactNode } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon } from "./Icon";
import { animateLayoutTo, animateTo, useMotionPlan } from "./motion";
import { segmentMetrics } from "./segment-metrics";
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

export interface SelectButtonProps {
  icon: IconName;
  children: string;
  onPress: () => void;
  /** What the button chooses, for screen readers («Автомобиль», «Город»). */
  accessibilityLabel: string;
}

/**
 * A button that shows the current choice and opens the list to change it —
 * the car and the city of the catalog header (TASK-030.A): 44 high (touch
 * zone 48), `surface` with a `border` line, the icon, the value in one line
 * and a caret. A long value first shrinks a little (to 85 %, on the phone)
 * and then ends in an ellipsis — it never wraps. It takes the width it is
 * given, so two of them side by side are 50 × 50: «Geely Atlas 2023» fits
 * half of a 375-pt screen.
 */
export function SelectButton({ icon, children, onPress, accessibilityLabel }: SelectButtonProps) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${accessibilityLabel}: ${children}`}
      onPress={onPress}
      hitSlop={touchSlop(size.button.m)}
      style={({ pressed }) => [
        styles.select,
        {
          backgroundColor: pressed ? theme.colors.surfaceRaised : theme.colors.surface,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Icon name={icon} size={16} color="accent" />
      <Text
        variant="bodyS"
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
        style={styles.selectLabel}
      >
        {children}
      </Text>
      <Icon name="chevronDown" size={16} color="textMuted" />
    </Pressable>
  );
}

export interface SegmentsProps<T extends string> {
  label: string;
  options: readonly {
    value: T;
    label: string;
    icon?: IconName;
    /**
     * One line under the control for the selected option — what choosing it
     * does («Сначала — самая низкая цена»: a sort is an order, not a filter).
     */
    hint?: string;
  }[];
  value: T;
  onChange: (value: T) => void;
}

interface SegmentFrame {
  x: number;
  width: number;
}

/**
 * Segments, 40 high (DESIGN 7.7): the container `fill`, the selected option
 * on a `surface` thumb that slides to it by the rule of a change of state.
 *
 * A label never wraps (TASK-030.A): it keeps one line and grows with the
 * system font only to 120 %, like a tab label; each option is as wide as its
 * label and the spare width is shared out, so «Рекомендуем · Дешевле ·
 * Быстрее» fits a 360-pt phone in every language. Where even that does not
 * fit (four options, the largest font, a narrow phone) the row scrolls
 * sideways instead of wrapping or clipping a word.
 *
 * With `hint`s the line under the control keeps the height of the tallest
 * one, so switching options never moves what is below it.
 */
export function Segments<T extends string>({ label, options, value, onChange }: SegmentsProps<T>) {
  const { theme } = useTheme();
  const plan = useMotionPlan("state");
  const [frames, setFrames] = useState<Partial<Record<T, SegmentFrame>>>({});
  const [thumbX] = useState(() => new Animated.Value(0));
  const [thumbWidth] = useState(() => new Animated.Value(0));
  const [placed, setPlaced] = useState(false);
  const [hintHeights, setHintHeights] = useState<Partial<Record<T, number>>>({});
  const frame = frames[value];

  useEffect(() => {
    if (!frame) return;
    // The first placing, and every move with reduced motion, is instant.
    if (!placed || !plan.moves) {
      thumbX.setValue(frame.x);
      thumbWidth.setValue(frame.width);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!placed) setPlaced(true);
      return;
    }
    const animation = Animated.parallel([
      animateLayoutTo(thumbX, frame.x, plan),
      animateLayoutTo(thumbWidth, frame.width, plan),
    ]);
    animation.start();
    return () => animation.stop();
  }, [frame, placed, plan, thumbX, thumbWidth]);

  const hinted = options.some((option) => option.hint);
  const hintHeight = Math.max(0, ...Object.values<number | undefined>(hintHeights).map(Number));

  return (
    <View style={styles.segmentsBlock}>
      <ScrollView
        horizontal
        bounces={false}
        showsHorizontalScrollIndicator={false}
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        style={[styles.segments, { backgroundColor: theme.colors.fill }]}
        contentContainerStyle={styles.segmentsContent}
      >
        {frame && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.segmentThumb,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                width: thumbWidth,
                transform: [{ translateX: thumbX }],
              },
            ]}
          />
        )}
        {options.map((option) => {
          const on = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={option.label}
              onPress={() => onChange(option.value)}
              onLayout={(event) => {
                const { x, width } = event.nativeEvent.layout;
                setFrames((current) => {
                  const known = current[option.value];
                  return known && known.x === x && known.width === width
                    ? current
                    : { ...current, [option.value]: { x, width } };
                });
              }}
              style={styles.segment}
            >
              {option.icon && (
                <Icon name={option.icon} size={16} color={on ? "text" : "textMuted"} />
              )}
              <Text
                variant="bodyS"
                color={on ? "text" : "textMuted"}
                numberOfLines={1}
                maxFontSizeMultiplier={fontScale.tabLabelMax}
                style={styles.segmentLabel}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {hinted && (
        <View style={[styles.segmentsHints, { minHeight: hintHeight }]}>
          {options.map((option) =>
            option.hint ? (
              <Text
                key={option.value}
                variant="caption"
                color="textMuted"
                accessibilityElementsHidden={option.value !== value}
                importantForAccessibility={option.value === value ? "auto" : "no-hide-descendants"}
                onLayout={(event) => {
                  const height = event.nativeEvent.layout.height;
                  setHintHeights((current) =>
                    current[option.value] === height
                      ? current
                      : { ...current, [option.value]: height },
                  );
                }}
                style={[styles.segmentHint, option.value !== value && styles.hidden]}
              >
                {option.hint}
              </Text>
            ) : null,
          )}
        </View>
      )}
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
  const { theme } = useTheme();
  const { colors } = theme;
  // The thumb travels by the rule of a change of state (150 ms, deceleration
  // at the end); when motion is reduced it does not slide, it is in its new
  // place at once and the colours say what changed.
  const plan = useMotionPlan("state");
  const [position] = useState(() => new Animated.Value(checked ? 1 : 0));
  useEffect(() => {
    const target = checked ? 1 : 0;
    if (!plan.moves) {
      position.setValue(target);
      return;
    }
    const animation = animateTo(position, target, plan);
    animation.start();
    return () => animation.stop();
  }, [checked, position, plan]);

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
  select: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: size.button.m,
    paddingHorizontal: 10,
    borderRadius: radius.s,
    borderWidth: line.width,
  },
  // 14 with the weight of the `label` token (DESIGN.md 7.7 "Кнопка выбора").
  selectLabel: { flex: 1, minWidth: 0, fontFamily: fontFamily.native[typography.label.fontWeight] },
  segmentsBlock: { gap: 6 },
  segments: { flexGrow: 0, borderRadius: radius.s },
  segmentsContent: { flexGrow: 1, minHeight: size.segments, padding: segmentMetrics.inset },
  segment: {
    flexGrow: 1,
    flexShrink: 0,
    flexDirection: "row",
    minHeight: size.segments - 2 * segmentMetrics.inset,
    paddingHorizontal: segmentMetrics.paddingX,
    paddingVertical: 4,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  segmentThumb: {
    position: "absolute",
    top: segmentMetrics.inset,
    bottom: segmentMetrics.inset,
    left: 0,
    borderRadius: radius.s,
    borderWidth: line.width,
  },
  segmentLabel: {
    textAlign: "center",
    fontFamily: fontFamily.native[typography.label.fontWeight],
  },
  segmentsHints: { justifyContent: "flex-start" },
  segmentHint: { position: "absolute", top: 0, left: 0, right: 0 },
  hidden: { opacity: 0 },
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

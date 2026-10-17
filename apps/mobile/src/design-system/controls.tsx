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
import { selectLabelFontSize, selectLabelMetrics } from "./select-label";
import { Text } from "./text";
import { useTheme } from "./theme";

const touchSlop = (height: number) => Math.max(0, (size.touchTarget - height) / 2);

export interface ChipProps {
  children: ReactNode;
  /** A second line under the label — the date under the weekday of a day chip (TASK-078 M-ORD-01). */
  sublabel?: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
  disabled?: boolean;
  /** Chips of one row that share a width (the days of a visit): the floor each one takes; a longer label widens its chip. */
  width?: number;
}

/**
 * Filter chip: 36 high (touch zone 48), a 1 px `borderField` frame like a
 * field (TASK-078 M7: `border` was all but invisible in the light theme);
 * selected — tint and a check mark.
 */
export function Chip({
  children,
  sublabel,
  selected = false,
  onPress,
  icon,
  disabled,
  width,
}: ChipProps) {
  const { theme } = useTheme();
  const { colors } = theme;
  const textColor = disabled ? "textDisabled" : selected ? "accentOnTint" : "text";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={
        sublabel && typeof children === "string" ? `${children}, ${sublabel}` : undefined
      }
      disabled={disabled}
      onPress={onPress}
      hitSlop={touchSlop(size.chip)}
      style={({ pressed }) => [
        styles.chip,
        // A floor, not a fixed width: a label the system font made wider grows the chip instead of being cut.
        width !== undefined && { minWidth: width, justifyContent: "center" },
        {
          backgroundColor: selected ? colors.accentTint : pressed ? colors.fill : "transparent",
          borderColor: selected ? colors.accentTint : disabled ? colors.border : colors.borderField,
        },
      ]}
    >
      {selected ? (
        <Icon name="check" size={16} color="accentOnTint" />
      ) : (
        icon && <Icon name={icon} size={16} color={textColor} />
      )}
      {sublabel ? (
        <View style={styles.chipLines}>
          <Text variant="bodyS" color={textColor} numberOfLines={1}>
            {children}
          </Text>
          <Text variant="caption" color={textColor} numberOfLines={1}>
            {sublabel}
          </Text>
        </View>
      ) : (
        <Text variant="bodyS" color={textColor} style={styles.shrink}>
          {children}
        </Text>
      )}
    </Pressable>
  );
}

export interface StarsInputProps {
  /** 1…5; `null` — not chosen yet. */
  value: number | null;
  onChange?: (value: number) => void;
  /** «Оценка {n} из 5» for each star — what a screen reader says. */
  starLabel: (n: number) => string;
  /** Read only (the score of a review whose text is corrected): shown, not changed. */
  disabled?: boolean;
  /** Smaller stars to show a score, not to choose it. */
  small?: boolean;
}

/**
 * The score of a review (TASK-049.B, M-ORD-05): five stars, each a touch
 * zone of 48 with a 32 star; each is a radio for screen readers, «Оценка 4
 * из 5», checked when it is the score. Chosen stars are filled with the
 * accent; the rest are outlines.
 */
export function StarsInput({ value, onChange, starLabel, disabled, small }: StarsInputProps) {
  // A star to choose is 40 in its 48 zone — the zones touch, so the stars
  // stand 8 apart (TASK-078 M-ORD-05); a shown score is small.
  const starSize = small ? 20 : 40;
  const star = (n: number) => {
    const filled = value !== null && n <= value;
    return (
      <Icon
        name="star"
        size={starSize}
        color={filled ? "accent" : disabled ? "textDisabled" : "textMuted"}
        filled={filled}
      />
    );
  };
  if (small || !onChange) {
    // Only shown: one label for the row, «Оценка 4 из 5».
    return (
      <View style={styles.starsShown} accessible accessibilityLabel={starLabel(value ?? 0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <View key={n}>{star(n)}</View>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.stars} accessibilityRole="radiogroup">
      {[1, 2, 3, 4, 5].map((n) => {
        return (
          <Pressable
            key={n}
            accessibilityRole="radio"
            accessibilityLabel={starLabel(n)}
            accessibilityState={{ checked: value === n, disabled }}
            disabled={disabled}
            onPress={() => onChange(n)}
            style={styles.star}
          >
            {star(n)}
          </Pressable>
        );
      })}
    </View>
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
 * the car and the city of the catalog header (TASK-030.A): 48 high like a
 * field, `surface` with a `borderField` frame (DESIGN 7.7 «Кнопка выбора»,
 * TASK-078 M7), the icon, the value in one line and the caret at the right
 * edge. A value that fits keeps 14; a long one first shrinks a little
 * (not below 12) and then ends in an ellipsis — it never wraps. The app
 * measures the value itself (`selectLabelFontSize`, TASK-030.C): a hidden copy
 * gives its full width, the label its box. Like a tab label, it grows with
 * the system font only to 120 %. It takes the width it is given, so two of
 * them side by side are 50 × 50.
 */
export function SelectButton({ icon, children, onPress, accessibilityLabel }: SelectButtonProps) {
  const { theme } = useTheme();
  const [natural, setNatural] = useState(0);
  const [available, setAvailable] = useState(0);
  const fontSize = selectLabelFontSize(natural, available);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${accessibilityLabel}: ${children}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.select,
        {
          backgroundColor: pressed ? theme.colors.surfaceRaised : theme.colors.surface,
          borderColor: theme.colors.borderField,
        },
      ]}
    >
      <Icon name={icon} size={selectLabelMetrics.icon} color="accent" />
      <Text
        variant="bodyS"
        numberOfLines={1}
        maxFontSizeMultiplier={fontScale.tabLabelMax}
        onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}
        style={[styles.selectLabel, { fontSize }]}
      >
        {children}
      </Text>
      <Icon name="chevronDown" size={selectLabelMetrics.icon} color="textMuted" />
      {/* The full width of the value at 14: unclipped, unseen, unheard. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
        style={styles.measureClip}
      >
        <View style={styles.measureRow}>
          <Text
            variant="bodyS"
            numberOfLines={1}
            maxFontSizeMultiplier={fontScale.tabLabelMax}
            onLayout={(event) => setNatural(event.nativeEvent.layout.width)}
            style={styles.selectLabelFont}
          >
            {children}
          </Text>
        </View>
      </View>
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
 * label (DESIGN 7.7 «ширина по подписи», TASK-078 M-CAT-02) and the control
 * is as wide as its options, so «Рекомендуем · Дешевле · Быстрее» fits a
 * 360-pt phone in every language. Where even that does not fit (four
 * options, the largest font, a narrow phone) the row scrolls sideways
 * instead of wrapping or clipping a word.
 *
 * The line under the control («Сначала — …») is one line (TASK-078 M10).
 */
export function Segments<T extends string>({ label, options, value, onChange }: SegmentsProps<T>) {
  const { theme } = useTheme();
  const plan = useMotionPlan("state");
  const [frames, setFrames] = useState<Partial<Record<T, SegmentFrame>>>({});
  const [thumbX] = useState(() => new Animated.Value(0));
  const [thumbWidth] = useState(() => new Animated.Value(0));
  const [placed, setPlaced] = useState(false);
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
        <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.segmentHint}>
          {options.find((option) => option.value === value)?.hint ?? " "}
        </Text>
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
  stars: { flexDirection: "row", flexWrap: "wrap" },
  starsShown: { flexDirection: "row", gap: 2 },
  star: {
    width: size.touchTarget,
    height: size.touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
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
  chipLines: { alignItems: "center", flexShrink: 1 },
  select: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: selectLabelMetrics.gap,
    minHeight: size.field,
    paddingHorizontal: selectLabelMetrics.paddingX,
    borderRadius: radius.s,
    borderWidth: line.width,
  },
  // 14 with the weight of the `label` token (DESIGN.md 7.7 "Кнопка выбора").
  selectLabelFont: { fontFamily: fontFamily.native[typography.label.fontWeight] },
  selectLabel: { flex: 1, minWidth: 0, fontFamily: fontFamily.native[typography.label.fontWeight] },
  // The hidden copy lays out in a row far wider than any value, inside a
  // zero box that clips it, so it neither shows nor widens anything.
  measureClip: { position: "absolute", left: 0, top: 0, width: 0, height: 0, overflow: "hidden" },
  measureRow: { position: "absolute", left: 0, top: 0, width: 4000, flexDirection: "row" },
  segmentsBlock: { gap: 6, alignItems: "flex-start", alignSelf: "stretch", minWidth: 0 },
  segments: { flexGrow: 0, maxWidth: "100%", borderRadius: radius.s },
  segmentsContent: { minHeight: size.segments, padding: segmentMetrics.inset },
  segment: {
    flexGrow: 0,
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
  segmentHint: { alignSelf: "stretch" },
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

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
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { Icon } from "./Icon";
import { animateLayoutTo, animateTo, useMotionPlan } from "./motion";
import { segmentMetrics, segmentsLayout } from "./segment-metrics";
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
     * The line under the control for the selected option — what choosing it
     * does («Сначала — самая низкая цена»: a sort is an order, not a filter).
     */
    hint?: string;
  }[];
  value: T;
  onChange: (value: T) => void;
  /**
   * Beside the hint, on its right, level with its first line — «Фильтры (N)»
   * of the list (TASK-078.A M-CAT-02).
   */
  aside?: ReactNode;
}

interface SegmentFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The icon of an option and the gap after it, in points. */
const SEGMENT_ICON = 16;
const SEGMENT_GAP = 6;
/** Between the hint and what is beside it. */
const SEGMENT_FOOT_GAP = 12;
/** Between the hint and the aside under it. */
const SEGMENT_FOOT_STACK_GAP = 8;
/** The most lines the hint takes beside the aside before it goes across the width. */
const SEGMENT_HINT_LINES_BESIDE = 3;

/** Kept from the layout and from screen readers: what is drawn only to be measured. */
const measureOnly = {
  pointerEvents: "none",
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
  "aria-hidden": true,
} as const;

/**
 * Segments, 40 high (DESIGN 7.7): the container `fill`, the selected option
 * on a `surface` thumb that slides to it by the rule of a change of state.
 *
 * The control takes the whole width (TASK-078.A): equal cells while the
 * longest label fits its share, cells by their labels when it does not, then
 * a narrower padding and a label down to 12 — and where even that is not
 * enough (four sorts on a 320-pt phone, a large system font) the options go
 * to two rows. A label is never cut, never ends in an ellipsis and never
 * scrolls out of sight; it grows with the system font only to 120 %, like a
 * tab label. The rule is `segmentsLayout`; the widths it needs are the
 * labels' own, measured in one line at the size the phone draws them.
 *
 * The hint under the control («Сначала — …») wraps rather than ending in an
 * ellipsis, and keeps the height of the longest hint, so choosing another
 * option does not move what is below.
 */
export function Segments<T extends string>({
  label,
  options,
  value,
  onChange,
  aside,
}: SegmentsProps<T>) {
  const { theme } = useTheme();
  const plan = useMotionPlan("state");
  const [frames, setFrames] = useState<Partial<Record<T, SegmentFrame>>>({});
  const [labelWidths, setLabelWidths] = useState<Partial<Record<string, number>>>({});
  // Heights of each hint beside the aside («beside:…») and across the whole
  // width («full:…»), and of one line («line»).
  const [hintHeights, setHintHeights] = useState<Partial<Record<string, number>>>({});
  const [asideWidth, setAsideWidth] = useState(0);
  const [available, setAvailable] = useState(0);
  const [thumbX] = useState(() => new Animated.Value(0));
  const [thumbY] = useState(() => new Animated.Value(0));
  const [thumbWidth] = useState(() => new Animated.Value(0));
  const [thumbHeight] = useState(() => new Animated.Value(0));
  const [placed, setPlaced] = useState(false);
  const frame = frames[value];

  useEffect(() => {
    if (!frame) return;
    // The first placing, and every move with reduced motion, is instant.
    if (!placed || !plan.moves) {
      thumbX.setValue(frame.x);
      thumbY.setValue(frame.y);
      thumbWidth.setValue(frame.width);
      thumbHeight.setValue(frame.height);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!placed) setPlaced(true);
      return;
    }
    const animation = Animated.parallel([
      animateLayoutTo(thumbX, frame.x, plan),
      animateLayoutTo(thumbY, frame.y, plan),
      animateLayoutTo(thumbWidth, frame.width, plan),
      animateLayoutTo(thumbHeight, frame.height, plan),
    ]);
    animation.start();
    return () => animation.stop();
  }, [frame, placed, plan, thumbX, thumbY, thumbWidth, thumbHeight]);

  const widths = options.map((option) => {
    const text = labelWidths[option.label];
    return text === undefined ? 0 : text + (option.icon ? SEGMENT_ICON + SEGMENT_GAP : 0);
  });
  const layout = segmentsLayout(available, widths);
  const scaled =
    layout.labelScale === 1
      ? null
      : {
          fontSize: typography.bodyS.fontSize * layout.labelScale,
          lineHeight: typography.bodyS.lineHeight * layout.labelScale,
        };

  const hints = [...new Set(options.flatMap((option) => (option.hint ? [option.hint] : [])))];
  const tallest = (where: "beside" | "full") =>
    Math.max(0, ...hints.map((hint) => hintHeights[`${where}:${hint}`] ?? 0));
  // The hint wraps beside the aside — two lines on a usual phone, three on a
  // narrow one. Where it needs more (a large font), a narrow column of words
  // reads badly: the hint goes across the whole width and the aside under it
  // on the right. Nothing is cut either way.
  const asideRoom = aside ? asideWidth + SEGMENT_FOOT_GAP : 0;
  const line = hintHeights.line ?? 0;
  const stacked =
    Boolean(aside) && line > 0 && tallest("beside") > SEGMENT_HINT_LINES_BESIDE * line + 1;
  const hintHeight = tallest(aside && !stacked ? "beside" : "full");
  const remember =
    (key: string, next: number) =>
    (current: Partial<Record<string, number>>): Partial<Record<string, number>> =>
      current[key] === next ? current : { ...current, [key]: next };

  return (
    <View style={styles.segmentsBlock}>
      {/* The labels in one line, unconstrained: the widths the layout needs. */}
      <View {...measureOnly} style={styles.measureClip}>
        <View style={styles.measureRow}>
          {options.map((option) => (
            <Text
              key={option.value}
              variant="bodyS"
              numberOfLines={1}
              maxFontSizeMultiplier={fontScale.tabLabelMax}
              style={styles.segmentLabel}
              onLayout={(event) =>
                setLabelWidths(remember(option.label, event.nativeEvent.layout.width))
              }
            >
              {option.label}
            </Text>
          ))}
        </View>
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        onLayout={(event) =>
          setAvailable(event.nativeEvent.layout.width - 2 * segmentMetrics.inset)
        }
        style={[styles.segments, { backgroundColor: theme.colors.fill }]}
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
                height: thumbHeight,
                transform: [{ translateX: thumbX }, { translateY: thumbY }],
              },
            ]}
          />
        )}
        {layout.rows.flatMap((row, rowIndex) => [
          // A row after the first starts on a line of its own.
          ...(rowIndex > 0 ? [<View key={`break-${rowIndex}`} style={styles.segmentBreak} />] : []),
          ...row.options.map((index) => {
            const option = options[index]!;
            const on = option.value === value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={option.label}
                onPress={() => onChange(option.value)}
                onLayout={(event) => {
                  const { x, y, width, height } = event.nativeEvent.layout;
                  setFrames((current) => {
                    const known = current[option.value];
                    return known &&
                      known.x === x &&
                      known.y === y &&
                      known.width === width &&
                      known.height === height
                      ? current
                      : { ...current, [option.value]: { x, y, width, height } };
                  });
                }}
                style={[
                  styles.segment,
                  row.equal ? styles.segmentEqual : styles.segmentByLabel,
                  { paddingHorizontal: layout.paddingX },
                ]}
              >
                {option.icon && (
                  <Icon name={option.icon} size={SEGMENT_ICON} color={on ? "text" : "textMuted"} />
                )}
                <Text
                  variant="bodyS"
                  color={on ? "text" : "textMuted"}
                  numberOfLines={2}
                  maxFontSizeMultiplier={fontScale.tabLabelMax}
                  style={[styles.segmentLabel, scaled]}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          }),
        ])}
      </View>
      {(hints.length > 0 || aside) && (
        <View style={[styles.segmentFoot, stacked && styles.segmentFootStacked]}>
          {/* Every hint beside the aside and across the whole width: the
              widths here do not depend on where the aside is, so the choice
              cannot swing back and forth. */}
          <View {...measureOnly} style={[styles.hintMeasureClip, { right: asideRoom }]}>
            <View style={styles.hintMeasureColumn}>
              <Text
                variant="caption"
                onLayout={(event) =>
                  setHintHeights(remember("line", event.nativeEvent.layout.height))
                }
              >
                {"А"}
              </Text>
              {hints.map((hint) => (
                <Text
                  key={hint}
                  variant="caption"
                  onLayout={(event) =>
                    setHintHeights(remember(`beside:${hint}`, event.nativeEvent.layout.height))
                  }
                >
                  {hint}
                </Text>
              ))}
            </View>
          </View>
          <View {...measureOnly} style={styles.hintMeasureClip}>
            <View style={styles.hintMeasureColumn}>
              {hints.map((hint) => (
                <Text
                  key={hint}
                  variant="caption"
                  onLayout={(event) =>
                    setHintHeights(remember(`full:${hint}`, event.nativeEvent.layout.height))
                  }
                >
                  {hint}
                </Text>
              ))}
            </View>
          </View>
          {hints.length > 0 && (
            <Text
              variant="caption"
              color="textMuted"
              testID="segments-hint"
              style={[
                stacked ? styles.segmentHintAcross : styles.segmentHint,
                { minHeight: hintHeight },
              ]}
            >
              {options.find((option) => option.value === value)?.hint ?? ""}
            </Text>
          )}
          {aside && (
            <View
              style={stacked ? styles.segmentAsideUnder : styles.segmentAside}
              onLayout={(event) => setAsideWidth(event.nativeEvent.layout.width)}
            >
              {aside}
            </View>
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
  segmentsBlock: { gap: 6, alignSelf: "stretch", minWidth: 0 },
  segments: {
    flexDirection: "row",
    flexWrap: "wrap",
    minHeight: size.segments,
    padding: segmentMetrics.inset,
    borderRadius: radius.s,
  },
  segment: {
    flexDirection: "row",
    minHeight: size.segments - 2 * segmentMetrics.inset,
    paddingVertical: 4,
    alignItems: "center",
    justifyContent: "center",
    gap: SEGMENT_GAP,
  },
  segmentEqual: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  segmentByLabel: { flexGrow: 1, flexShrink: 0, flexBasis: "auto" },
  segmentBreak: { flexBasis: "100%", height: 0 },
  segmentThumb: {
    position: "absolute",
    top: 0,
    left: 0,
    borderRadius: radius.s,
    borderWidth: line.width,
  },
  segmentLabel: {
    textAlign: "center",
    fontFamily: fontFamily.native[typography.label.fontWeight],
  },
  segmentFoot: { flexDirection: "row", alignItems: "flex-start", gap: SEGMENT_FOOT_GAP },
  segmentFootStacked: { flexDirection: "column", gap: SEGMENT_FOOT_STACK_GAP },
  segmentHint: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  segmentHintAcross: { alignSelf: "stretch" },
  segmentAside: { flexShrink: 0 },
  segmentAsideUnder: { alignSelf: "flex-end" },
  // Hints at the width of their place: the clip spans it, the column under it is unbounded.
  hintMeasureClip: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: 0,
    overflow: "hidden",
  },
  hintMeasureColumn: { position: "absolute", left: 0, right: 0, top: 0 },
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

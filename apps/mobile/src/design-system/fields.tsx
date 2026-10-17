import { KZ_PHONE_PLACEHOLDER, maskKzPhoneInput } from "@adclub/domain";
import {
  formatOrderCode,
  line,
  ORDER_CODE_LENGTH,
  radius,
  sanitizeOrderCode,
  size,
  splitOrderCode,
} from "@adclub/ui-core";
import { useRef, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
} from "react-native";
import { codeCellLayout } from "./code-cell-metrics";
import { Icon } from "./Icon";
import { AiBadge } from "./marks";
import { Text, textStyles } from "./text";
import { useTheme } from "./theme";

export interface TextFieldProps extends Omit<TextInputProps, "value" | "onChangeText" | "style"> {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  hint?: string;
  /** Error under the field; the typed value is kept (DESIGN.md 7.7). */
  error?: string;
  /** AI value awaiting confirmation (DESIGN.md 7.9): "распознано" / "предложено ИИ". */
  aiLabel?: string;
  confirmed?: boolean;
  disabled?: boolean;
  /**
   * A value that is shown, not edited (the phone of the account, TASK-078
   * M-PRO-02): readable `text` with a lock, not the `textDisabled` of a
   * switched-off field — nothing is wrong with it, it just cannot change here.
   */
  readOnly?: boolean;
  /** «0 / 1000» at the right of the hint line (TASK-078 M-ORD-05). */
  counter?: { count: number; max: number; text: string };
  trailing?: ReactNode;
}

export function TextField({
  label,
  value,
  onChangeText,
  hint,
  error,
  aiLabel,
  confirmed,
  disabled,
  readOnly,
  counter,
  trailing,
  ...rest
}: TextFieldProps) {
  const { theme } = useTheme();
  const { colors } = theme;
  const [focused, setFocused] = useState(false);
  const ai = Boolean(aiLabel) && !error;
  const editable = !disabled && !readOnly;

  return (
    <View style={styles.field}>
      <Text variant="bodyS" color="textMuted" style={styles.label}>
        {label}
      </Text>
      <View
        style={[
          styles.control,
          // Several lines (a review, a complaint): the text starts at the top.
          rest.multiline ? styles.controlMultiline : null,
          {
            backgroundColor: disabled ? colors.fill : ai ? colors.aiTint : colors.surface,
            borderColor: error
              ? colors.danger
              : focused && editable
                ? colors.accent
                : ai
                  ? colors.aiBorder
                  : colors.borderField,
            // Active and invalid: still 1 px, only the color changes (D-068).
            borderWidth: line.width,
            paddingHorizontal: 12,
          },
        ]}
      >
        <TextInput
          {...rest}
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          accessibilityState={{ disabled: !editable }}
          editable={editable}
          value={value}
          onChangeText={onChangeText}
          onFocus={(event) => {
            setFocused(true);
            rest.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            rest.onBlur?.(event);
          }}
          placeholderTextColor={colors.textMuted}
          cursorColor={colors.accent}
          selectionColor={colors.accent}
          style={[
            textStyles.body,
            styles.input,
            rest.multiline ? styles.inputMultiline : null,
            { color: disabled ? colors.textDisabled : colors.text },
          ]}
        />
        {ai && aiLabel && <AiBadge>{aiLabel}</AiBadge>}
        {confirmed && !ai && !error && <Icon name="circleCheck" size={20} color="success" />}
        {readOnly && <Icon name="lock" size={20} color="textMuted" />}
        {trailing}
      </View>
      {error && (
        <View style={styles.help} accessibilityLiveRegion="polite">
          <Icon name="alertTriangle" size={16} color="danger" />
          <Text variant="caption" color="danger" style={styles.helpText}>
            {error}
          </Text>
        </View>
      )}
      {(hint !== undefined || counter) && (
        <View style={styles.hintRow}>
          {hint !== undefined && (
            <Text variant="caption" color="textMuted" style={styles.helpText}>
              {hint}
            </Text>
          )}
          {counter && (
            <Text
              variant="caption"
              color={counter.count > counter.max ? "danger" : "textMuted"}
              style={styles.counter}
            >
              {counter.text}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

export interface PhoneFieldProps extends Omit<TextFieldProps, "value" | "onChangeText"> {
  /** What the field shows — the masked text («+7 701 123 45 67»). */
  value: string;
  onChangeText: (masked: string) => void;
}

/**
 * The field a Kazakhstan number is typed into (M-AUTH-01, TASK-078 M4):
 * the mask «+7 7__ ___ __ __» of `@adclub/domain` groups the digits as they
 * come and keeps the country code; the screen reads the number back with
 * `normalizeKzMobilePhone`.
 */
export function PhoneField({ value, onChangeText, ...rest }: PhoneFieldProps) {
  return (
    <TextField
      {...rest}
      value={value}
      onChangeText={(next) => onChangeText(maskKzPhoneInput(next, value))}
      placeholder={KZ_PHONE_PLACEHOLDER}
      keyboardType="phone-pad"
      textContentType="telephoneNumber"
      autoComplete="tel"
    />
  );
}

export interface SearchFieldProps extends Omit<TextInputProps, "value" | "onChangeText" | "style"> {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  clearLabel: string;
}

/** Search: 48 high, search icon on the left, clear on the right; active — an `accent` frame (DESIGN.md 7.7). */
export function SearchField({ label, value, onChangeText, clearLabel, ...rest }: SearchFieldProps) {
  const { theme } = useTheme();
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={[
        styles.control,
        styles.search,
        {
          backgroundColor: theme.colors.surface,
          borderColor: focused ? theme.colors.accent : theme.colors.borderField,
        },
      ]}
    >
      <Icon name="search" size={20} color="textMuted" />
      <TextInput
        {...rest}
        ref={input}
        accessibilityLabel={label}
        accessibilityRole="search"
        value={value}
        onChangeText={onChangeText}
        onFocus={(event) => {
          setFocused(true);
          rest.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          rest.onBlur?.(event);
        }}
        returnKeyType="search"
        placeholderTextColor={theme.colors.textMuted}
        cursorColor={theme.colors.accent}
        selectionColor={theme.colors.accent}
        style={[textStyles.body, styles.input, { color: theme.colors.text }]}
      />
      {value.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={clearLabel}
          onPress={() => {
            onChangeText("");
            input.current?.focus();
          }}
          style={styles.clear}
        >
          <Icon name="x" size={20} color="textMuted" />
        </Pressable>
      )}
    </View>
  );
}

export interface SearchEntryProps {
  /** Screen reader text: what pressing it opens. */
  label: string;
  placeholder: string;
  onPress: () => void;
  /** Without a network the search cannot work: the entry says so instead of opening (TASK-078). */
  disabled?: boolean;
  disabledHint?: string;
}

/**
 * The search field of a screen that only opens the search (M-CAT-01 «Артикул
 * или название», TASK-044): looks like `SearchField`, is a button — typing
 * happens on the search screen itself.
 */
export function SearchEntry({
  label,
  placeholder,
  onPress,
  disabled,
  disabledHint,
}: SearchEntryProps) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="search"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      accessibilityHint={disabled ? disabledHint : undefined}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        styles.search,
        styles.entry,
        {
          backgroundColor: disabled
            ? theme.colors.fill
            : pressed
              ? theme.colors.surfaceRaised
              : theme.colors.surface,
          borderColor: disabled ? theme.colors.border : theme.colors.borderField,
        },
      ]}
    >
      <Icon name="search" size={20} color={disabled ? "textDisabled" : "textMuted"} />
      <Text
        variant="body"
        color={disabled ? "textDisabled" : "textMuted"}
        numberOfLines={1}
        style={styles.entryText}
      >
        {placeholder}
      </Text>
      {disabled && disabledHint && (
        <Text variant="caption" color="textMuted">
          {disabledHint}
        </Text>
      )}
    </Pressable>
  );
}

export interface CodeCellsProps {
  label: string;
  /** The label is for screen readers only — the heading of the screen already says it. */
  labelHidden?: boolean;
  value: string;
  onChangeText: (value: string) => void;
  error?: string;
  autoFocus?: boolean;
}

/**
 * Six code cells, groups 3 + 3 (DESIGN.md 7.10), across the column: the two
 * groups stand at its edges. A single hidden input receives typing and
 * paste; digits only. Cells are 48 wide and narrower, down to 36, only where
 * the row does not fit (a 320-pt phone, the showcase; `codeCellLayout`).
 */
export function CodeCells({
  label,
  labelHidden,
  value,
  onChangeText,
  error,
  autoFocus,
}: CodeCellsProps) {
  const { theme } = useTheme();
  const { colors } = theme;
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const [rowWidth, setRowWidth] = useState(0);
  const cells = codeCellLayout(rowWidth);
  const code = sanitizeOrderCode(value);
  const groups = splitOrderCode(code.padEnd(ORDER_CODE_LENGTH, " "));
  const activeIndex = Math.min(code.length, ORDER_CODE_LENGTH - 1);

  return (
    <View style={styles.field} onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}>
      {!labelHidden && (
        <Text variant="bodyS" color="textMuted" style={styles.label}>
          {label}
        </Text>
      )}
      <Pressable
        accessibilityRole="none"
        onPress={() => input.current?.focus()}
        style={[styles.cells, { gap: cells.groupGap }]}
      >
        {groups.map((group, groupIndex) => (
          <View key={groupIndex} style={[styles.group, { gap: cells.gap }]}>
            {[...group].map((digit, digitIndex) => {
              const index = groupIndex * 3 + digitIndex;
              const highlighted = Boolean(error) || (focused && index === activeIndex);
              return (
                <View
                  key={index}
                  style={[
                    styles.cell,
                    {
                      width: cells.cell,
                      backgroundColor: colors.surface,
                      borderColor: error
                        ? colors.danger
                        : highlighted
                          ? colors.accent
                          : colors.borderField,
                      borderWidth: line.width,
                    },
                  ]}
                >
                  <Text variant="codeXL" maxFontSizeMultiplier={1}>
                    {digit.trim()}
                  </Text>
                </View>
              );
            })}
          </View>
        ))}
        <TextInput
          ref={input}
          value={code}
          onChangeText={(text) => onChangeText(sanitizeOrderCode(text))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={ORDER_CODE_LENGTH}
          autoFocus={autoFocus}
          caretHidden
          accessibilityLabel={`${label}: ${formatOrderCode(code)}`}
          accessibilityHint={error}
          style={styles.hiddenInput}
        />
      </Pressable>
      {error && (
        <View style={styles.help} accessibilityLiveRegion="polite">
          <Icon name="alertTriangle" size={16} color="danger" />
          <Text variant="caption" color="danger" style={styles.helpText}>
            {error}
          </Text>
        </View>
      )}
    </View>
  );
}

export interface KeypadProps {
  onDigit: (digit: string) => void;
  onErase: () => void;
  eraseLabel: string;
  submit?: { label: string; onPress: () => void; disabled?: boolean };
}

/** Manual code entry keypad: keys 64 high, digits `title` (DESIGN.md 7.10). */
export function Keypad({ onDigit, onErase, eraseLabel, submit }: KeypadProps) {
  const { theme } = useTheme();
  const key = (
    content: ReactNode,
    onPress: () => void,
    options: { label?: string; ghost?: boolean; disabled?: boolean } = {},
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={options.label}
      accessibilityState={{ disabled: options.disabled }}
      disabled={options.disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.key,
        options.ghost
          ? null
          : {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              borderWidth: StyleSheet.hairlineWidth,
            },
        pressed && { backgroundColor: theme.colors.surfaceRaised },
      ]}
    >
      {content}
    </Pressable>
  );
  const digitKey = (digit: string) => (
    <View style={styles.keyCell} key={digit}>
      {key(<Text variant="title">{digit}</Text>, () => onDigit(digit))}
    </View>
  );
  return (
    <View style={styles.keypad}>
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(digitKey)}
      <View style={styles.keyCell}>
        {submit &&
          key(
            <Text variant="label" color={submit.disabled ? "textDisabled" : "text"}>
              {submit.label}
            </Text>,
            submit.onPress,
            { disabled: submit.disabled },
          )}
      </View>
      {digitKey("0")}
      <View style={styles.keyCell}>
        {key(<Icon name="backspace" size={24} />, onErase, { label: eraseLabel, ghost: true })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { alignSelf: "stretch" },
  label: { marginBottom: 6 },
  control: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: size.field,
    borderRadius: radius.s,
    borderWidth: line.width,
  },
  // The browser draws its own focus outline inside an <input> (its style is
  // `auto`, so a zero width does not remove it); the frame of the field is the
  // focus (DESIGN 7.7, TASK-078 M3). React Native's types know no `none`.
  input: {
    flex: 1,
    minHeight: 44,
    paddingVertical: 10,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as unknown as TextStyle) : null),
  },
  controlMultiline: { alignItems: "flex-start" },
  inputMultiline: { minHeight: 120, maxHeight: 240, textAlignVertical: "top" },
  search: { paddingLeft: 12, paddingRight: 0 },
  entry: { paddingRight: 12 },
  entryText: { flex: 1 },
  clear: {
    width: size.touchTarget,
    height: size.touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  help: { flexDirection: "row", gap: 4, marginTop: 6, alignItems: "flex-start" },
  helpText: { flex: 1 },
  hintRow: { flexDirection: "row", gap: 8, marginTop: 6, alignItems: "flex-start" },
  counter: { marginLeft: "auto" },
  cells: { flexDirection: "row", alignSelf: "stretch", justifyContent: "space-between" },
  group: { flexDirection: "row" },
  cell: {
    height: size.codeCell.height,
    borderRadius: radius.s,
    alignItems: "center",
    justifyContent: "center",
  },
  hiddenInput: { position: "absolute", width: 1, height: 1, opacity: 0 },
  keypad: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4 },
  keyCell: { width: "33.333%", padding: 4 },
  key: {
    minHeight: size.keypadKey,
    borderRadius: radius.s,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
});

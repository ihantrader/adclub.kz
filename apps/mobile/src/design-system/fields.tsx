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
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from "react-native";
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
  trailing,
  ...rest
}: TextFieldProps) {
  const { theme } = useTheme();
  const { colors } = theme;
  const [focused, setFocused] = useState(false);
  const active = Boolean(error) || focused;
  const ai = Boolean(aiLabel) && !error;

  return (
    <View style={styles.field}>
      <Text variant="bodyS" color="textMuted" style={styles.label}>
        {label}
      </Text>
      <View
        style={[
          styles.control,
          {
            backgroundColor: disabled ? colors.fill : ai ? colors.aiTint : colors.surface,
            borderColor: error
              ? colors.danger
              : focused
                ? colors.accent
                : ai
                  ? colors.aiBorder
                  : colors.borderField,
            borderWidth: active ? line.fieldActiveWidth : line.width,
            paddingHorizontal: active ? 11 : 12,
          },
        ]}
      >
        <TextInput
          {...rest}
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          accessibilityState={{ disabled }}
          editable={!disabled}
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
            { color: disabled ? colors.textDisabled : colors.text },
          ]}
        />
        {ai && aiLabel && <AiBadge>{aiLabel}</AiBadge>}
        {confirmed && !ai && !error && <Icon name="circleCheck" size={20} color="success" />}
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
      {hint && (
        <Text variant="caption" color="textMuted" style={styles.hint}>
          {hint}
        </Text>
      )}
    </View>
  );
}

export interface SearchFieldProps extends Omit<TextInputProps, "value" | "onChangeText" | "style"> {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  clearLabel: string;
}

/** Search: 48 high, search icon on the left, clear on the right (DESIGN.md 7.7). */
export function SearchField({ label, value, onChangeText, clearLabel, ...rest }: SearchFieldProps) {
  const { theme } = useTheme();
  const input = useRef<TextInput>(null);
  return (
    <View
      style={[
        styles.control,
        styles.search,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.borderField },
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
        returnKeyType="search"
        placeholderTextColor={theme.colors.textMuted}
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

export interface CodeCellsProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  error?: string;
  autoFocus?: boolean;
}

/**
 * Six code cells, groups 3 + 3 (DESIGN.md 7.10). A single hidden input
 * receives typing and paste; digits only.
 */
export function CodeCells({ label, value, onChangeText, error, autoFocus }: CodeCellsProps) {
  const { theme } = useTheme();
  const { colors } = theme;
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const code = sanitizeOrderCode(value);
  const groups = splitOrderCode(code.padEnd(ORDER_CODE_LENGTH, " "));
  const activeIndex = Math.min(code.length, ORDER_CODE_LENGTH - 1);

  return (
    <View style={styles.field}>
      <Text variant="bodyS" color="textMuted" style={styles.label}>
        {label}
      </Text>
      <Pressable
        accessibilityRole="none"
        onPress={() => input.current?.focus()}
        style={styles.cells}
      >
        {groups.map((group, groupIndex) => (
          <View key={groupIndex} style={styles.group}>
            {[...group].map((digit, digitIndex) => {
              const index = groupIndex * 3 + digitIndex;
              const highlighted = Boolean(error) || (focused && index === activeIndex);
              return (
                <View
                  key={index}
                  style={[
                    styles.cell,
                    {
                      backgroundColor: colors.surface,
                      borderColor: error
                        ? colors.danger
                        : highlighted
                          ? colors.accent
                          : colors.borderField,
                      borderWidth: highlighted ? line.fieldActiveWidth : line.width,
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
              borderWidth: 1,
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
  input: { flex: 1, minHeight: 44, paddingVertical: 10 },
  search: { paddingLeft: 12, paddingRight: 0 },
  clear: {
    width: size.touchTarget,
    height: size.touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  help: { flexDirection: "row", gap: 4, marginTop: 6, alignItems: "flex-start" },
  helpText: { flex: 1 },
  hint: { marginTop: 6 },
  cells: { flexDirection: "row", gap: 16, alignSelf: "flex-start" },
  group: { flexDirection: "row", gap: 8 },
  cell: {
    width: size.codeCell.width,
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

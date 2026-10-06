import {
  formatOrderCode,
  ORDER_CODE_LENGTH,
  sanitizeOrderCode,
  splitOrderCode,
} from "@adclub/ui-core";
import { useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./Icon";
import { AiBadge } from "./marks";
import { cx } from "./cx";

/** A press shortly before focus means the focus came from a pointer, not the keyboard. */
const POINTER_FOCUS_WINDOW_MS = 1000;

/**
 * Whether the field was focused from the keyboard. A text input matches
 * `:focus-visible` after a click too, so CSS alone cannot tell the two apart:
 * a click or tap keeps the 1 px active border, the keyboard adds the 2 px ring
 * every element has (DESIGN.md 7.7, D-068). Handlers go on the wrapper —
 * React focus events bubble.
 */
function useKeyboardFocus() {
  const pressedAt = useRef(-Infinity);
  const [keyboard, setKeyboard] = useState(false);
  return {
    keyboard,
    handlers: {
      onPointerDown: () => {
        pressedAt.current = Date.now();
      },
      onFocus: () => {
        setKeyboard(Date.now() - pressedAt.current > POINTER_FOCUS_WINDOW_MS);
        pressedAt.current = -Infinity;
      },
      onBlur: () => setKeyboard(false),
    },
  };
}

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value"
> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  /** Error text under the field; the typed value is kept (DESIGN.md 7.7). */
  error?: ReactNode;
  /**
   * Marks the value as proposed or recognized by AI and not yet confirmed
   * (DESIGN.md 7.9), e.g. "распознано". Clear it once a person confirms or edits.
   */
  aiLabel?: string;
  /** Short success check after confirmation (7.9). */
  confirmed?: boolean;
  trailing?: ReactNode;
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  aiLabel,
  confirmed,
  trailing,
  disabled,
  className,
  id,
  ...rest
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");
  const focus = useKeyboardFocus();

  return (
    <div className={cx("ac-field", className)}>
      <label className="ac-field__label" htmlFor={inputId}>
        {label}
      </label>
      <div
        {...focus.handlers}
        className={cx(
          "ac-field__control",
          error ? "ac-field__control--error" : null,
          aiLabel && !error ? "ac-field__control--ai" : null,
          disabled && "ac-field__control--disabled",
          focus.keyboard && "ac-field__control--keyboard",
        )}
      >
        <input
          {...rest}
          id={inputId}
          className="ac-field__input"
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {aiLabel && !error && <AiBadge>{aiLabel}</AiBadge>}
        {confirmed && !aiLabel && !error && (
          <span className="ac-field__confirmed">
            <Icon name="circleCheck" size={20} />
          </span>
        )}
        {trailing}
      </div>
      {error && (
        <p className="ac-field__help ac-field__help--error" id={errorId}>
          <Icon name="alertTriangle" size={16} />
          <span>{error}</span>
        </p>
      )}
      {hint && (
        <p className="ac-field__help" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

export interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value" | "type"
> {
  /** Accessible name (the field shows only a placeholder). */
  label: string;
  value: string;
  onChange: (value: string) => void;
  clearLabel: string;
}

export function SearchField({
  label,
  value,
  onChange,
  clearLabel,
  className,
  ...rest
}: SearchFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const focus = useKeyboardFocus();
  return (
    <div
      {...focus.handlers}
      className={cx("ac-search", focus.keyboard && "ac-search--keyboard", className)}
      role="search"
    >
      <Icon name="search" size={20} />
      <input
        {...rest}
        ref={input}
        type="search"
        aria-label={label}
        className="ac-search__input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button
          type="button"
          className="ac-icon-button"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
        >
          <Icon name="x" size={20} />
        </button>
      )}
    </div>
  );
}

export interface CodeCellsProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: ReactNode;
  autoFocus?: boolean;
  disabled?: boolean;
  /**
   * `false` — the page has its own keypad (S-SCAN-02): a phone's system
   * keyboard does not come up over it (`inputmode="none"`); a physical
   * keyboard and pasting still work.
   */
  systemKeyboard?: boolean;
  /** Enter in the field (a physical keyboard): «Найти». */
  onSubmit?: () => void;
}

/**
 * Six code cells in groups of three (S-SCAN-02, DESIGN.md 7.10). One real
 * input sits over the cells, so typing, pasting, deleting and screen readers
 * work as with a normal field; non-digits are dropped.
 */
export function CodeCells({
  label,
  value,
  onChange,
  error,
  autoFocus,
  disabled,
  systemKeyboard = true,
  onSubmit,
}: CodeCellsProps) {
  const id = useId();
  const code = sanitizeOrderCode(value);
  const groups = splitOrderCode(code.padEnd(ORDER_CODE_LENGTH, " "));
  const activeIndex = Math.min(code.length, ORDER_CODE_LENGTH - 1);
  const focus = useKeyboardFocus();

  return (
    <div className="ac-code">
      <label className="ac-field__label" htmlFor={id}>
        {label}
      </label>
      <div
        {...focus.handlers}
        className={cx(
          "ac-code__cells",
          error ? "ac-code__cells--error" : null,
          focus.keyboard && "ac-code__cells--keyboard",
        )}
      >
        <input
          id={id}
          className="ac-code__input"
          value={code}
          inputMode={systemKeyboard ? "numeric" : "none"}
          autoComplete={systemKeyboard ? "one-time-code" : "off"}
          // No native `maxLength`: it would cut a pasted «482 915» / «482-915»
          // before its separators are dropped; `sanitizeOrderCode` keeps six digits.
          autoFocus={autoFocus}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          aria-label={`${label}: ${formatOrderCode(code)}`}
          onChange={(event) => onChange(sanitizeOrderCode(event.target.value))}
          onKeyDown={
            onSubmit
              ? (event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onSubmit();
                  }
                }
              : undefined
          }
        />
        {groups.map((group, groupIndex) => (
          <span className="ac-code__group" key={groupIndex} aria-hidden="true">
            {[...group].map((digit, digitIndex) => {
              const index = groupIndex * 3 + digitIndex;
              return (
                <span
                  key={index}
                  className={cx("ac-code__cell", index === activeIndex && "ac-code__cell--active")}
                >
                  {digit.trim()}
                </span>
              );
            })}
          </span>
        ))}
      </div>
      {error && (
        <p className="ac-field__help ac-field__help--error" id={`${id}-error`}>
          <Icon name="alertTriangle" size={16} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export interface KeypadProps {
  onDigit: (digit: string) => void;
  onErase: () => void;
  eraseLabel: string;
  /** Optional key in the bottom-left corner (e.g. "Найти"). */
  submit?: { label: string; onPress: () => void; disabled?: boolean };
  /** Every key waits (a search the keys started is going, TASK-033.A). */
  disabled?: boolean;
}

/** Digit keypad of the manual code entry: keys 64 high, digits `title` (DESIGN.md 7.10). */
export function Keypad({ onDigit, onErase, eraseLabel, submit, disabled }: KeypadProps) {
  const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  return (
    <div className="ac-keypad">
      {digits.map((digit) => (
        <button
          type="button"
          key={digit}
          className="ac-keypad__key ac-text-title"
          disabled={disabled}
          onClick={() => onDigit(digit)}
        >
          {digit}
        </button>
      ))}
      {submit ? (
        <button
          type="button"
          className="ac-keypad__key ac-keypad__key--action"
          disabled={disabled || submit.disabled}
          onClick={submit.onPress}
        >
          {submit.label}
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        className="ac-keypad__key ac-text-title"
        disabled={disabled}
        onClick={() => onDigit("0")}
      >
        0
      </button>
      <button
        type="button"
        className="ac-keypad__key ac-keypad__key--ghost"
        aria-label={eraseLabel}
        title={eraseLabel}
        disabled={disabled}
        onClick={onErase}
      >
        <Icon name="backspace" size={24} />
      </button>
    </div>
  );
}

import { clampQuantity, quantityControls, type IconName } from "@adclub/ui-core";
import { useId, type ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";

export interface ChipProps {
  selected?: boolean;
  onClick?: () => void;
  icon?: IconName;
  disabled?: boolean;
  children: ReactNode;
}

/** Filter chip: 36 high, 48 touch zone; selected — tint, text and a check mark (7.7). */
export function Chip({ selected = false, onClick, icon, disabled, children }: ChipProps) {
  return (
    <button
      type="button"
      className={cx("ac-chip", selected && "ac-chip--selected")}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      {selected ? <Icon name="check" size={16} /> : icon && <Icon name={icon} size={16} />}
      <span>{children}</span>
    </button>
  );
}

/**
 * A row of chips (TASK-079, C10): one line that scrolls sideways when it is
 * wider than the screen, never a second and a third row.
 */
export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ac-chip-row" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export interface FilterSelectProps<T extends string> {
  /** «Статус» — said before the value: «Статус: все». */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
}

/**
 * A filter with many values as one chip «Статус: все ▾» (TASK-079, C10) —
 * the browser's own list opens on it (a sheet of choices on a phone). A
 * chosen value other than the first («все») is shown as selected.
 */
export function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
}: FilterSelectProps<T>) {
  const chosen = options.find((option) => option.value === value) ?? options[0];
  const active = options[0] !== undefined && value !== options[0].value;
  return (
    <label
      className={cx("ac-chip", "ac-filter-select", active && "ac-chip--selected")}
      aria-disabled={disabled || undefined}
    >
      <span aria-hidden="true">
        {label}: {chosen?.label}
      </span>
      <Icon name="chevronDown" size={16} />
      <select
        className="ac-filter-select__input"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

export interface SegmentsProps<T extends string> {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * Up to four options (DESIGN.md 7.7): each as wide as its label, in one
 * line; when they don't fit (long Kazakh labels, a phone of 320) the row
 * scrolls sideways — never wraps (TASK-079).
 */
export function Segments<T extends string>({ label, options, value, onChange }: SegmentsProps<T>) {
  const name = useId();
  return (
    <div className="ac-segments" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label
          key={option.value}
          className={cx("ac-segments__item", option.value === value && "ac-segments__item--on")}
        >
          <input
            type="radio"
            className="ac-visually-hidden"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          {option.icon && <Icon name={option.icon} size={16} />}
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

export interface SwitchProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  description?: ReactNode;
}

export function Switch({ label, checked, onChange, disabled, description }: SwitchProps) {
  const id = useId();
  return (
    <div className={cx("ac-toggle", disabled && "ac-toggle--disabled")}>
      <span className="ac-toggle__text">
        <label htmlFor={id}>{label}</label>
        {description && <span className="ac-toggle__description">{description}</span>}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={cx("ac-switch", checked && "ac-switch--on")}
        onClick={() => onChange(!checked)}
      >
        <span className="ac-switch__thumb" />
      </button>
    </div>
  );
}

export interface CheckboxProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  description?: ReactNode;
}

export function Checkbox({ label, checked, onChange, disabled, description }: CheckboxProps) {
  const id = useId();
  return (
    <label className={cx("ac-check", disabled && "ac-check--disabled")}>
      {/* Named by its words explicitly (TASK-079): a screen reader said «on». */}
      <input
        type="checkbox"
        className="ac-visually-hidden ac-check__input"
        checked={checked}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ac-check__box" aria-hidden="true">
        {checked && <Icon name="check" size={16} />}
      </span>
      <span className="ac-toggle__text">
        <span id={`${id}-label`}>{label}</span>
        {description && (
          <span className="ac-toggle__description" id={`${id}-description`}>
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

export interface RadioProps {
  name: string;
  label: ReactNode;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  description?: ReactNode;
}

export function Radio({ name, label, checked, onChange, disabled, description }: RadioProps) {
  const id = useId();
  return (
    <label className={cx("ac-check", disabled && "ac-check--disabled")}>
      <input
        type="radio"
        name={name}
        className="ac-visually-hidden ac-check__input"
        checked={checked}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        onChange={onChange}
      />
      <span className="ac-radio" aria-hidden="true" />
      <span className="ac-toggle__text">
        <span id={`${id}-label`}>{label}</span>
        {description && (
          <span className="ac-toggle__description" id={`${id}-description`}>
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

export interface QuantityProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Accessible name, e.g. "Количество". */
  label: string;
  decreaseLabel: string;
  increaseLabel: string;
}

/** "−" value "+", buttons 44 (touch zone 48); "−" disabled at the minimum. */
export function Quantity({
  value,
  onChange,
  min = 1,
  max,
  label,
  decreaseLabel,
  increaseLabel,
}: QuantityProps) {
  const { canDecrease, canIncrease } = quantityControls(value, min, max);
  return (
    <div className="ac-quantity" role="group" aria-label={label}>
      <button
        type="button"
        className="ac-quantity__button"
        aria-label={decreaseLabel}
        disabled={!canDecrease}
        onClick={() => onChange(clampQuantity(value - 1, min, max))}
      >
        <Icon name="minus" size={20} />
      </button>
      <output className="ac-quantity__value ac-text-body-strong" aria-live="polite">
        {value}
      </output>
      <button
        type="button"
        className="ac-quantity__button"
        aria-label={increaseLabel}
        disabled={!canIncrease}
        onClick={() => onChange(clampQuantity(value + 1, min, max))}
      >
        <Icon name="plus" size={20} />
      </button>
    </div>
  );
}

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

/** Up to three options (DESIGN.md 7.7); four or long Kazakh labels — a select instead. */
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
  return (
    <label className={cx("ac-check", disabled && "ac-check--disabled")}>
      <input
        type="checkbox"
        className="ac-visually-hidden ac-check__input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ac-check__box" aria-hidden="true">
        {checked && <Icon name="check" size={16} />}
      </span>
      <span className="ac-toggle__text">
        <span>{label}</span>
        {description && <span className="ac-toggle__description">{description}</span>}
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
  return (
    <label className={cx("ac-check", disabled && "ac-check--disabled")}>
      <input
        type="radio"
        name={name}
        className="ac-visually-hidden ac-check__input"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="ac-radio" aria-hidden="true" />
      <span className="ac-toggle__text">
        <span>{label}</span>
        {description && <span className="ac-toggle__description">{description}</span>}
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

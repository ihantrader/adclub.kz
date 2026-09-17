import { createPressGuard, isPressBlocked, type IconName } from "@adclub/ui-core";
import { useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "text" | "danger";
export type ButtonSize = "l" | "m" | "s";

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "children"
> {
  /** Primary — one per screen (DESIGN.md 7.7); danger — irreversible actions only. */
  variant?: ButtonVariant;
  /** L 52 — main action at the bottom; M 44 — in cards; S 36 — cabinet/admin tables only. */
  size?: ButtonSize;
  /** Shows a spinner in place of the label (width kept) and ignores presses. */
  loading?: boolean;
  /** Secondary button with `danger` text, e.g. "Отменить заявку". */
  destructive?: boolean;
  /** Stretch to the container width. */
  block?: boolean;
  icon?: IconName;
  /**
   * A returned promise keeps the button in the loading state until it
   * settles; presses meanwhile are ignored.
   */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => unknown;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "m",
  loading = false,
  destructive = false,
  block = false,
  icon,
  disabled,
  onClick,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const [pending, setPending] = useState(false);
  const [guard] = useState(() => createPressGuard(setPending));
  const busy = loading || pending;
  const blocked = isPressBlocked({ loading: busy, disabled });

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (blocked || guard.isBusy()) {
      event.preventDefault();
      return;
    }
    guard.run(() => onClick?.(event));
  };

  return (
    <button
      {...rest}
      type={type}
      // Loading keeps focus on the button (aria-disabled), a real `disabled` does not.
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={handleClick}
      className={cx(
        "ac-button",
        `ac-button--${variant}`,
        `ac-button--${size}`,
        destructive && "ac-button--destructive",
        block && "ac-button--block",
        busy && "ac-button--loading",
        className,
      )}
    >
      <span className="ac-button__content">
        {icon && <Icon name={icon} size={size === "s" ? 16 : 20} />}
        <span className="ac-button__label">{children}</span>
      </span>
      {busy && <Spinner className="ac-button__spinner" />}
    </button>
  );
}

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label"
> {
  icon: IconName;
  /** Screen reader text — required: the button has no visible label (DESIGN.md 7.12). */
  label: string;
  size?: 20 | 24;
}

/** 48 × 48 icon-only button: close, back, search, flashlight. */
export function IconButton({
  icon,
  label,
  size = 24,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={label}
      className={cx("ac-icon-button", className)}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { colors, spacing } from "./tokens";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "neutral";
  children: ReactNode;
}

export function Button({ variant = "primary", style, children, ...rest }: ButtonProps) {
  const palette =
    variant === "primary"
      ? { background: colors.primary, color: colors.primaryText }
      : { background: colors.neutral, color: colors.neutralText };

  return (
    <button
      {...rest}
      style={{
        ...palette,
        border: "none",
        borderRadius: "6px",
        padding: `${spacing.sm} ${spacing.lg}`,
        fontSize: "14px",
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

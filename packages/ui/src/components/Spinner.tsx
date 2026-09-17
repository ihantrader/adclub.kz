import { cx } from "./cx";

/** Loading indicator; decorative — the owner sets `aria-busy`. */
export function Spinner({ className, size = 20 }: { className?: string; size?: 16 | 20 | 24 }) {
  return (
    <span
      className={cx("ac-spinner", className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

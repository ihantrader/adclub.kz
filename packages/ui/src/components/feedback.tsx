import { motion, type BannerTone, type IconName } from "@adclub/ui-core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { cx } from "./cx";

const bannerIcons: Record<BannerTone, IconName> = {
  neutral: "info",
  warning: "alertTriangle",
  danger: "circleX",
};

export interface BannerProps {
  tone?: BannerTone;
  icon?: IconName;
  /** In the content flow — rounded; under a bar — full-bleed. */
  placement?: "inline" | "flush";
  action?: ReactNode;
  children: ReactNode;
}

/** "Нет сети" — neutral with the wifi-off icon; payment problem — warning (7.7). */
export function Banner({
  tone = "neutral",
  icon,
  placement = "inline",
  action,
  children,
}: BannerProps) {
  return (
    <div
      className={cx("ac-banner", `ac-banner--${tone}`, `ac-banner--${placement}`)}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon name={icon ?? bannerIcons[tone]} size={20} className="ac-banner__icon" />
      <div className="ac-banner__body">
        <div className="ac-text-body-s">{children}</div>
        {action}
      </div>
    </div>
  );
}

interface ToastContextValue {
  show: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Confirmations only ("Код скопирован"); errors stay on the screen (7.7). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; key: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback((text: string) => {
    clearTimeout(timer.current);
    setMessage({ text, key: Date.now() });
    timer.current = setTimeout(() => setMessage(null), motion.toast);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="ac-toast-region" role="status" aria-live="polite">
        {message && (
          <div className="ac-toast" key={message.key}>
            <Icon name="circleCheck" size={20} />
            <span className="ac-text-body-s">{message.text}</span>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside <ToastProvider>");
  return value;
}

/** Skeleton block (surfaceRaised, radius 2); shimmer is off with "reduce motion". */
export function Skeleton({
  width = "100%",
  height = 16,
  style,
}: {
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}) {
  return <span className="ac-skeleton" style={{ width, height, ...style }} aria-hidden="true" />;
}

/** Skeleton of a list row, repeating the real layout; announces loading once. */
export function SkeletonList({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="ac-skeleton-list" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div className="ac-skeleton-row" key={index}>
          <Skeleton width={72} height={72} />
          <div className="ac-skeleton-row__lines">
            <Skeleton width="80%" />
            <Skeleton width="50%" height={12} />
            <Skeleton width="30%" height={20} />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface EmptyStateProps {
  icon: IconName;
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
}

/** Icon 48, heading, muted text, a single button (SCREENS 2.2). */
export function EmptyState({ icon, title, text, action }: EmptyStateProps) {
  return (
    <div className="ac-empty">
      <Icon name={icon} size={48} className="ac-empty__icon" />
      <h2 className="ac-empty__title ac-text-heading">{title}</h2>
      {text && <p className="ac-empty__text ac-text-body-s">{text}</p>}
      {action && <div className="ac-empty__action">{action}</div>}
    </div>
  );
}

export interface ScreenErrorProps {
  title: ReactNode;
  text?: ReactNode;
  /** "Повторить" — only when retrying can help (SCREENS 2.3). */
  retry?: { label: string; onRetry: () => unknown };
}

export function ScreenError({ title, text, retry }: ScreenErrorProps) {
  return (
    <div role="alert">
      <EmptyState
        icon="alertTriangle"
        title={title}
        text={text}
        action={
          retry && (
            <Button variant="secondary" icon="refresh" onClick={retry.onRetry}>
              {retry.label}
            </Button>
          )
        }
      />
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons name the action ("Отменить заявку"), never "OK"; long labels stack. */
  actions: ReactNode;
}

/** Confirmation of irreversible actions: native modal `<dialog>` (focus trap, Esc). */
export function Dialog({ open, onClose, title, children, actions }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="ac-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (event.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="ac-dialog__panel">
          <h2 id={titleId} className="ac-text-title ac-dialog__title">
            {title}
          </h2>
          {children && <div className="ac-dialog__body ac-text-body">{children}</div>}
          <div className="ac-dialog__actions">{actions}</div>
        </div>
      )}
    </dialog>
  );
}

import {
  motion,
  TOAST_ACTION_LIFETIME,
  toastBottomOffset,
  type BannerTone,
  type IconName,
} from "@adclub/ui-core";
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

/** An action of a toast: «Отменить» after «Сохранено». */
export interface ToastAction {
  label: string;
  onAction: () => void;
}

interface ToastContextValue {
  show: (message: string, options?: { action?: ToastAction }) => void;
  /** Takes the toast away at once (its action was taken some other way). */
  hide: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Marks an element pinned to the bottom of the screen that a toast must
 * stand above (DESIGN 7.7): the bottom tabs, the raised center button, the
 * pinned main button of a page. Spread onto the element.
 */
export const toastObstacle = { "data-ac-toast-obstacle": "" } as const;

/** Marks the content area a toast centers on, on a computer (next to a side menu). */
export const toastArea = { "data-ac-toast-area": "" } as const;

/**
 * Where the region stands now: above the highest pinned element on screen
 * (`toastBottomOffset`), else — the CSS default, above the safe area; and
 * across the content area when the page marks one.
 */
export function toastRegionStyle(doc: Document = document): CSSProperties {
  const view = doc.defaultView;
  if (!view) return {};
  const tops: number[] = [];
  doc.querySelectorAll("[data-ac-toast-obstacle]").forEach((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) tops.push(rect.top);
  });
  const style: CSSProperties = {};
  const bottom = toastBottomOffset(view.innerHeight, tops);
  if (bottom !== null) style.bottom = bottom;
  const area = doc.querySelector("[data-ac-toast-area]")?.getBoundingClientRect();
  if (area && area.width > 0) {
    const inset = 16;
    style.left = Math.max(0, area.left) + inset;
    style.right = Math.max(0, view.innerWidth - area.right) + inset;
  }
  return style;
}

interface ToastMessage {
  text: string;
  key: number;
  action?: ToastAction;
}

/**
 * Confirmations only ("Код скопирован"); errors stay on the screen (7.7).
 * A toast stands above the bottom tabs and a pinned main button, never on
 * them (`toastObstacle`). One with an action stays `TOAST_ACTION_LIFETIME`
 * and not at all while it is looked at: the pointer over it, the focus in
 * it, a finger on it, or the page in the background.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Why a toast with an action stays now: each reason holds it until it ends. */
  const holds = useRef(new Set<"pointer" | "focus" | "hidden">());
  const lifetime = useRef<number>(motion.toast);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setMessage(null);
  }, []);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    if (holds.current.size > 0) return;
    timer.current = setTimeout(() => setMessage(null), lifetime.current);
  }, []);

  const show = useCallback(
    (text: string, options: { action?: ToastAction } = {}) => {
      holds.current.clear();
      lifetime.current = options.action ? TOAST_ACTION_LIFETIME : motion.toast;
      setPlace(toastRegionStyle());
      setMessage({ text, key: Date.now(), action: options.action });
      schedule();
    },
    [schedule],
  );

  const hold = useCallback(
    (reason: "pointer" | "focus" | "hidden", on: boolean) => {
      if (on) {
        holds.current.add(reason);
        clearTimeout(timer.current);
      } else {
        holds.current.delete(reason);
        // The full lifetime again once nothing holds it: it was being looked at.
        schedule();
      }
    },
    [schedule],
  );

  useEffect(() => {
    if (!message) return;
    const replace = () => setPlace(toastRegionStyle());
    const onVisibility = () => {
      if (!message.action) return;
      hold("hidden", document.visibilityState === "hidden");
    };
    window.addEventListener("resize", replace);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("resize", replace);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [message, hold]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={{ show, hide }}>
      {children}
      <div className="ac-toast-region" role="status" aria-live="polite" style={place}>
        {message && (
          <div
            className={cx("ac-toast", message.action && "ac-toast--action")}
            key={message.key}
            onPointerEnter={message.action ? () => hold("pointer", true) : undefined}
            onPointerLeave={message.action ? () => hold("pointer", false) : undefined}
            onFocus={message.action ? () => hold("focus", true) : undefined}
            onBlur={message.action ? () => hold("focus", false) : undefined}
          >
            <Icon name="circleCheck" size={20} />
            <span className="ac-text-body-s ac-toast__text">{message.text}</span>
            {message.action && (
              <button
                type="button"
                className="ac-toast__action"
                onClick={() => {
                  const action = message.action;
                  hide();
                  action?.onAction();
                }}
              >
                {message.action.label}
              </button>
            )}
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

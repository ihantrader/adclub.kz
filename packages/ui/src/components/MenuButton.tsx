import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { IconName } from "@adclub/ui-core";
import { Icon } from "./Icon";
import { cx } from "./cx";

/**
 * The next item the arrows reach from `from` in a direction, round the
 * ends; a disabled item is skipped (it cannot take the focus). `from` when
 * every other item is disabled.
 */
export function nextMenuIndex(
  actions: readonly Pick<MenuAction, "disabled">[],
  from: number,
  direction: 1 | -1,
): number {
  const count = actions.length;
  for (let step = 1; step <= count; step++) {
    const index = (((from + direction * step) % count) + count) % count;
    if (!actions[index]?.disabled) return index;
  }
  return from;
}

export interface MenuAction {
  key: string;
  label: string;
  icon?: IconName;
  /** An action in `danger` («Снять с продажи», «Удалить»). */
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuButtonProps {
  /** Screen reader name of the «⋯» button, e.g. «Действия: Колодки тормозные». */
  label: string;
  actions: readonly MenuAction[];
  disabled?: boolean;
  /** `s` — 36 × 36 in a row of a table (TASK-080, X6); the touch zone stays 48. */
  size?: "m" | "s";
  /**
   * A menu opened by words instead of «⋯»: «Администратор клуба ▾» in the
   * header of the admin panel (TASK-080, X15). `label` stays its name for
   * screen readers.
   */
  text?: string;
}

/**
 * «⋯» — the rarer actions of a row or a card (TASK-079): a 48 × 48 button
 * and a short list under it. The keyboard works as in a menu: Enter, Space
 * or ↓ opens it on the first item, ↑ ↓ Home End move, Enter chooses, Esc
 * and a press outside close it and give the focus back to «⋯».
 */
export function MenuButton({ label, actions, disabled, size = "m", text }: MenuButtonProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    items.current[active]?.focus();
  }, [open, active]);

  // The list in the window, under «⋯» and to its right edge (above it when there
  // is no room below): a table frame that scrolls sideways does not cut it.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = button.current?.getBoundingClientRect();
      const panel = list.current;
      if (!box || !panel) return;
      const height = panel.offsetHeight;
      const up = window.innerHeight - box.bottom < height + 8 && box.top > height + 8;
      panel.style.right = `${String(Math.max(8, window.innerWidth - box.right))}px`;
      panel.style.top = up ? "" : `${String(box.bottom + 4)}px`;
      panel.style.bottom = up ? `${String(window.innerHeight - box.top + 4)}px` : "";
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => nextMenuIndex(actions, index, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => nextMenuIndex(actions, index, -1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(nextMenuIndex(actions, -1, 1));
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(nextMenuIndex(actions, actions.length, -1));
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="ac-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className={
          text ? "ac-menu__trigger" : cx("ac-icon-button", size === "s" && "ac-icon-button--s")
        }
        aria-label={label}
        title={text ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => {
          setActive(nextMenuIndex(actions, -1, 1));
          setOpen((now) => !now);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive(nextMenuIndex(actions, -1, 1));
            setOpen(true);
          }
        }}
      >
        {text ? (
          <>
            <span className="ac-menu__trigger-text">{text}</span>
            <Icon name="chevronDown" size={16} />
          </>
        ) : (
          <Icon name="dots" size={size === "s" ? 20 : 24} />
        )}
      </button>
      {open && (
        <div
          ref={list}
          className="ac-menu__list"
          role="menu"
          id={id}
          aria-label={label}
          onKeyDown={onMenuKey}
        >
          {actions.map((action, index) => (
            <button
              key={action.key}
              ref={(element) => {
                items.current[index] = element;
              }}
              type="button"
              role="menuitem"
              tabIndex={index === active ? 0 : -1}
              disabled={action.disabled}
              className={cx("ac-menu__item", action.destructive && "ac-menu__item--danger")}
              onClick={() => {
                close();
                action.onSelect();
              }}
            >
              {action.icon && <Icon name={action.icon} size={20} />}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

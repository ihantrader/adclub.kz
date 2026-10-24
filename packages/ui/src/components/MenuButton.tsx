import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { IconName } from "@adclub/ui-core";
import { Icon } from "./Icon";
import { cx } from "./cx";

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
}

/**
 * «⋯» — the rarer actions of a row or a card (TASK-079): a 48 × 48 button
 * and a short list under it. The keyboard works as in a menu: Enter, Space
 * or ↓ opens it on the first item, ↑ ↓ Home End move, Enter chooses, Esc
 * and a press outside close it and give the focus back to «⋯».
 */
export function MenuButton({ label, actions, disabled }: MenuButtonProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    items.current[active]?.focus();
  }, [open, active]);

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
    const last = actions.length - 1;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index >= last ? 0 : index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index <= 0 ? last : index - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(last);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="ac-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="ac-icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => {
          setActive(0);
          setOpen((now) => !now);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive(0);
            setOpen(true);
          }
        }}
      >
        <Icon name="dots" size={24} />
      </button>
      {open && (
        <div className="ac-menu__list" role="menu" id={id} aria-label={label} onKeyDown={onMenuKey}>
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

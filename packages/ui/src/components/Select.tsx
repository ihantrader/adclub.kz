import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";
import {
  isTypingKey,
  moveHighlight,
  moveOfKey,
  typeahead,
  TYPEAHEAD_RESET_MS,
  type SelectChoice,
} from "./select-core";

export interface SelectProps<T extends string> {
  label: string;
  /** The label for screen readers only — a cell of a table names its field by its column. */
  hideLabel?: boolean;
  /** The chosen value; `""` or `null` — nothing yet (the placeholder is shown). */
  value: T | "" | null;
  onChange: (value: T) => void;
  options: readonly SelectChoice<T>[];
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  /** 40 instead of 48: the filters of a list and the cells of a table (TASK-080, X3). */
  compact?: boolean;
  id?: string;
  /** `name` of the field for the error a server names it by. */
  name?: string;
  className?: string;
}

/** Room kept between the list and the edge of the window. */
const EDGE = 8;
const LIST_MAX_HEIGHT = 320;

/**
 * «Выбор из списка» (TASK-080, X2): our own list instead of the browser's
 * `<select>` — the shell of every field (48, or 40 `compact`), a Phosphor
 * chevron, the list in the club's colors. The keyboard is that of a select
 * (WAI-ARIA «select-only combobox»): ↓ ↑ Enter Space open it on the chosen
 * option; open, ↓ ↑ Home End PageUp PageDown move, Enter and Space choose,
 * Tab chooses and goes on, Esc closes without choosing (and does not close
 * a dialog around it); letters find an option by its first letters. The list
 * stands under the field (above it when there is no room below), over
 * dialogs and table frames: it is placed in the window, not in its parent.
 */
export function Select<T extends string>({
  label,
  hideLabel,
  value,
  onChange,
  options,
  placeholder,
  hint,
  error,
  disabled,
  compact,
  id,
  name,
  className,
}: SelectProps<T>) {
  const autoId = useId();
  const comboId = id ?? autoId;
  const labelId = `${comboId}-label`;
  const listId = `${comboId}-list`;
  const helpId = `${comboId}-help`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const control = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });

  const chosenIndex = options.findIndex((option) => option.value === value);
  const chosen = chosenIndex >= 0 ? options[chosenIndex] : undefined;

  // The list in the window, under the field or above it (written to the node, not to state).
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = control.current?.getBoundingClientRect();
      const panel = list.current;
      if (!box || !panel) return;
      const height = Math.min(panel.scrollHeight, LIST_MAX_HEIGHT);
      const below = window.innerHeight - box.bottom - EDGE;
      const above = box.top - EDGE;
      const up = below < height && above > below;
      panel.style.left = `${String(Math.max(EDGE, box.left))}px`;
      panel.style.minWidth = `${String(box.width)}px`;
      panel.style.maxHeight = `${String(Math.max(120, Math.min(LIST_MAX_HEIGHT, up ? above : below)))}px`;
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
    if (!open || active < 0) return;
    const option = list.current?.children[active] as HTMLElement | undefined;
    option?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const openAt = (index: number) => {
    if (disabled) return;
    setActive(index);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (option && !option.disabled && option.value !== value) onChange(option.value);
    close();
  };

  const find = (key: string): number => {
    const now = Date.now();
    const text = now - typed.current.at > TYPEAHEAD_RESET_MS ? key : typed.current.text + key;
    typed.current = { text, at: now };
    const from = open ? active : chosenIndex;
    return typeahead(options, from, text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const move = moveOfKey(event.key);
    if (!open) {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        openAt(chosenIndex >= 0 ? chosenIndex : moveHighlight(options, -1, "first"));
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        openAt(moveHighlight(options, -1, event.key === "Home" ? "first" : "last"));
      } else if (isTypingKey(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const found = find(event.key);
        if (found >= 0) openAt(found);
      }
      return;
    }
    if (move) {
      event.preventDefault();
      if (event.altKey && event.key === "ArrowUp") {
        choose(active);
        return;
      }
      setActive(moveHighlight(options, active, move));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (active >= 0) choose(active);
      else close();
    } else if (event.key === "Escape") {
      // Only the list closes: the dialog around the field stays.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      if (active >= 0) choose(active);
      else close();
    } else if (isTypingKey(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const found = find(event.key);
      if (found >= 0) setActive(found);
    }
  };

  return (
    <div
      className={cx("ac-field", "ac-picker", compact && "ac-field--compact", className)}
      data-name={name}
    >
      <span
        className={cx("ac-field__label", hideLabel && "ac-visually-hidden")}
        id={labelId}
        onClick={() => control.current?.focus()}
      >
        {label}
      </span>
      <div
        ref={control}
        id={comboId}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${String(active)}` : undefined}
        aria-disabled={disabled || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? helpId : undefined}
        className={cx(
          "ac-field__control",
          "ac-picker__control",
          open && "ac-picker__control--open",
          error ? "ac-field__control--error" : null,
          disabled && "ac-field__control--disabled",
        )}
        onClick={() =>
          open
            ? close()
            : openAt(chosenIndex >= 0 ? chosenIndex : moveHighlight(options, -1, "first"))
        }
        onKeyDown={onKeyDown}
        onBlur={close}
      >
        <span className={cx("ac-picker__value", !chosen && "ac-picker__value--empty")}>
          {chosen ? chosen.label : (placeholder ?? "")}
        </span>
        <Icon name="chevronDown" size={16} className="ac-picker__chevron" />
      </div>
      {open && (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-labelledby={labelId}
          className="ac-picker__list"
          // A press inside keeps the focus on the field (it would close the list first).
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${String(index)}`}
              role="option"
              aria-selected={index === chosenIndex}
              aria-disabled={option.disabled || undefined}
              className={cx(
                "ac-picker__option",
                index === active && "ac-picker__option--active",
                option.disabled && "ac-picker__option--disabled",
              )}
              onMouseEnter={() => !option.disabled && setActive(index)}
              onClick={() => !option.disabled && choose(index)}
            >
              <span className="ac-picker__check" aria-hidden="true">
                {index === chosenIndex && <Icon name="check" size={16} />}
              </span>
              <span>{option.label}</span>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p className="ac-field__help ac-field__help--error" id={helpId}>
          <Icon name="alertTriangle" size={16} />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p className="ac-field__help" id={helpId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

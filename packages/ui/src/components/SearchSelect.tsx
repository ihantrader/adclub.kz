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
import { useLoadingGate } from "./loading";
import {
  createText,
  firstActive,
  isMoveKey,
  listed,
  moveActive,
  SEARCH_DEBOUNCE_MS,
  searchQuery,
  type Choice,
  type ChoiceSource,
} from "./search-select-core";
import { Spinner } from "./Spinner";

/** The words of the list; Russian unless given (the cabinet passes its language). */
export interface SearchSelectTexts {
  failed: string;
  nothing: string;
  searching: string;
}

const RUSSIAN: SearchSelectTexts = {
  failed: "Не удалось найти — нет связи с сервером",
  nothing: "Ничего не нашлось",
  searching: "Ищем…",
};

export interface SearchSelectProps {
  label: string;
  /** The chosen entry; `null` — nothing (the `empty` entry when there is one). */
  value: Choice | null;
  onChange: (choice: Choice | null) => void;
  /** Asks the server; `""` — the first entries. */
  search: ChoiceSource;
  /**
   * What changes the list itself (the make whose models are listed): a new
   * key forgets the found entries.
   */
  sourceKey?: string;
  /** The entry that chooses nothing («Любой», «Все»); without it the field can't be cleared. */
  empty?: string;
  placeholder?: string;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  /**
   * «Новое значение» (TASK-035.C): the last entry of the list — «Новый
   * двигатель «{typed}»» — for a record the search didn't find. Choosing it
   * (a click, or Enter: typed and nothing found, it is the one highlighted)
   * closes the list and hands over what was typed; the screen opens its
   * form and, once saved, makes the new record the value. The field keeps
   * its value meanwhile.
   */
  create?: { label: string; onCreate: (typed: string) => void };
  /** `name` of the field for the error a server names it by. */
  name?: string;
  texts?: SearchSelectTexts;
}

/**
 * «Выбор с поиском» (TASK-035.B): one field for every list too long to load
 * whole — makes, models, generations, engines, brands. Typing searches the
 * server (a part of any spelling: «джили» finds Geely); with nothing typed
 * it shows the first entries. The keyboard works as in a native select:
 * arrows, Home/End, Enter chooses, Esc closes and keeps the choice (and
 * doesn't close a dialog around it). The found entries stay on screen while
 * the next answer comes; a slow one shows a quiet indicator, and only the
 * answer to what is typed now is shown (D-069). A list that can grow from
 * here (`create`) ends with «Новый …» — one way of adding a value for every
 * such field (brands, engines).
 */
export function SearchSelect({
  label,
  value,
  onChange,
  search,
  sourceKey = "",
  empty,
  placeholder,
  hint,
  error,
  disabled,
  create,
  name,
  texts = RUSSIAN,
}: SearchSelectProps) {
  const id = useId();
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const searcher = useRef(search);
  useLayoutEffect(() => {
    searcher.current = search;
  });
  const gate = useLoadingGate();
  const { begin, settle, cancel } = gate;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [found, setFound] = useState<{
    key: string;
    query: string;
    choices: Choice[];
    failed: boolean;
  } | null>(null);
  const [active, setActive] = useState(-1);

  const query = searchQuery(text);
  // Entries of another list (the make changed) are never shown.
  const current = found && found.key === sourceKey ? found : null;
  const entries = open
    ? listed(current?.choices ?? [], { typed: query !== "", empty, chosen: value })
    : [];
  // The «new value» entry comes after the found ones: its index is their count.
  const createIndex = open && create ? entries.length : -1;
  const count = entries.length + (createIndex >= 0 ? 1 : 0);
  const canCreate = create !== undefined;

  useEffect(() => {
    if (!open) return;
    const ticket = begin();
    let cancelled = false;
    const timer = setTimeout(
      () => {
        searcher.current(query).then(
          (choices) =>
            !cancelled &&
            settle(ticket, () => {
              setFound({ key: sourceKey, query, choices, failed: false });
              setActive(firstActive({ typed: query !== "", found: choices.length, canCreate }));
            }),
          () =>
            !cancelled &&
            settle(ticket, () => setFound({ key: sourceKey, query, choices: [], failed: true })),
        );
      },
      query ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, sourceKey, begin, settle, canCreate]);

  const close = () => {
    setOpen(false);
    setText("");
    setActive(-1);
    cancel();
  };

  const choose = (entry: Choice | null) => {
    onChange(entry);
    close();
  };

  const startCreating = () => {
    const typed = query;
    close();
    create?.onCreate(typed);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isMoveKey(event.key)) {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive(moveActive(active, count, event.key));
      return;
    }
    if (event.key === "Enter") {
      if (open && active >= 0 && active === createIndex) {
        event.preventDefault();
        startCreating();
      } else if (open && active >= 0 && active < entries.length) {
        event.preventDefault();
        choose(entries[active] ?? null);
      }
      return;
    }
    if (event.key === "Escape" && open) {
      // Only the list closes: the dialog around the field stays.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const shown = open ? text : (value?.label ?? "");
  const waitingFirst = open && current === null;
  const stale = open && current !== null && current.query !== query;
  return (
    <div className="search-select" data-name={name}>
      <label className="search-select__label ac-text-caption ac-muted" htmlFor={id}>
        {label}
      </label>
      <div className="search-select__box">
        <input
          ref={input}
          id={id}
          type="text"
          role="combobox"
          className="search-select__input"
          autoComplete="off"
          spellCheck={false}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          value={shown}
          placeholder={open ? (value?.label ?? placeholder ?? empty) : (placeholder ?? empty)}
          // Focus alone (a dialog opening, Tab) keeps the choice on screen; typing replaces it.
          onFocus={(event) => event.target.select()}
          onClick={() => setOpen(true)}
          onBlur={close}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {open && (gate.indicator || stale) && (
          <span className="search-select__busy" aria-hidden="true">
            {gate.indicator && <Spinner size={16} />}
          </span>
        )}
      </div>
      {open && (
        <div
          className="search-select__panel"
          // A click inside keeps the focus in the field (it would close the list first).
          onMouseDown={(event) => event.preventDefault()}
        >
          {!waitingFirst && current?.failed && (
            <p className="search-select__message ac-text-caption ac-muted">{texts.failed}</p>
          )}
          {!waitingFirst && !current?.failed && entries.length === 0 && (
            <p className="search-select__message ac-text-caption ac-muted">{texts.nothing}</p>
          )}
          {waitingFirst && gate.indicator && (
            <p className="search-select__message ac-text-caption ac-muted">{texts.searching}</p>
          )}
          <ul id={listId} role="listbox" aria-label={label} className="search-select__list">
            {entries.map((entry, index) => (
              <li
                key={entry?.id ?? "empty"}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={(entry?.id ?? null) === (value?.id ?? null)}
                className={[
                  "search-select__option",
                  index === active && "search-select__option--active",
                  entry?.muted && "search-select__option--muted",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(entry)}
              >
                <span className="search-select__text">{entry ? entry.label : empty}</span>
                {entry?.note && (
                  <span className="search-select__note ac-text-caption ac-muted">{entry.note}</span>
                )}
              </li>
            ))}
            {create && (
              <li
                id={`${listId}-${createIndex}`}
                role="option"
                aria-selected={false}
                className={[
                  "search-select__option search-select__option--create",
                  createIndex === active && "search-select__option--active",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => setActive(createIndex)}
                onClick={startCreating}
              >
                <span className="search-select__text">
                  <Icon name="plus" size={16} /> {createText(create.label, query)}
                </span>
              </li>
            )}
          </ul>
        </div>
      )}
      {error ? (
        <span className="search-select__error">{error}</span>
      ) : hint ? (
        <span className="ac-text-caption ac-muted">{hint}</span>
      ) : null}
    </div>
  );
}

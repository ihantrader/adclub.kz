import type { AdminSearchResponse } from "@adclub/contracts";
import { Icon, Spinner, useLoadingGate } from "@adclub/ui";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { apiClient } from "../api";
import { actionErrorText } from "../errors";
import { navigateTo } from "../router";
import { isMoveKey, moveActive } from "../search-select/search-select-core";
import {
  directEntry,
  HEADER_SEARCH_DEBOUNCE_MS,
  headerQuery,
  searchEntries,
  type SearchEntry,
} from "./header-search";

/**
 * A-SEARCH (SCREENS 7.0; TASK-036.B): one line in the header of every page.
 * The server reads it — a phone, «№ 4821», a БИН, an article, a text — and
 * answers in groups; the keyboard works as in «выбор с поиском» (arrows,
 * Enter opens, Esc closes). «1028» with Enter goes straight into the order.
 * Numbers come partly hidden; what is typed never goes to the address of
 * the page (the request to the server carries it, and the access log keeps
 * no query strings).
 */
export function HeaderSearch() {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<{ query: string; data: AdminSearchResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const gate = useLoadingGate();
  const { begin, settle } = gate;
  const box = useRef<HTMLDivElement>(null);
  const query = headerQuery(text);
  const shown = answer && answer.query === query ? answer.data : null;
  const entries = shown ? searchEntries(shown) : [];

  useEffect(() => {
    if (!query) return;
    const timer = setTimeout(() => {
      const ticket = begin();
      apiClient.searchAdmin({ query: { q: query } }).then(
        (data) =>
          settle(ticket, () => {
            setAnswer({ query, data });
            setError(null);
            setActive(-1);
          }),
        (thrown: unknown) => settle(ticket, () => setError(actionErrorText(thrown))),
      );
    }, HEADER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, begin, settle]);

  // A click elsewhere closes the list.
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const go = (entry: SearchEntry) => {
    setOpen(false);
    setText("");
    setAnswer(null);
    navigateTo(entry.href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (isMoveKey(event.key) && entries.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive(moveActive(active, entries.length, event.key));
      return;
    }
    if (event.key === "Enter" && shown) {
      event.preventDefault();
      const target = active >= 0 ? entries[active] : directEntry(shown, entries);
      if (target) go(target);
    }
  };

  return (
    <div className="header-search" ref={box}>
      <div className="header-search__field">
        <Icon name="search" size={20} />
        <input
          type="search"
          role="combobox"
          aria-label="Поиск по клубу: телефон, № заявки, БИН, артикул, название"
          aria-expanded={open && query.length > 0}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
          placeholder="Телефон, № заявки, БИН, артикул, название"
          value={text}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {gate.indicator && <Spinner size={16} />}
      </div>
      {open && query && (
        <div className="header-search__list" id={listId} role="listbox" aria-label="Найдено">
          {error && <p className="dialog-error header-search__note">{error}</p>}
          {!error && shown && entries.length === 0 && (
            <p className="ac-text-body-s ac-muted header-search__note">Ничего не нашлось</p>
          )}
          {!error && !shown && <p className="ac-text-body-s ac-muted header-search__note">Ищем…</p>}
          {entries.map((entry, index) => {
            const heading =
              index === 0 || entries[index - 1]!.group !== entry.group ? entry.group : null;
            return (
              <div key={entry.key}>
                {heading && (
                  <div
                    className="ac-text-caption ac-muted header-search__group"
                    role="presentation"
                  >
                    {heading}
                  </div>
                )}
                <a
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  href={entry.href}
                  className={
                    index === active
                      ? "header-search__entry header-search__entry--active"
                      : "header-search__entry"
                  }
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
                      return;
                    event.preventDefault();
                    go(entry);
                  }}
                >
                  <span className="ac-text-body-s long-text">{entry.label}</span>
                  {entry.note && (
                    <span className="ac-text-caption ac-muted long-text">{entry.note}</span>
                  )}
                </a>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

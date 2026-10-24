import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  addMonths,
  dateTextOf,
  dayAllowed,
  isCalendarKey,
  maskAfterDelete,
  moveDay,
  monthWeeks,
  partsOf,
  readDateText,
} from "./date-field-core";
import {
  calendarDayOf,
  dateLangOf,
  formatFullDate,
  formatMonthYear,
  weekdayName,
} from "@adclub/i18n";
import { Icon } from "./Icon";
import { cx } from "./cx";

/** The words of the field; Russian unless given (the cabinet passes its language). */
export interface DateFieldTexts {
  placeholder: string;
  openCalendar: string;
  previousMonth: string;
  nextMonth: string;
  /** A day that doesn't exist: «31.02.2026». */
  invalid: string;
  /** Before `min`: «Дата уже прошла». */
  beforeMin: string;
  afterMax: string;
}

const RUSSIAN: DateFieldTexts = {
  placeholder: "дд.мм.гггг",
  openCalendar: "Открыть календарь",
  previousMonth: "Предыдущий месяц",
  nextMonth: "Следующий месяц",
  invalid: "Такой даты нет",
  beforeMin: "Эта дата раньше допустимой",
  afterMax: "Эта дата позже допустимой",
};

export interface DateFieldProps {
  label: string;
  /** `YYYY-MM-DD`, or `""` — no date. */
  value: string;
  /** A whole valid date, or `""` while the text isn't one. */
  onChange: (iso: string) => void;
  /** The first day that may be chosen, `YYYY-MM-DD`. */
  min?: string;
  max?: string;
  /** The month the calendar opens on when there is no date (usually today). */
  today?: string;
  /** Names of months and weekdays: «ru», «kk-KZ», «en». */
  locale: string;
  hint?: string;
  /** An error of the screen; the field's own («Такой даты нет») shows when there is none. */
  error?: string | null;
  disabled?: boolean;
  id?: string;
  /** 40 instead of 48: a filter of a list (TASK-080, X3). */
  compact?: boolean;
  texts?: DateFieldTexts;
}

type Problem = "invalid" | "min" | "max" | null;

function problemOf(text: string, min?: string, max?: string): Problem {
  const reading = readDateText(text);
  if (reading.kind === "invalid") return "invalid";
  if (reading.kind !== "date") return null;
  if (min && reading.iso < min) return "min";
  if (max && reading.iso > max) return "max";
  return null;
}

function capitalized(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/**
 * «Дата» (TASK-079): a field of the 48 shell with the mask «ДД.ММ.ГГГГ» —
 * digits only, the dots come by themselves — and its own calendar instead
 * of the browser's (`type="date"` showed «dd.mm.yyyy» in English and looked
 * different in every browser). The calendar is a grid of the month, Monday
 * first; the keyboard works as in a WAI-ARIA date picker: arrows by day and
 * week, Home/End — the week's ends, PageUp/PageDown — a month, Enter
 * chooses, Esc closes and returns to the field. Typed and chosen dates are
 * the same `YYYY-MM-DD`.
 */
export function DateField({
  label,
  value,
  onChange,
  min,
  max,
  today,
  locale,
  hint,
  error,
  disabled,
  id,
  compact,
  texts = RUSSIAN,
}: DateFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const labelId = `${inputId}-label`;
  const calendarId = `${inputId}-calendar`;
  const [text, setText] = useState(() => dateTextOf(value));
  const [touched, setTouched] = useState(false);
  const [open, setOpen] = useState(false);
  const [focusDay, setFocusDay] = useState<string>(() => value || today || min || "2026-01-01");
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLTableElement>(null);
  /** What the field itself last handed over: only another value is «from outside». */
  const emitted = useRef(value);
  /** The day takes the focus after a key or opening — not after a press on «‹ ›». */
  const focusGrid = useRef(false);

  // A date set from outside (a reset, another record) replaces what is typed.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setText(dateTextOf(value));
    setTouched(false);
  }, [value]);

  const own = problemOf(text, min, max);
  const ownComplete = readDateText(text).kind === "date" || readDateText(text).kind === "invalid";
  const ownText =
    own === "invalid"
      ? texts.invalid
      : own === "min"
        ? texts.beforeMin
        : own === "max"
          ? texts.afterMax
          : null;
  const shownError = error ?? ((touched || ownComplete) && ownText ? ownText : null);

  const commit = (next: string) => {
    setText(next);
    const reading = readDateText(next);
    const problem = problemOf(next, min, max);
    const iso = reading.kind === "date" && problem === null ? reading.iso : "";
    if (iso !== emitted.current) {
      emitted.current = iso;
      onChange(iso);
    }
  };

  const openCalendar = () => {
    const reading = readDateText(text);
    setFocusDay(reading.kind === "date" ? reading.iso : value || today || min || focusDay);
    focusGrid.current = true;
    setOpen(true);
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) toggle.current?.focus();
  };

  const choose = (iso: string) => {
    if (!dayAllowed(iso, min, max)) return;
    commit(dateTextOf(iso));
    setTouched(true);
    close(true);
  };

  // The highlighted day takes the focus while the calendar is open (roving tabindex).
  useLayoutEffect(() => {
    if (!open || !focusGrid.current) return;
    focusGrid.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
  }, [open, focusDay]);

  // A press outside closes the calendar; the typed text stays.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const onGridKey = (event: KeyboardEvent<HTMLTableElement>) => {
    if (isCalendarKey(event.key)) {
      event.preventDefault();
      focusGrid.current = true;
      setFocusDay(moveDay(focusDay, event.key));
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };

  const { year, month } = partsOf(focusDay);
  // Names of months and weekdays are the dictionary's, never the browser's
  // (TASK-080, requirement 7: a browser without Kazakh wrote «M10»).
  const lang = dateLangOf(locale);
  const monthTitle = capitalized(formatMonthYear(year, month, lang));
  const weekdays = Array.from({ length: 7 }, (_, index) => weekdayName(index + 1, lang));
  const dayLabel = (iso: string) => {
    const day = calendarDayOf(iso);
    return day ? formatFullDate(day, lang, "long") : iso;
  };
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [shownError ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");

  return (
    <div className={cx("ac-field", "ac-date-field", compact && "ac-field--compact")} ref={root}>
      <label className="ac-field__label" id={labelId} htmlFor={inputId}>
        {label}
      </label>
      <div
        className={cx(
          "ac-field__control",
          shownError ? "ac-field__control--error" : null,
          disabled && "ac-field__control--disabled",
        )}
      >
        <input
          id={inputId}
          className="ac-field__input ac-date-field__input"
          inputMode="numeric"
          autoComplete="off"
          placeholder={texts.placeholder}
          value={text}
          disabled={disabled}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => commit(maskAfterDelete(text, event.target.value))}
          onBlur={() => setTouched(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && (event.altKey || !open)) {
              event.preventDefault();
              openCalendar();
            }
          }}
        />
        <button
          ref={toggle}
          type="button"
          className="ac-date-field__toggle"
          aria-label={texts.openCalendar}
          title={texts.openCalendar}
          aria-expanded={open}
          aria-controls={open ? calendarId : undefined}
          disabled={disabled}
          onClick={() => (open ? close(false) : openCalendar())}
        >
          <Icon name="calendar" size={20} />
        </button>
      </div>
      {open && (
        <div
          className="ac-date-field__calendar"
          id={calendarId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={labelId}
        >
          <div className="ac-date-field__month">
            <button
              type="button"
              className="ac-icon-button"
              aria-label={texts.previousMonth}
              title={texts.previousMonth}
              onClick={() => setFocusDay(addMonths(focusDay, -1))}
            >
              <Icon name="chevronLeft" size={20} />
            </button>
            <span className="ac-text-body-strong" aria-live="polite">
              {monthTitle}
            </span>
            <button
              type="button"
              className="ac-icon-button"
              aria-label={texts.nextMonth}
              title={texts.nextMonth}
              onClick={() => setFocusDay(addMonths(focusDay, 1))}
            >
              <Icon name="chevronRight" size={20} />
            </button>
          </div>
          <table
            ref={grid}
            role="grid"
            className="ac-date-field__grid"
            aria-label={monthTitle}
            onKeyDown={onGridKey}
          >
            <thead>
              <tr>
                {weekdays.map((name) => (
                  <th key={name} scope="col" abbr={name}>
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthWeeks(year, month).map((week, index) => (
                <tr key={index}>
                  {week.map((day, cell) =>
                    day === null ? (
                      <td key={cell} />
                    ) : (
                      <td key={day}>
                        <button
                          type="button"
                          data-day={day}
                          tabIndex={day === focusDay ? 0 : -1}
                          disabled={!dayAllowed(day, min, max)}
                          aria-label={dayLabel(day)}
                          aria-pressed={day === value}
                          className={cx(
                            "ac-date-field__day",
                            day === value && "ac-date-field__day--chosen",
                            day === today && "ac-date-field__day--today",
                          )}
                          onClick={() => choose(day)}
                        >
                          {partsOf(day).day}
                        </button>
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {shownError && (
        <p className="ac-field__help ac-field__help--error" id={errorId}>
          <Icon name="alertTriangle" size={16} />
          <span>{shownError}</span>
        </p>
      )}
      {hint && (
        <p className="ac-field__help" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

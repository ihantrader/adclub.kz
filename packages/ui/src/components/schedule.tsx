import { calendarDayOf, dateLangOf, formatFullDate } from "@adclub/i18n";
import { useId, useState } from "react";
import { Button, IconButton } from "./Button";
import { DateField, type DateFieldTexts } from "./DateField";
import { TextField } from "./fields";
import { Select } from "./Select";
import { Icon } from "./Icon";
import { cx } from "./cx";
import {
  closedDateProblem,
  copyToWeekdays,
  dayHoursText,
  maskTimeText,
  readTimeText,
  upcomingClosedDates,
  type ClosedDate,
  type DayForm,
  type DayMode,
} from "./schedule-form";

/**
 * The hours and the days off of a supplier's pickup point — one form for
 * the cabinet (S-COMP-01) and the admin panel (A-SUP-03 «Профиль»),
 * TASK-036. The words come from the screen: the cabinet speaks kk/ru/en,
 * the admin panel Russian. What the week means for the server is
 * `schedule-form.ts`; whether it is accepted is the server's.
 */
export interface WeekHoursTexts {
  /** The days of the week, Monday first — for screen readers. */
  days: readonly [string, string, string, string, string, string, string];
  /** «Пн», «Вт»… — what a row shows. */
  shortDays: readonly [string, string, string, string, string, string, string];
  /** «{день}: {это}» — the label of a day's mode switch. */
  dayMode: string;
  workDay: string;
  dayOff: string;
  allDay: string;
  /** A day with more than one break, kept as it is. */
  customHours: string;
  from: string;
  to: string;
  /** «Перерыв»: the button that adds one, and the words before its times. */
  breakLabel: string;
  removeBreak: string;
  breakFrom: string;
  breakTo: string;
  /** «Скопировать понедельник на будни». */
  copyToWeekdays: string;
  intervalInvalid: string;
}

const MODES: DayMode[] = ["hours", "off", "allDay"];

function modeLabel(mode: DayMode, texts: WeekHoursTexts): string {
  switch (mode) {
    case "off":
      return texts.dayOff;
    case "allDay":
      return texts.allDay;
    case "custom":
      return texts.customHours;
    default:
      return texts.workDay;
  }
}

export interface WeekHoursEditorProps {
  week: readonly DayForm[];
  /** Days whose times don't make sense (`weeklyHoursOf`). */
  invalidDays: readonly number[];
  onDayChange: (day: number, change: Partial<DayForm>) => void;
  texts: WeekHoursTexts;
}

/**
 * The seven days as seven rows of 48 (TASK-079, S-COMP-01): «Пн · Рабочий ▾
 * · 09:00–18:00 · + Перерыв», and «Скопировать понедельник на будни» under
 * them. From 600 px every row is open; on a phone a row shows the day and
 * its hours and opens on a press. A day whose times don't make sense says
 * so in its row (the break inside the hours, the end after the start —
 * `dayIntervals`).
 */
export function WeekHoursEditor({ week, invalidDays, onDayChange, texts }: WeekHoursEditorProps) {
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const toggle = (day: number) =>
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  return (
    <div className="ac-week-editor">
      <ul className="ac-week">
        {week.map((day) => (
          <WeekDay
            key={day.day}
            day={day}
            open={opened.has(day.day) || invalidDays.includes(day.day)}
            onToggle={() => toggle(day.day)}
            invalid={invalidDays.includes(day.day)}
            texts={texts}
            onChange={(change) => onDayChange(day.day, change)}
          />
        ))}
      </ul>
      <Button
        variant="text"
        icon="copy"
        className="ac-week__copy"
        onClick={() => {
          for (const { day, change } of copyToWeekdays(week)) onDayChange(day, change);
        }}
      >
        {texts.copyToWeekdays}
      </Button>
    </div>
  );
}

function WeekDay({
  day,
  open,
  onToggle,
  invalid,
  texts,
  onChange,
}: {
  day: DayForm;
  open: boolean;
  onToggle: () => void;
  invalid: boolean;
  texts: WeekHoursTexts;
  onChange: (change: Partial<DayForm>) => void;
}) {
  const editId = useId();
  const errorId = `${editId}-error`;
  const dayName = texts.days[day.day - 1] ?? String(day.day);
  const shortName = texts.shortDays[day.day - 1] ?? dayName;
  const modes = day.mode === "custom" ? [...MODES, "custom" as const] : MODES;
  const folded =
    day.mode === "hours" && !invalid
      ? (dayHoursText(day) ?? modeLabel(day.mode, texts))
      : day.mode === "custom"
        ? (dayHoursText(day) ?? texts.customHours)
        : modeLabel(day.mode, texts);
  return (
    <li
      className={cx(
        "ac-week__day",
        open && "ac-week__day--open",
        day.mode === "off" && "ac-week__day--off",
        invalid && "ac-week__day--invalid",
      )}
    >
      <button
        type="button"
        className="ac-week__summary"
        aria-expanded={open}
        aria-controls={editId}
        onClick={onToggle}
      >
        <span className="ac-week__name" aria-label={dayName}>
          {shortName}
        </span>
        <span className="ac-week__summary-text">{folded}</span>
        <Icon name="chevronDown" size={16} className="ac-week__chevron" />
      </button>
      <div className="ac-week__edit" id={editId}>
        <span className="ac-week__name ac-week__name--row" aria-hidden="true">
          {shortName}
        </span>
        <Select<DayMode>
          hideLabel
          className="ac-week__mode"
          label={`${dayName}: ${texts.dayMode}`}
          value={day.mode}
          options={modes.map((mode) => ({ value: mode, label: modeLabel(mode, texts) }))}
          onChange={(mode) => onChange({ mode })}
        />
        {day.mode === "custom" && (
          <span className="ac-text-body-s ac-week__custom">{dayHoursText(day)}</span>
        )}
        {day.mode === "hours" && (
          <>
            <span className="ac-week__range">
              <TimeInput
                label={`${dayName}: ${texts.from}`}
                value={day.from}
                invalid={invalid}
                errorId={invalid ? errorId : undefined}
                onChange={(from) => onChange({ from })}
              />
              <span aria-hidden="true">–</span>
              <TimeInput
                label={`${dayName}: ${texts.to}`}
                value={day.to}
                invalid={invalid}
                errorId={invalid ? errorId : undefined}
                onChange={(to) => onChange({ to })}
              />
            </span>
            {day.withBreak ? (
              <span className="ac-week__range ac-week__break">
                <span className="ac-text-body-s ac-muted">{texts.breakLabel}</span>
                <TimeInput
                  label={`${dayName}: ${texts.breakFrom}`}
                  value={day.breakFrom}
                  invalid={invalid}
                  errorId={invalid ? errorId : undefined}
                  onChange={(breakFrom) => onChange({ breakFrom })}
                />
                <span aria-hidden="true">–</span>
                <TimeInput
                  label={`${dayName}: ${texts.breakTo}`}
                  value={day.breakTo}
                  invalid={invalid}
                  errorId={invalid ? errorId : undefined}
                  onChange={(breakTo) => onChange({ breakTo })}
                />
                <IconButton
                  icon="x"
                  size={20}
                  label={`${dayName}: ${texts.removeBreak}`}
                  onClick={() => onChange({ withBreak: false })}
                />
              </span>
            ) : (
              <Button
                variant="text"
                icon="plus"
                aria-label={`${dayName}: ${texts.breakLabel}`}
                onClick={() => onChange({ withBreak: true })}
              >
                {texts.breakLabel}
              </Button>
            )}
          </>
        )}
      </div>
      {invalid && (
        <p
          className="ac-field__help ac-field__help--error ac-week__error"
          id={errorId}
          role="alert"
        >
          <Icon name="alertTriangle" size={16} />
          <span>{texts.intervalInvalid}</span>
        </p>
      )}
    </li>
  );
}

/**
 * A time «ЧЧ:ММ» (TASK-080, X23): digits only, the colon comes by itself,
 * 24-hour; the browser's own time field looked different in every browser.
 * What is typed stays in the field until it is a whole time, and only a
 * whole time goes to the form; leaving the field with half a time puts the
 * form's time back.
 */
function TimeInput({
  label,
  value,
  invalid,
  errorId,
  onChange,
}: {
  label: string;
  value: string;
  invalid: boolean;
  errorId?: string;
  onChange: (value: string) => void;
}) {
  const [typed, setTyped] = useState<{ for: string; text: string } | null>(null);
  const text = typed && typed.for === value ? typed.text : value;
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder="чч:мм"
      maxLength={5}
      className={cx("ac-time-input__control", invalid && "ac-time-input__control--error")}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={errorId}
      value={text}
      onChange={(event) => {
        const masked = maskTimeText(event.target.value);
        const time = readTimeText(masked);
        if (time && time !== value) {
          setTyped(null);
          onChange(time);
        } else {
          setTyped({ for: value, text: masked });
        }
      }}
      onBlur={() => setTyped(null)}
    />
  );
}

export interface ClosedDatesTexts {
  date: string;
  note: string;
  notePlaceholder: string;
  addDate: string;
  /** «{это}: 2026-12-16» — the label of a date's remove button. */
  removeDate: string;
  empty: string;
  pastDate: string;
  duplicateDate: string;
  /** «Укажите дату» — «Добавить» pressed with the field empty or unfinished. */
  dateRequired: string;
  /** The words of the date field and its calendar. */
  dateField: DateFieldTexts;
}

export interface ClosedDatesEditorProps {
  dates: readonly ClosedDate[];
  /** Today in the supplier's time zone (`todayIn`): no earlier date is added. */
  today: string;
  onChange: (dates: ClosedDate[]) => void;
  texts: ClosedDatesTexts;
  /** The locale the dates are written in («ru», «kk-KZ», «en»). */
  locale: string;
}

/** The days the point doesn't work, from today on, each with an optional note. */
export function ClosedDatesEditor({
  dates,
  today,
  onChange,
  texts,
  locale,
}: ClosedDatesEditorProps) {
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // «вт, 16 декабря 2026 г.» from the dictionary, not the browser (TASK-080, requirement 7).
  const lang = dateLangOf(locale);
  const dateText = (iso: string) => {
    const day = calendarDayOf(iso);
    return day ? formatFullDate(day, lang) : iso;
  };

  const add = () => {
    const reason = closedDateProblem(date, dates, today);
    if (reason) {
      setProblem(
        reason === "past"
          ? texts.pastDate
          : reason === "duplicate"
            ? texts.duplicateDate
            : texts.dateRequired,
      );
      return;
    }
    onChange(upcomingClosedDates([...dates, { date, note: note.trim() || null }], today));
    setDate("");
    setNote("");
    setProblem(null);
  };

  return (
    <div className="ac-closed-dates-editor">
      {dates.length === 0 ? (
        <p className="ac-text-body-s ac-muted">{texts.empty}</p>
      ) : (
        <ul className="ac-closed-dates">
          {dates.map((item) => (
            <li key={item.date} className="ac-closed-dates__item">
              <span className="ac-closed-dates__text">
                <span className="ac-text-body">{dateText(item.date)}</span>
                {item.note && <span className="ac-text-body-s ac-muted">{item.note}</span>}
              </span>
              <IconButton
                icon="x"
                label={`${texts.removeDate}: ${item.date}`}
                onClick={() => onChange(dates.filter((other) => other.date !== item.date))}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="ac-closed-dates__add">
        <DateField
          label={texts.date}
          value={date}
          min={today}
          today={today}
          locale={locale}
          error={problem}
          texts={texts.dateField}
          onChange={(iso) => {
            setDate(iso);
            setProblem(null);
          }}
        />
        <TextField
          label={texts.note}
          value={note}
          onChange={setNote}
          maxLength={200}
          placeholder={texts.notePlaceholder}
        />
        <Button variant="secondary" icon="calendarX" onClick={add}>
          {texts.addDate}
        </Button>
      </div>
    </div>
  );
}

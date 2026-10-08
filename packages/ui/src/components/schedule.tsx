import { useState } from "react";
import { Button, IconButton } from "./Button";
import { Checkbox, Segments } from "./controls";
import { TextField } from "./fields";
import { cx } from "./cx";
import {
  closedDateProblem,
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
  /** The days of the week, Monday first. */
  days: readonly [string, string, string, string, string, string, string];
  /** «{день}: {это}» — the label of a day's mode switch. */
  dayMode: string;
  workDay: string;
  dayOff: string;
  allDay: string;
  /** A day with more than one break, kept as it is. */
  customHours: string;
  from: string;
  to: string;
  withBreak: string;
  breakFrom: string;
  breakTo: string;
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

/** The seven days: a mode each, the hours and the break of a working one. */
export function WeekHoursEditor({ week, invalidDays, onDayChange, texts }: WeekHoursEditorProps) {
  return (
    <ul className="ac-week">
      {week.map((day) => (
        <WeekDay
          key={day.day}
          day={day}
          invalid={invalidDays.includes(day.day)}
          texts={texts}
          onChange={(change) => onDayChange(day.day, change)}
        />
      ))}
    </ul>
  );
}

function WeekDay({
  day,
  invalid,
  texts,
  onChange,
}: {
  day: DayForm;
  invalid: boolean;
  texts: WeekHoursTexts;
  onChange: (change: Partial<DayForm>) => void;
}) {
  const dayName = texts.days[day.day - 1] ?? String(day.day);
  const modes = day.mode === "custom" ? [...MODES, "custom" as const] : MODES;
  return (
    <li className="ac-week__day">
      <span className="ac-text-body-strong">{dayName}</span>
      <Segments<DayMode>
        label={`${dayName}: ${texts.dayMode}`}
        value={day.mode}
        onChange={(mode) => onChange({ mode })}
        options={modes.map((mode) => ({ value: mode, label: modeLabel(mode, texts) }))}
      />
      {day.mode === "custom" && (
        <p className="ac-text-body-s ac-week__custom">
          {day.custom.map((interval) => `${interval.from}–${interval.to}`).join(", ")}
        </p>
      )}
      {day.mode === "hours" && (
        <div className="ac-week__hours">
          <div className="ac-time-range">
            <TimeInput
              label={`${dayName}: ${texts.from}`}
              text={texts.from}
              value={day.from}
              invalid={invalid}
              onChange={(from) => onChange({ from })}
            />
            <TimeInput
              label={`${dayName}: ${texts.to}`}
              text={texts.to}
              value={day.to}
              invalid={invalid}
              onChange={(to) => onChange({ to })}
            />
          </div>
          <Checkbox
            label={texts.withBreak}
            checked={day.withBreak}
            onChange={(withBreak) => onChange({ withBreak })}
          />
          {day.withBreak && (
            <div className="ac-time-range">
              <TimeInput
                label={`${dayName}: ${texts.breakFrom}`}
                text={texts.breakFrom}
                value={day.breakFrom}
                invalid={invalid}
                onChange={(breakFrom) => onChange({ breakFrom })}
              />
              <TimeInput
                label={`${dayName}: ${texts.breakTo}`}
                text={texts.breakTo}
                value={day.breakTo}
                invalid={invalid}
                onChange={(breakTo) => onChange({ breakTo })}
              />
            </div>
          )}
          {invalid && (
            <p className="ac-field__help ac-field__help--error" role="alert">
              {texts.intervalInvalid}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** A native time picker (the phone's own wheel), 24-hour `HH:MM`. */
function TimeInput({
  label,
  text,
  value,
  invalid,
  onChange,
}: {
  label: string;
  text: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="ac-time-input">
      <span className="ac-time-input__label">{text}</span>
      <input
        type="time"
        className={cx("ac-time-input__control", invalid && "ac-time-input__control--error")}
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={value}
        step={300}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
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
  const format = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    weekday: "short",
  });

  const add = () => {
    const reason = closedDateProblem(date, dates, today);
    if (reason) {
      setProblem(
        reason === "past"
          ? texts.pastDate
          : reason === "duplicate"
            ? texts.duplicateDate
            : texts.date,
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
                <span className="ac-text-body">
                  {format.format(new Date(`${item.date}T12:00:00Z`))}
                </span>
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
        <label className="ac-time-input">
          <span className="ac-time-input__label">{texts.date}</span>
          <input
            type="date"
            className={cx("ac-time-input__control", problem && "ac-time-input__control--error")}
            min={today}
            value={date}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              setDate(event.target.value);
              setProblem(null);
            }}
          />
        </label>
        <TextField
          label={texts.note}
          value={note}
          onChange={setNote}
          maxLength={200}
          placeholder={texts.notePlaceholder}
        />
        <Button variant="secondary" icon="calendarX" disabled={!date} onClick={add}>
          {texts.addDate}
        </Button>
      </div>
      {problem && (
        <p className="ac-field__help ac-field__help--error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

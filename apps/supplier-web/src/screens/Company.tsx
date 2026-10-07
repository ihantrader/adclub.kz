import { isApiError } from "@adclub/api-client";
import type { ClosedDate, SupplierCard } from "@adclub/contracts";
import { normalizeKzMobilePhone } from "@adclub/domain";
import type { Lang } from "@adclub/i18n";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  IconButton,
  Segments,
  Switch,
  TextField,
  useToast,
} from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { refreshCompany, setCompanyCard, type CabinetState } from "../cabinet/cabinet-store";
import { companyStateText } from "../cabinet/company-state";
import {
  closedDateProblem,
  todayIn,
  upcomingClosedDates,
  weekFormOf,
  weeklyHoursOf,
  type DayForm,
  type DayMode,
  type WeekForm,
} from "../company/schedule-form";
import { formatPhone, typePhone, useOnline } from "@adclub/web-session";
import { saveErrorText } from "../errors";
import { useLanguage, useT, type Translate } from "../i18n";

type Ready = Extract<CabinetState, { status: "ready" }>;

function isConflict(error: unknown): boolean {
  return isApiError(error) && error.code === "SUPPLIER_VERSION_CONFLICT";
}

function cityName(card: SupplierCard, lang: Lang): string {
  return card.city.names[lang] ?? card.city.names.ru;
}

/** S-COMP-01 «Компания». */
export function Company({ cabinet }: { cabinet: Ready }) {
  const t = useT();
  const { lang } = useLanguage();
  const card = cabinet.company.company;
  const [conflict, setConflict] = useState(false);
  // Remounting the forms on «Обновить» refills them from the newest card.
  const [formKey, setFormKey] = useState(0);

  const reload = async () => {
    await refreshCompany();
    setConflict(false);
    setFormKey((key) => key + 1);
  };

  return (
    <>
      <h1 className="ac-text-title page__title">{t("company.title")}</h1>
      {conflict && (
        <Banner
          tone="warning"
          action={
            <Button variant="text" size="s" onClick={reload}>
              {t("company.reload")}
            </Button>
          }
        >
          {t("company.conflict")}
        </Banner>
      )}

      <section className="card">
        <dl className="facts">
          <div>
            <dt>{t("company.name")}</dt>
            <dd className="facts__long">{card.name}</dd>
          </div>
          <div>
            <dt>{t("company.bin")}</dt>
            <dd className="num">{card.bin ?? t("common.notSet")}</dd>
          </div>
          <div>
            <dt>{t("company.city")}</dt>
            <dd>{cityName(card, lang)}</dd>
          </div>
          <div>
            <dt>{t("company.state")}</dt>
            <dd className="facts__badges">
              {card.state === "active" ? (
                t(companyStateText(card))
              ) : (
                <Badge tone={card.state === "blocked" ? "danger" : "warning"} icon="alertTriangle">
                  {t(companyStateText(card))}
                </Badge>
              )}
              {card.verification && (
                <Badge tone="success" icon="progressCheck">
                  {t("company.verified")}
                </Badge>
              )}
            </dd>
          </div>
        </dl>
        <p className="ac-text-caption ac-muted">{t("company.adminOnly")}</p>
      </section>

      <CompanyForms key={formKey} card={card} onConflict={() => setConflict(true)} />
    </>
  );
}

/**
 * The two forms of S-COMP-01. Each saves with the version it was filled
 * from: a change made by someone else meanwhile (an administrator) is a
 * conflict, not something silently overwritten; the person's own save moves
 * both forms to the version the server returned.
 */
function CompanyForms({ card, onConflict }: { card: SupplierCard; onConflict: () => void }) {
  const [versions, setVersions] = useState({
    point: card.version,
    schedule: card.version,
    delivery: card.version,
  });

  const saved = (next: SupplierCard, previous: number) => {
    setCompanyCard(next);
    setVersions((current) => ({
      point: current.point === previous ? next.version : current.point,
      schedule: current.schedule === previous ? next.version : current.schedule,
      delivery: current.delivery === previous ? next.version : current.delivery,
    }));
  };

  return (
    <>
      <PointForm card={card} version={versions.point} onSaved={saved} onConflict={onConflict} />
      <ScheduleForm
        card={card}
        version={versions.schedule}
        onSaved={saved}
        onConflict={onConflict}
      />
      <DeliveryDefaultForm
        card={card}
        version={versions.delivery}
        onSaved={saved}
        onConflict={onConflict}
      />
    </>
  );
}

interface FormProps {
  card: SupplierCard;
  version: number;
  onSaved: (card: SupplierCard, previousVersion: number) => void;
  onConflict: () => void;
}

function SaveRow({
  onSave,
  disabled,
  error,
}: {
  onSave: () => Promise<unknown>;
  disabled?: boolean;
  error: string | null;
}) {
  const t = useT();
  const online = useOnline();
  return (
    <div className="stack-s">
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="actions-row">
        <Button disabled={!online || disabled} onClick={onSave}>
          {t("common.save")}
        </Button>
        {!online && <span className="ac-text-caption ac-muted">{t("common.needNetwork")}</span>}
      </div>
    </div>
  );
}

function PointForm({ card, version, onSaved, onConflict }: FormProps) {
  const t = useT();
  const toast = useToast();
  const [address, setAddress] = useState(card.location.address ?? "");
  const [district, setDistrict] = useState(card.location.district ?? "");
  const [phone, setPhone] = useState(card.contactPhone ? formatPhone(card.contactPhone) : "+7");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const phoneDigits = phone.replace(/\D/g, "");
  const phoneValue = phoneDigits.length <= 1 ? null : normalizeKzMobilePhone(phone);

  const save = async () => {
    setError(null);
    if (phoneDigits.length > 1 && phoneValue === null) {
      setPhoneError(t("auth.phoneInvalid"));
      return;
    }
    try {
      const { company } = await apiClient.updateSupplierCompany({
        expectedVersion: version,
        address: address.trim() || null,
        district: district.trim() || null,
        contactPhone: phoneValue,
      });
      onSaved(company, version);
      toast.show(t("common.saved"));
    } catch (thrown) {
      if (isConflict(thrown)) onConflict();
      else setError(saveErrorText(thrown, t));
    }
  };

  return (
    <section className="card stack-m">
      <h2 className="ac-text-heading">{t("company.point")}</h2>
      <TextField
        label={t("company.address")}
        value={address}
        onChange={setAddress}
        maxLength={300}
        autoComplete="street-address"
      />
      <TextField
        label={t("company.district")}
        value={district}
        onChange={setDistrict}
        maxLength={100}
      />
      <TextField
        label={t("company.phone")}
        value={phone}
        onChange={(value) => {
          setPhone(typePhone(value));
          setPhoneError(null);
        }}
        type="tel"
        inputMode="tel"
        hint={phoneError ? undefined : t("company.phoneHint")}
        error={phoneError ?? undefined}
      />
      <SaveRow onSave={save} error={error} />
    </section>
  );
}

/**
 * «Доставка по умолчанию для новых предложений» (S-COMP-01, TASK-032):
 * saved as soon as it is switched, with the version of the card. Only the
 * starting value of «Доставка» in the form of a new offer — offers already
 * on sale keep theirs.
 */
function DeliveryDefaultForm({ card, version, onSaved, onConflict }: FormProps) {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const [value, setValue] = useState(card.deliveryByDefault);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (next: boolean) => {
    setError(null);
    setValue(next);
    setSaving(true);
    try {
      const { company } = await apiClient.updateSupplierCompany({
        expectedVersion: version,
        deliveryByDefault: next,
      });
      onSaved(company, version);
      setValue(company.deliveryByDefault);
      toast.show(t("common.saved"));
    } catch (thrown) {
      setValue(card.deliveryByDefault);
      if (isConflict(thrown)) onConflict();
      else setError(saveErrorText(thrown, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card stack-m">
      <h2 className="ac-text-heading">{t("company.offers")}</h2>
      <Switch
        label={t("company.deliveryDefault")}
        description={t("company.deliveryDefaultHint")}
        checked={value}
        disabled={!online || saving}
        onChange={(next) => void change(next)}
      />
      {!online && <span className="ac-text-caption ac-muted">{t("common.needNetwork")}</span>}
      {error && <Banner tone="danger">{error}</Banner>}
    </section>
  );
}

const MODES: DayMode[] = ["hours", "off", "allDay"];

function modeLabel(mode: DayMode, t: Translate): string {
  switch (mode) {
    case "off":
      return t("company.dayOff");
    case "allDay":
      return t("company.allDay");
    case "custom":
      return t("company.customHours");
    default:
      return t("company.workDay");
  }
}

function ScheduleForm({ card, version, onSaved, onConflict }: FormProps) {
  const t = useT();
  const toast = useToast();
  const today = todayIn(card.timeZone);
  const [week, setWeek] = useState<WeekForm>(() => weekFormOf(card.schedule.weeklyHours));
  const [dates, setDates] = useState<ClosedDate[]>(() =>
    upcomingClosedDates(card.schedule.closedDates, today),
  );
  const [invalidDays, setInvalidDays] = useState<number[]>([]);
  const [noWorkingDay, setNoWorkingDay] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setDay = (day: number, change: Partial<DayForm>) => {
    setWeek((current) => current.map((item) => (item.day === day ? { ...item, ...change } : item)));
    setInvalidDays((current) => current.filter((item) => item !== day));
    setNoWorkingDay(false);
  };

  const save = async () => {
    setError(null);
    const result = weeklyHoursOf(week);
    if (!result.ok) {
      setInvalidDays(result.invalidDays);
      setNoWorkingDay(result.noWorkingDay);
      return;
    }
    try {
      const { company } = await apiClient.setSupplierSchedule({
        expectedVersion: version,
        weeklyHours: result.weeklyHours,
        closedDates: upcomingClosedDates(dates, todayIn(card.timeZone)),
      });
      onSaved(company, version);
      toast.show(t("common.saved"));
    } catch (thrown) {
      if (isConflict(thrown)) onConflict();
      else setError(saveErrorText(thrown, t));
    }
  };

  return (
    <section className="card stack-m">
      <h2 className="ac-text-heading">{t("company.hours")}</h2>
      {card.schedule.weeklyHours === null ? (
        <Banner tone="warning">{t("company.hoursNotSet")}</Banner>
      ) : (
        <p className="ac-text-body-s ac-muted">{t("company.hoursHint")}</p>
      )}
      <ul className="week">
        {week.map((day) => (
          <WeekDay
            key={day.day}
            day={day}
            invalid={invalidDays.includes(day.day)}
            onChange={(change) => setDay(day.day, change)}
          />
        ))}
      </ul>
      {noWorkingDay && <Banner tone="danger">{t("company.noWorkingDay")}</Banner>}

      <h2 className="ac-text-heading">{t("company.closedDates")}</h2>
      <p className="ac-text-body-s ac-muted">{t("company.closedDatesHint")}</p>
      <ClosedDates dates={dates} today={today} onChange={setDates} />

      <SaveRow onSave={save} error={error} />
    </section>
  );
}

function WeekDay({
  day,
  invalid,
  onChange,
}: {
  day: DayForm;
  invalid: boolean;
  onChange: (change: Partial<DayForm>) => void;
}) {
  const t = useT();
  const dayName = t(`day.${day.day}` as `day.${1 | 2 | 3 | 4 | 5 | 6 | 7}`);
  const modes = day.mode === "custom" ? [...MODES, "custom" as const] : MODES;
  return (
    <li className="week__day">
      <span className="ac-text-body-strong">{dayName}</span>
      <Segments<DayMode>
        label={`${dayName}: ${t("company.dayMode")}`}
        value={day.mode}
        onChange={(mode) => onChange({ mode })}
        options={modes.map((mode) => ({ value: mode, label: modeLabel(mode, t) }))}
      />
      {day.mode === "custom" && (
        <p className="ac-text-body-s num">
          {day.custom.map((interval) => `${interval.from}–${interval.to}`).join(", ")}
        </p>
      )}
      {day.mode === "hours" && (
        <div className="week__hours">
          <div className="time-range">
            <TimeInput
              label={`${dayName}: ${t("company.from")}`}
              text={t("company.from")}
              value={day.from}
              invalid={invalid}
              onChange={(from) => onChange({ from })}
            />
            <TimeInput
              label={`${dayName}: ${t("company.to")}`}
              text={t("company.to")}
              value={day.to}
              invalid={invalid}
              onChange={(to) => onChange({ to })}
            />
          </div>
          <Checkbox
            label={t("company.withBreak")}
            checked={day.withBreak}
            onChange={(withBreak) => onChange({ withBreak })}
          />
          {day.withBreak && (
            <div className="time-range">
              <TimeInput
                label={`${dayName}: ${t("company.breakFrom")}`}
                text={t("company.breakFrom")}
                value={day.breakFrom}
                invalid={invalid}
                onChange={(breakFrom) => onChange({ breakFrom })}
              />
              <TimeInput
                label={`${dayName}: ${t("company.breakTo")}`}
                text={t("company.breakTo")}
                value={day.breakTo}
                invalid={invalid}
                onChange={(breakTo) => onChange({ breakTo })}
              />
            </div>
          )}
          {invalid && (
            <p className="ac-field__help ac-field__help--error" role="alert">
              {t("company.intervalInvalid")}
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
    <label className="time-input">
      <span className="field-block__label">{text}</span>
      <input
        type="time"
        className={
          invalid ? "time-input__control time-input__control--error" : "time-input__control"
        }
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={value}
        step={300}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ClosedDates({
  dates,
  today,
  onChange,
}: {
  dates: ClosedDate[];
  today: string;
  onChange: (dates: ClosedDate[]) => void;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const format = new Intl.DateTimeFormat(lang === "kk" ? "kk-KZ" : lang, {
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
          ? t("company.pastDate")
          : reason === "duplicate"
            ? t("company.duplicateDate")
            : t("company.date"),
      );
      return;
    }
    onChange(upcomingClosedDates([...dates, { date, note: note.trim() || null }], today));
    setDate("");
    setNote("");
    setProblem(null);
  };

  return (
    <div className="stack-m">
      {dates.length === 0 ? (
        <p className="ac-text-body-s ac-muted">{t("company.closedDatesEmpty")}</p>
      ) : (
        <ul className="closed-dates">
          {dates.map((item) => (
            <li key={item.date} className="closed-dates__item">
              <span className="closed-dates__text">
                <span className="ac-text-body">
                  {format.format(new Date(`${item.date}T12:00:00Z`))}
                </span>
                {item.note && <span className="ac-text-body-s ac-muted">{item.note}</span>}
              </span>
              <IconButton
                icon="x"
                label={`${t("company.removeDate")}: ${item.date}`}
                onClick={() => onChange(dates.filter((other) => other.date !== item.date))}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="closed-dates__add">
        <label className="time-input">
          <span className="field-block__label">{t("company.date")}</span>
          <input
            type="date"
            className={
              problem ? "time-input__control time-input__control--error" : "time-input__control"
            }
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
          label={t("company.note")}
          value={note}
          onChange={setNote}
          maxLength={200}
          placeholder={t("company.notePlaceholder")}
        />
        <Button variant="secondary" icon="calendarX" disabled={!date} onClick={add}>
          {t("company.addDate")}
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

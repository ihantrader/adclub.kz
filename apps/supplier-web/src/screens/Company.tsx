import { isApiError } from "@adclub/api-client";
import type { ClosedDate, SupplierCard } from "@adclub/contracts";
import { normalizeKzMobilePhone } from "@adclub/domain";
import type { Lang } from "@adclub/i18n";
import {
  Badge,
  Banner,
  Button,
  ClosedDatesEditor,
  Switch,
  TextField,
  todayIn,
  upcomingClosedDates,
  useToast,
  WeekHoursEditor,
  weekFormOf,
  weeklyHoursOf,
  type ClosedDatesTexts,
  type DayForm,
  type WeekForm,
  type WeekHoursTexts,
} from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { refreshCompany, setCompanyCard, type CabinetState } from "../cabinet/cabinet-store";
import { companyStateText } from "../cabinet/company-state";
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

/** The words of the shared hours editor, in the cabinet's language. */
function weekTexts(t: Translate): WeekHoursTexts {
  return {
    days: [t("day.1"), t("day.2"), t("day.3"), t("day.4"), t("day.5"), t("day.6"), t("day.7")],
    dayMode: t("company.dayMode"),
    workDay: t("company.workDay"),
    dayOff: t("company.dayOff"),
    allDay: t("company.allDay"),
    customHours: t("company.customHours"),
    from: t("company.from"),
    to: t("company.to"),
    withBreak: t("company.withBreak"),
    breakFrom: t("company.breakFrom"),
    breakTo: t("company.breakTo"),
    intervalInvalid: t("company.intervalInvalid"),
  };
}

function closedDatesTexts(t: Translate): ClosedDatesTexts {
  return {
    date: t("company.date"),
    note: t("company.note"),
    notePlaceholder: t("company.notePlaceholder"),
    addDate: t("company.addDate"),
    removeDate: t("company.removeDate"),
    empty: t("company.closedDatesEmpty"),
    pastDate: t("company.pastDate"),
    duplicateDate: t("company.duplicateDate"),
  };
}

/** The hours and days off — the same editor the admin panel uses (`@adclub/ui`, TASK-036). */
function ScheduleForm({ card, version, onSaved, onConflict }: FormProps) {
  const t = useT();
  const { lang } = useLanguage();
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
      <WeekHoursEditor
        week={week}
        invalidDays={invalidDays}
        onDayChange={setDay}
        texts={weekTexts(t)}
      />
      {noWorkingDay && <Banner tone="danger">{t("company.noWorkingDay")}</Banner>}

      <h2 className="ac-text-heading">{t("company.closedDates")}</h2>
      <p className="ac-text-body-s ac-muted">{t("company.closedDatesHint")}</p>
      <ClosedDatesEditor
        dates={dates}
        today={today}
        onChange={setDates}
        texts={closedDatesTexts(t)}
        locale={lang === "kk" ? "kk-KZ" : lang}
      />

      <SaveRow onSave={save} error={error} />
    </section>
  );
}

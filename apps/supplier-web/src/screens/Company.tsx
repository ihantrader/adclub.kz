import { isApiError } from "@adclub/api-client";
import type { ClosedDate, SupplierCard } from "@adclub/contracts";
import { normalizeKzMobilePhone } from "@adclub/domain";
import type { Lang } from "@adclub/i18n";
import {
  ActionBar,
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
  type DayForm,
  type WeekForm,
} from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { refreshCompany, setCompanyCard, type CabinetState } from "../cabinet/cabinet-store";
import { companyStateText } from "../cabinet/company-state";
import { formatPhone, typePhone, useOnline } from "@adclub/web-session";
import { saveErrorText } from "../errors";
import { useLanguage, useT } from "../i18n";
import { goBackTo } from "../router";
import { closedDatesTexts, dateLocale, weekTexts } from "./form-texts";
import { PageHeader } from "./PageHeader";

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
  // Remounting the form on «Обновить» refills it from the newest card.
  const [formKey, setFormKey] = useState(0);

  const reload = async () => {
    await refreshCompany();
    setConflict(false);
    setFormKey((key) => key + 1);
  };

  return (
    <>
      <PageHeader title={t("company.title")} back={() => goBackTo("more")} deskRoot />
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

      <section className="card" aria-labelledby="company-details">
        <h2 id="company-details" className="ac-text-heading">
          {t("company.details")}
        </h2>
        <dl className="facts facts--rows">
          <div>
            <dt>{t("company.name")}</dt>
            <dd>{card.name}</dd>
          </div>
          <div>
            <dt>{t("company.bin")}</dt>
            <dd className="num">{card.bin ?? t("common.notSet")}</dd>
          </div>
          <div>
            <dt>{t("company.city")}</dt>
            <dd>{cityName(card, lang)}</dd>
          </div>
        </dl>
        {/* «Работает» and «Проверенный партнёр» — both badges, in one row (TASK-079). */}
        <div className="facts__badges" aria-label={t("company.state")}>
          <Badge
            tone={
              card.state === "blocked" ? "danger" : card.state === "active" ? "success" : "warning"
            }
            icon={card.state === "active" ? "circleCheck" : "alertTriangle"}
          >
            {t(companyStateText(card))}
          </Badge>
          {card.verification && (
            <Badge tone="success" icon="progressCheck">
              {t("company.verified")}
            </Badge>
          )}
        </div>
        <p className="ac-text-caption ac-muted">{t("company.adminOnly")}</p>
      </section>

      <CompanyForm key={formKey} card={card} onConflict={() => setConflict(true)} />
    </>
  );
}

interface Base {
  version: number;
  address: string;
  district: string;
  contactPhone: string | null;
  deliveryByDefault: boolean;
  week: string;
  dates: string;
  hoursSet: boolean;
}

function baseOf(card: SupplierCard, today: string): Base {
  return {
    version: card.version,
    address: card.location.address ?? "",
    district: card.location.district ?? "",
    contactPhone: card.contactPhone,
    deliveryByDefault: card.deliveryByDefault,
    week: JSON.stringify(weekFormOf(card.schedule.weeklyHours)),
    dates: JSON.stringify(upcomingClosedDates(card.schedule.closedDates, today)),
    hoursSet: card.schedule.weeklyHours !== null,
  };
}

/**
 * Everything S-COMP-01 lets a supplier change, saved in one way (TASK-079):
 * the panel «Есть несохранённые изменения · Сохранить» appears with the
 * first change and saves all of it. The point, its phone and «Доставка по
 * умолчанию» go with the card's version they were filled from, the hours
 * and days off — with the version that save returned: a change made by
 * someone else meanwhile (an administrator) is a conflict, never silently
 * overwritten.
 */
function CompanyForm({ card, onConflict }: { card: SupplierCard; onConflict: () => void }) {
  const t = useT();
  const { lang } = useLanguage();
  const toast = useToast();
  const online = useOnline();
  const today = todayIn(card.timeZone);
  const [base, setBase] = useState<Base>(() => baseOf(card, today));
  const [address, setAddress] = useState(base.address);
  const [district, setDistrict] = useState(base.district);
  const [phone, setPhone] = useState(card.contactPhone ? formatPhone(card.contactPhone) : "+7");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [delivery, setDelivery] = useState(base.deliveryByDefault);
  const [week, setWeek] = useState<WeekForm>(() => weekFormOf(card.schedule.weeklyHours));
  const [dates, setDates] = useState<ClosedDate[]>(() =>
    upcomingClosedDates(card.schedule.closedDates, today),
  );
  const [invalidDays, setInvalidDays] = useState<number[]>([]);
  const [noWorkingDay, setNoWorkingDay] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneDigits = phone.replace(/\D/g, "");
  const phoneValue = phoneDigits.length <= 1 ? null : normalizeKzMobilePhone(phone);
  const pointDirty =
    address.trim() !== base.address.trim() ||
    district.trim() !== base.district.trim() ||
    (phoneValue ?? (phoneDigits.length > 1 ? phone : null)) !== base.contactPhone ||
    delivery !== base.deliveryByDefault;
  // Hours never saved are a change already: the default week has to be saved (D-060).
  const scheduleDirty =
    !base.hoursSet || JSON.stringify(week) !== base.week || JSON.stringify(dates) !== base.dates;
  const dirty = pointDirty || scheduleDirty;

  const setDay = (day: number, change: Partial<DayForm>) => {
    setWeek((current) => current.map((item) => (item.day === day ? { ...item, ...change } : item)));
    setInvalidDays((current) => current.filter((item) => item !== day));
    setNoWorkingDay(false);
  };

  const save = async () => {
    setError(null);
    if (phoneDigits.length > 1 && phoneValue === null) {
      setPhoneError(t("auth.phoneInvalid"));
      return;
    }
    const hours = weeklyHoursOf(week);
    if (scheduleDirty && !hours.ok) {
      setInvalidDays(hours.invalidDays);
      setNoWorkingDay(hours.noWorkingDay);
      return;
    }
    let version = base.version;
    try {
      if (pointDirty) {
        const { company } = await apiClient.updateSupplierCompany({
          expectedVersion: version,
          address: address.trim() || null,
          district: district.trim() || null,
          contactPhone: phoneValue,
          deliveryByDefault: delivery,
        });
        version = company.version;
        setCompanyCard(company);
        setBase((current) => ({
          ...current,
          version: company.version,
          address: company.location.address ?? "",
          district: company.location.district ?? "",
          contactPhone: company.contactPhone,
          deliveryByDefault: company.deliveryByDefault,
        }));
      }
      if (scheduleDirty && hours.ok) {
        const kept = upcomingClosedDates(dates, todayIn(card.timeZone));
        const { company } = await apiClient.setSupplierSchedule({
          expectedVersion: version,
          weeklyHours: hours.weeklyHours,
          closedDates: kept,
        });
        setCompanyCard(company);
        setBase((current) => ({
          ...current,
          version: company.version,
          week: JSON.stringify(week),
          dates: JSON.stringify(kept),
          hoursSet: true,
        }));
      }
      toast.show(t("common.saved"));
    } catch (thrown) {
      if (isConflict(thrown)) onConflict();
      else setError(saveErrorText(thrown, t));
    }
  };

  return (
    <>
      <section className="card" aria-labelledby="company-point">
        <h2 id="company-point" className="ac-text-heading">
          {t("company.point")}
        </h2>
        <div className="form-grid">
          <TextField
            className="form-grid__wide"
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
        </div>
      </section>

      <section className="card" aria-labelledby="company-hours">
        <h2 id="company-hours" className="ac-text-heading">
          {t("company.hours")}
        </h2>
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
      </section>

      <section className="card" aria-labelledby="company-closed">
        <h2 id="company-closed" className="ac-text-heading">
          {t("company.closedDates")}
        </h2>
        <p className="ac-text-body-s ac-muted">{t("company.closedDatesHint")}</p>
        <ClosedDatesEditor
          dates={dates}
          today={today}
          onChange={setDates}
          texts={closedDatesTexts(t)}
          locale={dateLocale(lang)}
        />
      </section>

      <section className="card" aria-labelledby="company-offers">
        <h2 id="company-offers" className="ac-text-heading">
          {t("company.offers")}
        </h2>
        <Switch
          label={t("company.deliveryDefault")}
          description={t("company.deliveryDefaultHint")}
          checked={delivery}
          onChange={setDelivery}
        />
      </section>

      {error && <Banner tone="danger">{error}</Banner>}
      {dirty && (
        <ActionBar
          pinned
          className="save-panel"
          note={online ? t("company.hasChanges") : t("common.needNetwork")}
          main={
            <Button size="l" disabled={!online} onClick={save}>
              {t("common.save")}
            </Button>
          }
        />
      )}
    </>
  );
}

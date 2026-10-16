import type { CityListResponse } from "@adclub/contracts";
import { Banner, Button, Checkbox, Icon, Logo, Segments, TextField } from "@adclub/ui";
import { typePhone, useOnline } from "@adclub/web-session";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiClient, setApiLanguage } from "../api";
import { storedLanguage, storeLanguage } from "../prefs";
import { createTranslate } from "../translate";
import {
  emptyJoinForm,
  joinBody,
  joinErrors,
  joinRefusal,
  type JoinErrors,
  type JoinForm,
} from "./join-rules";

/** The address of the page: open, in the cabinet's build, without a session. */
export const JOIN_PATH = "/join";

type PageLang = "kk" | "ru";

/**
 * S-PUB-01 «Заявка на подключение» (TASK-077; SCREENS 6.1, flow F8): the
 * page a company opens in a browser to ask to join the club — no sign-in,
 * no session exchange (it lives in the cabinet's build only to share its
 * origin, which the API already lets in). Kazakh and Russian, the
 * browser's language first. The БИН's check digit is checked before
 * sending; everything else the server decides (`POST /supplier-leads`):
 * a known company gets the same answer as a new one.
 */
export function JoinPage() {
  const [lang, setLang] = useState<PageLang>(() => (storedLanguage() === "kk" ? "kk" : "ru"));
  const t = useMemo(() => createTranslate(lang, null), [lang]);
  const online = useOnline();
  const [form, setForm] = useState<JoinForm>(emptyJoinForm);
  const [cities, setCities] = useState<CityListResponse["cities"] | null>(null);
  const [citiesFailed, setCitiesFailed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<JoinErrors>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  // A second press while the first is on its way sends nothing (the server
  // would also drop a repeat of the same request).
  const inFlight = useRef(false);

  setApiLanguage(lang);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t("join.title");
  }, [lang, t]);

  // The names of the cities are in the page's language; «Повторить» asks again.
  const [citiesAsked, setCitiesAsked] = useState(0);
  useEffect(() => {
    let current = true;
    // The cabinet's language provider sets the header too: this request is in the page's.
    setApiLanguage(lang);
    apiClient.getCities().then(
      (answer) => {
        if (!current || answer.language !== lang) return;
        setCities(answer.cities);
        setCitiesFailed(false);
      },
      () => {
        if (current) setCitiesFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [lang, citiesAsked]);
  const loadCities = () => setCitiesAsked((count) => count + 1);

  const errors: JoinErrors = touched ? { ...joinErrors(form, t), ...serverErrors } : serverErrors;
  // The БИН is checked as soon as it has its 12 digits, before any press.
  const binDigits = form.bin.replace(/\D/g, "").length;
  const binError = errors.bin ?? (binDigits >= 12 ? joinErrors(form, t).bin : undefined);

  const change = <K extends keyof JoinForm>(key: K, value: JoinForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    // A server's word about a field goes once the field changes.
    const field: keyof JoinErrors | null =
      key === "goods" || key === "services" ? "type" : key === "website" ? null : key;
    if (field) {
      setServerErrors((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    const body = joinBody(form, lang);
    if (!body || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setRefusal(null);
    try {
      await apiClient.submitSupplierLead(body);
      setSent(true);
    } catch (error) {
      const refused = joinRefusal(error, t);
      setServerErrors(refused.fields);
      setRefusal(refused.text);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <main className="auth-page join-page">
      <div className="auth-card join-card">
        <Logo height={40} />
        {sent ? (
          <div className="auth-stack" role="status">
            <Icon name="circleCheck" size={24} />
            <h1 className="ac-text-title">{t("join.sent")}</h1>
          </div>
        ) : (
          <form className="auth-stack" noValidate onSubmit={(event) => void submit(event)}>
            <div className="stack-s">
              <h1 className="ac-text-title">{t("join.title")}</h1>
              <p className="ac-text-body ac-muted">{t("join.lead")}</p>
            </div>
            <TextField
              label={t("join.companyName")}
              value={form.companyName}
              maxLength={200}
              autoComplete="organization"
              onChange={(value) => change("companyName", value)}
              error={errors.companyName}
            />
            <TextField
              label={t("join.bin")}
              value={form.bin}
              inputMode="numeric"
              maxLength={16}
              onChange={(value) => change("bin", value.replace(/[^\d\s-]/g, ""))}
              hint={binError ? undefined : t("join.binHint")}
              error={binError}
            />
            <label className="field-block">
              <span className="field-block__label">{t("join.city")}</span>
              <span
                className={`inline-field inline-field--select join-select${errors.cityId ? " inline-field--error" : ""}`}
              >
                <select
                  className="inline-field__select"
                  value={form.cityId}
                  disabled={cities === null}
                  aria-invalid={errors.cityId ? true : undefined}
                  onChange={(event) => change("cityId", event.target.value)}
                >
                  <option value="">{t("join.cityChoose")}</option>
                  {cities?.map((city) => (
                    <option key={city.id} value={city.id}>
                      {city.name.text}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={16} />
              </span>
              {errors.cityId && <span className="ac-text-caption join-error">{errors.cityId}</span>}
            </label>
            {citiesFailed && (
              <Banner
                tone="danger"
                icon="alertTriangle"
                action={
                  <Button variant="text" size="s" onClick={loadCities}>
                    {t("common.retry")}
                  </Button>
                }
              >
                {t("join.citiesFailed")}
              </Banner>
            )}
            <fieldset className="field-block join-offer">
              <legend className="field-block__label">{t("join.offer")}</legend>
              <div className="join-offer__options">
                <Checkbox
                  label={t("join.goods")}
                  checked={form.goods}
                  onChange={(checked) => change("goods", checked)}
                />
                <Checkbox
                  label={t("join.services")}
                  checked={form.services}
                  onChange={(checked) => change("services", checked)}
                />
              </div>
              <span className={`ac-text-caption ${errors.type ? "join-error" : "ac-muted"}`}>
                {errors.type ?? t("join.offerHint")}
              </span>
            </fieldset>
            <TextField
              label={t("join.contactName")}
              value={form.contactName}
              maxLength={100}
              autoComplete="name"
              onChange={(value) => change("contactName", value)}
              error={errors.contactName}
            />
            <TextField
              label={t("join.phone")}
              value={form.phone}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              onChange={(value) => change("phone", typePhone(value))}
              error={errors.phone}
            />
            {/* People never see it: a robot that fills every field fills this one too. */}
            <div className="join-trap" aria-hidden="true">
              <label>
                Website
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={form.website}
                  onChange={(event) => change("website", event.target.value)}
                />
              </label>
            </div>
            <div className="stack-s">
              <Checkbox
                label={t("join.consent")}
                checked={form.consent}
                onChange={(checked) => change("consent", checked)}
              />
              {errors.consent && (
                <span className="ac-text-caption join-error">{errors.consent}</span>
              )}
            </div>
            {refusal && (
              <Banner tone="danger" icon="alertTriangle">
                {refusal}
              </Banner>
            )}
            {!online && <Banner icon="wifiOff">{t("common.offline")}</Banner>}
            <Button type="submit" size="l" block loading={sending} disabled={sending || !online}>
              {t("join.submit")}
            </Button>
            <a className="join-signin ac-text-body-s" href="/">
              {t("join.signIn")}
            </a>
          </form>
        )}
      </div>
      <div className="auth-footer">
        <Segments<PageLang>
          label={t("language.label")}
          value={lang}
          onChange={(next) => {
            storeLanguage(next);
            setLang(next);
          }}
          options={[
            { value: "kk", label: t("language.kk") },
            { value: "ru", label: t("language.ru") },
          ]}
        />
      </div>
    </main>
  );
}

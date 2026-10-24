import type { OfferItem, SupplierOffer } from "@adclub/contracts";
import {
  ActionBar,
  Banner,
  Button,
  Icon,
  Radio,
  SearchSelect,
  Segments,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useId, useMemo, useState } from "react";
import { apiClient } from "../api";
import { useLanguage, useT } from "../i18n";
import { navigateTo, offerPath, replaceRouteState, useRouteState } from "../router";
import {
  BackHead,
  FORM_ID,
  ItemBlock,
  OfferStateLine,
  OfferStatusAction,
  PRICE_FIELD,
  ProblemLink,
} from "./OfferScreen";
import { typeAmount, type WarrantyKind } from "./offer-rules";
import { loadMakes, loadModels, searchNamed } from "./vehicle-choices";
import {
  changedServiceValues,
  checkServiceForm,
  newModelRow,
  newServiceForm,
  serviceFormOf,
  servicePreview,
  serviceProblem,
  type ModelRow,
  type ServiceField,
  type ServiceForm,
  type ServiceProblem,
} from "./service-offer-rules";

// The makes and models of the table of prices: `vehicle-choices.ts`.
const search = searchNamed;

const sameField = (a: ServiceField | null, b: ServiceField) =>
  a !== null &&
  (typeof a === "string" || typeof b === "string" ? a === b : a.row === b.row && a.part === b.part);

/**
 * S-OFF-04 — the offer on a service, new or saved: one price for all models
 * or a table «марка — модель — цена», the warranty and the own article and
 * name. A service is done at the point: no availability, term, pickup or
 * delivery. Every rule is the server's; its refusal comes back to the row or
 * the field it is about.
 */
export function ServiceOfferEditor({
  item,
  offer,
  onOffer,
}: {
  item: OfferItem;
  offer: SupplierOffer | null;
  onOffer?: (offer: SupplierOffer) => void;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const toast = useToast();
  const online = useOnline();
  const opened = useRouteState() as { checkPrice?: boolean } | null;
  const [form, setForm] = useState<ServiceForm>(() =>
    offer ? serviceFormOf(offer) : newServiceForm(),
  );
  const [problem, setProblem] = useState<ServiceProblem | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pricingName = useId();
  const checkPrice = offer !== null && opened?.checkPrice === true && offer.status !== "withdrawn";

  const texts = useMemo(
    () => ({
      failed: t("searchSelect.failed"),
      nothing: t("searchSelect.nothing"),
      searching: t("searchSelect.searching"),
    }),
    [t],
  );

  const set = (change: Partial<ServiceForm>) => {
    setForm((current) => ({ ...current, ...change }));
    setProblem(null);
  };
  const setRow = (key: string, change: Partial<ModelRow>) =>
    set({ rows: form.rows.map((row) => (row.key === key ? { ...row, ...change } : row)) });

  const checked = checkServiceForm(form);
  const changed = offer && checked.ok ? changedServiceValues(offer, checked.values) : null;
  const dirty = offer === null || changed === null || Object.keys(changed).length > 0;
  const errorAt = (field: ServiceField) =>
    problem && sameField(problem.field, field) ? t(problem.key, problem.params) : undefined;

  const save = async () => {
    setConflict(null);
    if (!checked.ok) {
      setProblem(checked.problem);
      return;
    }
    setSaving(true);
    try {
      if (offer === null) {
        const { offer: created } = await apiClient.createSupplierOffer({
          itemId: item.id,
          ...checked.values,
        });
        toast.show(t("common.saved"));
        navigateTo(offerPath(created.id), { replace: true, state: { saved: true } });
        return;
      }
      if (!changed || Object.keys(changed).length === 0) return;
      const { offer: saved } = await apiClient.updateSupplierOffer(
        { offerId: offer.id },
        { expectedVersion: offer.version, ...changed },
      );
      onOffer?.(saved);
      setForm(serviceFormOf(saved));
      if (opened?.checkPrice) replaceRouteState({});
      toast.show(t("common.saved"));
    } catch (error) {
      const found = serviceProblem(error, form);
      if (found.conflict && offer) {
        // A colleague changed it: the newest offer comes, what was typed stays.
        try {
          const { offer: fresh } = await apiClient.getSupplierOffer({ offerId: offer.id });
          onOffer?.(fresh);
        } catch {
          // The banner below says reload anyway.
        }
        setConflict(t("offers.conflict"));
      } else {
        setProblem(found);
      }
    } finally {
      setSaving(false);
    }
  };

  const preview = servicePreview(form, t);

  return (
    <>
      <BackHead title={offer ? t("serviceForm.title") : t("serviceForm.newTitle")} />

      {checkPrice && <Banner tone="warning">{t("offers.checkPrice")}</Banner>}
      {conflict && <Banner tone="warning">{conflict}</Banner>}
      {problem && problem.field === null && (
        <Banner tone={problem.conflict ? "warning" : "danger"}>
          {t(problem.key, problem.params)} <ProblemLink problem={problem} />
        </Banner>
      )}

      <ItemBlock item={item}>{offer && <OfferStateLine offer={offer} />}</ItemBlock>

      {/* The bar is pinned while its form is in sight, never over what follows (C2). */}
      <div className="form-with-bar">
        <form
          id={FORM_ID}
          className="card offer-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="ac-text-body-s ac-muted">{t("serviceForm.atPoint")}</p>

          {/* Two long choices: radio rows across, not segments cut at the edge (TASK-079). */}
          <fieldset className="field-block">
            <legend className="field-block__label">{t("serviceForm.pricing")}</legend>
            <Radio
              name={pricingName}
              label={t("serviceForm.single")}
              checked={form.mode === "single"}
              onChange={() => set({ mode: "single" })}
            />
            <Radio
              name={pricingName}
              label={t("serviceForm.byModel")}
              checked={form.mode === "by_model"}
              onChange={() => set({ mode: "by_model" })}
            />
          </fieldset>

          {form.mode === "single" ? (
            <div className="form-grid">
              <TextField
                id={PRICE_FIELD}
                label={t("offers.price")}
                value={form.price}
                onChange={(value) => set({ price: typeAmount(value) })}
                inputMode="numeric"
                autoComplete="off"
                hint={offer ? t("offers.newPriceHint") : t("serviceForm.priceHint")}
                error={errorAt("price")}
                trailing={<span className="ac-muted">₸</span>}
              />
            </div>
          ) : (
            <div className="field-block model-prices">
              <ul className="model-prices__list">
                {form.rows.map((row, index) => (
                  // A model is a small card of its own: what «Удалить» removes is plain (TASK-079).
                  <li key={row.key} className="model-prices__row">
                    <div className="model-prices__head">
                      <span className="ac-text-body-strong">
                        {[row.make?.label, row.model?.label].filter(Boolean).join(" ") ||
                          t("serviceForm.newModel", { n: index + 1 })}
                      </span>
                      <Button
                        variant="text"
                        destructive
                        disabled={form.rows.length === 1}
                        aria-label={`${t("serviceForm.removeModel")}: ${row.model?.label ?? String(index + 1)}`}
                        onClick={() =>
                          set({ rows: form.rows.filter((entry) => entry.key !== row.key) })
                        }
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                    <div className="form-grid model-prices__fields">
                      <SearchSelect
                        label={t("serviceForm.make")}
                        value={row.make}
                        onChange={(make) =>
                          setRow(row.key, {
                            make,
                            // Another make — the model was of the previous one.
                            model: make?.id === row.make?.id ? row.model : null,
                            available: true,
                          })
                        }
                        search={async (query) => search(await loadMakes(), query)}
                        texts={texts}
                        name={`modelPrices.${String(index)}.make`}
                      />
                      <SearchSelect
                        label={t("serviceForm.model")}
                        value={row.model}
                        onChange={(model) => setRow(row.key, { model, available: true })}
                        search={async (query) =>
                          row.make ? search(await loadModels(row.make.id), query) : []
                        }
                        sourceKey={row.make?.id ?? ""}
                        disabled={row.make === null}
                        placeholder={
                          row.make === null ? t("serviceForm.chooseMakeFirst") : undefined
                        }
                        hint={row.available ? undefined : t("serviceForm.archived")}
                        error={errorAt({ row: index, part: "model" })}
                        texts={texts}
                        name={`modelPrices.${String(index)}.modelId`}
                      />
                      <TextField
                        label={t("serviceForm.modelPrice")}
                        value={row.price}
                        onChange={(value) => setRow(row.key, { price: typeAmount(value) })}
                        inputMode="numeric"
                        autoComplete="off"
                        error={errorAt({ row: index, part: "price" })}
                        trailing={<span className="ac-muted">₸</span>}
                        className="model-prices__price"
                      />
                    </div>
                  </li>
                ))}
              </ul>
              <div>
                <Button
                  variant="secondary"
                  icon="plus"
                  onClick={() => set({ rows: [...form.rows, newModelRow()] })}
                >
                  {t("serviceForm.addModel")}
                </Button>
              </div>
              {errorAt("rows") && (
                <p className="ac-field__help ac-field__help--error" role="alert">
                  <Icon name="alertTriangle" size={16} />
                  <span>{errorAt("rows")}</span>
                </p>
              )}
              <p className="ac-text-body-s ac-muted">{t("serviceForm.noPriceHint")}</p>
            </div>
          )}

          <div className="form-grid">
            <div className="field-block form-grid__wide">
              <span className="field-block__label">{t("offerForm.warranty")}</span>
              <Segments<WarrantyKind>
                label={t("offerForm.warranty")}
                value={form.warranty}
                onChange={(warranty) => set({ warranty })}
                options={[
                  { value: "none", label: t("offerForm.warrantyNone") },
                  { value: "months", label: t("offerForm.warrantyMonths") },
                  { value: "text", label: t("offerForm.warrantyText") },
                ]}
              />
            </div>
            {form.warranty === "months" && (
              <TextField
                label={t("offerForm.warrantyMonthsLabel")}
                value={form.warrantyMonths}
                onChange={(value) => set({ warrantyMonths: value.replace(/\D/g, "").slice(0, 3) })}
                inputMode="numeric"
                autoComplete="off"
                error={errorAt("warrantyMonths")}
              />
            )}
            {form.warranty === "text" && (
              <TextField
                className="form-grid__wide"
                label={t("offerForm.warrantyTextLabel")}
                value={form.warrantyText}
                onChange={(warrantyText) => set({ warrantyText })}
                maxLength={100}
                hint={t("offerForm.warrantyTextHint")}
                error={errorAt("warrantyText")}
              />
            )}

            <h2 className="ac-text-heading form-grid__wide offer-form__block">
              {t("offerForm.own")}
            </h2>
            <TextField
              label={t("offerForm.supplierSku")}
              value={form.supplierSku}
              onChange={(supplierSku) => set({ supplierSku })}
              maxLength={64}
              autoComplete="off"
              error={errorAt("supplierSku")}
            />
            <TextField
              label={t("offerForm.supplierName")}
              value={form.supplierName}
              onChange={(supplierName) => set({ supplierName })}
              maxLength={200}
              autoComplete="off"
              hint={t("offerForm.ownHint")}
              error={errorAt("supplierName")}
            />
          </div>

          <section className="card preview" aria-live="polite" lang={lang}>
            <p className="ac-text-caption ac-muted">{t("offerForm.preview")}</p>
            {preview.length === 0 ? (
              <p className="ac-text-body-s ac-muted"> </p>
            ) : (
              preview.map((line) => (
                <p key={line} className="ac-text-body num">
                  {line}
                </p>
              ))
            )}
          </section>
        </form>

        <ActionBar
          pinned
          main={
            <Button
              type="submit"
              form={FORM_ID}
              size="l"
              loading={saving}
              disabled={!online || !dirty}
            >
              {offer ? t("common.save") : t("offerForm.create")}
            </Button>
          }
          note={online ? undefined : t("common.needNetwork")}
        />
      </div>

      {offer && (
        <OfferStatusAction
          offer={offer}
          onOffer={(next) => onOffer?.(next)}
          onProblem={(error) => setProblem(serviceProblem(error, form))}
        />
      )}
    </>
  );
}

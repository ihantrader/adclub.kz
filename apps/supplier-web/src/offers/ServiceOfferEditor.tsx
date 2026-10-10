import type { OfferItem, SupplierOffer, VehicleNamed } from "@adclub/contracts";
import {
  Banner,
  Button,
  Icon,
  IconButton,
  SearchSelect,
  Segments,
  TextField,
  toastObstacle,
  useToast,
  type Choice,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useMemo, useState } from "react";
import { apiClient } from "../api";
import { useLanguage, useT } from "../i18n";
import { navigateTo, offerPath, replaceRouteState, useRouteState } from "../router";
import { BackHead, ItemBlock, OfferStatePanel, PRICE_FIELD, ProblemLink } from "./OfferScreen";
import { typeAmount, type WarrantyKind } from "./offer-rules";
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

/**
 * The makes and the models of the vehicle catalog for the table of prices
 * (S-OFF-04): the public lists clients choose their car from (`/vehicles/…`),
 * each loaded once; the field searches them on the device by any spelling
 * («джили» → Geely), as the garage of the app does.
 */
let makes: Promise<VehicleNamed[]> | null = null;
const models = new Map<string, Promise<VehicleNamed[]>>();

function loadMakes(): Promise<VehicleNamed[]> {
  makes ??= apiClient.getVehicleMakes().then(
    (answer) => answer.makes,
    (error: unknown) => {
      makes = null;
      throw error;
    },
  );
  return makes;
}

function loadModels(makeId: string): Promise<VehicleNamed[]> {
  let found = models.get(makeId);
  if (!found) {
    found = apiClient.getVehicleMakeModels({ makeId }).then(
      (answer) => answer.models,
      (error: unknown) => {
        models.delete(makeId);
        throw error;
      },
    );
    models.set(makeId, found);
  }
  return found;
}

function search(list: VehicleNamed[], query: string): Choice[] {
  const wanted = query.trim().toLowerCase();
  return list
    .filter(
      (entry) =>
        wanted === "" ||
        [entry.name, ...entry.aliases].some((name) => name.toLowerCase().includes(wanted)),
    )
    .slice(0, 50)
    .map((entry) => ({
      id: entry.id,
      label: entry.name,
      note: entry.aliases.length > 0 ? entry.aliases.join(", ") : null,
    }));
}

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

      <ItemBlock item={item} />

      {offer && (
        <OfferStatePanel
          offer={offer}
          onOffer={(next) => {
            onOffer?.(next);
          }}
          onProblem={(error) => setProblem(serviceProblem(error, form))}
        />
      )}

      <form
        className="card stack-m offer-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="ac-text-body-s ac-muted">{t("serviceForm.atPoint")}</p>

        <div className="field-block">
          <span className="field-block__label">{t("serviceForm.pricing")}</span>
          <Segments<ServiceForm["mode"]>
            label={t("serviceForm.pricing")}
            value={form.mode}
            onChange={(mode) => set({ mode })}
            options={[
              { value: "single", label: t("serviceForm.single") },
              { value: "by_model", label: t("serviceForm.byModel") },
            ]}
          />
        </div>

        {form.mode === "single" ? (
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
            className="field-narrow"
          />
        ) : (
          <div className="field-block model-prices">
            <ul className="model-prices__list">
              {form.rows.map((row, index) => (
                <li key={row.key} className="model-prices__row">
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
                    placeholder={row.make === null ? t("serviceForm.chooseMakeFirst") : undefined}
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
                    className="model-prices__price"
                  />
                  <IconButton
                    icon="trash"
                    label={`${t("serviceForm.removeModel")}: ${row.model?.label ?? String(index + 1)}`}
                    disabled={form.rows.length === 1}
                    onClick={() =>
                      set({ rows: form.rows.filter((entry) => entry.key !== row.key) })
                    }
                  />
                </li>
              ))}
            </ul>
            <div>
              <Button
                variant="secondary"
                size="s"
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

        <div className="field-block">
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
          {form.warranty === "months" && (
            <TextField
              label={t("offerForm.warrantyMonthsLabel")}
              value={form.warrantyMonths}
              onChange={(value) => set({ warrantyMonths: value.replace(/\D/g, "").slice(0, 3) })}
              inputMode="numeric"
              autoComplete="off"
              error={errorAt("warrantyMonths")}
              className="field-narrow"
            />
          )}
          {form.warranty === "text" && (
            <TextField
              label={t("offerForm.warrantyTextLabel")}
              value={form.warrantyText}
              onChange={(warrantyText) => set({ warrantyText })}
              maxLength={100}
              hint={t("offerForm.warrantyTextHint")}
              error={errorAt("warrantyText")}
            />
          )}
        </div>

        <div className="field-block">
          <span className="field-block__label">{t("offerForm.own")}</span>
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

        <div className="save-bar" {...toastObstacle}>
          <Button type="submit" size="l" loading={saving} disabled={!online || !dirty}>
            {offer ? t("common.save") : t("offerForm.create")}
          </Button>
          {!online && <span className="ac-text-caption ac-muted">{t("common.needNetwork")}</span>}
        </div>
      </form>
    </>
  );
}

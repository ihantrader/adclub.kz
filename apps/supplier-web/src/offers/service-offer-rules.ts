import { isApiError } from "@adclub/api-client";
import type {
  OfferModelPriceInput,
  OfferPriceMode,
  SupplierOffer,
  UpdateOfferBody,
} from "@adclub/contracts";
import { servicePriceForCar, type ServicePricing } from "@adclub/domain";
import { pluralForm, type Lang, type SupplierTextKey } from "@adclub/i18n";
import {
  formatAmount,
  offerProblem,
  parseAmount,
  type OfferProblem,
  type Translate,
  type WarrantyKind,
} from "./offer-rules";

/**
 * The form of an offer on a service (TASK-019; SCREENS S-OFF-04): one price
 * for all models, or a table «марка — модель — цена». What a client with a
 * model sees is the server's rule (`servicePriceForCar` of `@adclub/domain`,
 * the one the showcase takes): the preview shows it by the same function, and
 * a refusal of the server comes back to the row it is about.
 */

/** A chosen make or model: its id and its name. */
export interface Named {
  id: string;
  label: string;
}

/** A row of the table while it is filled in. */
export interface ModelRow {
  /** A key of the row on screen (rows come and go). */
  key: string;
  make: Named | null;
  model: Named | null;
  price: string;
  /** `false` — the model is in the archive (a saved row): its price stays, nobody sees it. */
  available: boolean;
}

export interface ServiceForm {
  mode: OfferPriceMode;
  price: string;
  rows: ModelRow[];
  warranty: WarrantyKind;
  warrantyMonths: string;
  warrantyText: string;
  supplierSku: string;
  supplierName: string;
}

let rowCounter = 0;

export function newModelRow(): ModelRow {
  rowCounter += 1;
  return { key: `row-${rowCounter}`, make: null, model: null, price: "", available: true };
}

export function newServiceForm(): ServiceForm {
  return {
    mode: "single",
    price: "",
    rows: [newModelRow()],
    warranty: "none",
    warrantyMonths: "",
    warrantyText: "",
    supplierSku: "",
    supplierName: "",
  };
}

export function serviceFormOf(offer: SupplierOffer): ServiceForm {
  const rows = offer.pricing.models.map((row) => ({
    ...newModelRow(),
    make: { id: row.make.id, label: row.make.name },
    model: { id: row.model.id, label: row.model.name },
    price: formatAmount(row.price),
    available: row.available,
  }));
  return {
    mode: offer.pricing.mode,
    price: offer.pricing.mode === "single" ? formatAmount(offer.price) : "",
    rows: rows.length > 0 ? rows : [newModelRow()],
    warranty:
      offer.warrantyMonths !== null ? "months" : offer.warrantyText !== null ? "text" : "none",
    warrantyMonths: offer.warrantyMonths === null ? "" : String(offer.warrantyMonths),
    warrantyText: offer.warrantyText ?? "",
    supplierSku: offer.supplierSku ?? "",
    supplierName: offer.supplierName ?? "",
  };
}

/** Where a problem of the form is shown: a field, a row's model or price, or the table. */
export type ServiceField =
  | "price"
  | "rows"
  | "warrantyMonths"
  | "warrantyText"
  | "supplierSku"
  | "supplierName"
  | { row: number; part: "model" | "price" };

export interface ServiceProblem {
  field: ServiceField | null;
  key: SupplierTextKey;
  params?: Record<string, string | number>;
  conflict?: boolean;
  link?: OfferProblem["link"];
}

/** The values of the form as the contract carries them. */
export interface ServiceValues {
  price?: number;
  modelPrices?: OfferModelPriceInput[];
  warrantyMonths: number | null;
  warrantyText: string | null;
  supplierSku: string | null;
  supplierName: string | null;
}

export type ServiceCheck =
  { ok: true; values: ServiceValues } | { ok: false; problem: ServiceProblem };

const text = (value: string) => value.trim().replace(/\s+/g, " ") || null;

/**
 * The form as values, or the first thing to fix: what can't even be sent
 * (a price that isn't a number, a row without a model, a model twice). The
 * bounds of the price and whether a model can still be chosen are the
 * server's, shown at the row on its answer.
 */
export function checkServiceForm(form: ServiceForm): ServiceCheck {
  const fail = (field: ServiceField, key: SupplierTextKey): ServiceCheck => ({
    ok: false,
    problem: { field, key },
  });
  let pricing: Pick<ServiceValues, "price" | "modelPrices">;
  if (form.mode === "single") {
    const price = parseAmount(form.price);
    if (price === null || price < 1) return fail("price", "offers.error.price");
    pricing = { price };
  } else {
    // Rows left completely empty are not rows: the button added one too many.
    const rows = form.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.model !== null || row.make !== null || row.price.trim() !== "");
    if (rows.length === 0) return fail("rows", "serviceForm.error.noRows");
    const seen = new Set<string>();
    const modelPrices: OfferModelPriceInput[] = [];
    for (const { row, index } of rows) {
      if (row.model === null) return fail({ row: index, part: "model" }, "serviceForm.error.model");
      if (seen.has(row.model.id)) {
        return fail({ row: index, part: "model" }, "serviceForm.error.duplicate");
      }
      seen.add(row.model.id);
      const price = parseAmount(row.price);
      if (price === null || price < 1) {
        return fail({ row: index, part: "price" }, "offers.error.price");
      }
      modelPrices.push({ modelId: row.model.id, price });
    }
    pricing = { modelPrices };
  }
  let warrantyMonths: number | null = null;
  if (form.warranty === "months") {
    warrantyMonths = parseAmount(form.warrantyMonths);
    if (warrantyMonths === null || warrantyMonths < 1) {
      return fail("warrantyMonths", "offers.error.warrantyMonths");
    }
  }
  const warrantyText = form.warranty === "text" ? text(form.warrantyText) : null;
  if (form.warranty === "text" && warrantyText === null) {
    return fail("warrantyText", "offers.error.warrantyText");
  }
  return {
    ok: true,
    values: {
      ...pricing,
      warrantyMonths,
      warrantyText,
      supplierSku: text(form.supplierSku),
      supplierName: text(form.supplierName),
    },
  };
}

/** The table of the form's rows that the server would number: the filled rows, in order. */
function filledRowIndexes(form: ServiceForm): number[] {
  return form.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.model !== null || row.make !== null || row.price.trim() !== "")
    .map(({ index }) => index);
}

const sameTable = (a: readonly OfferModelPriceInput[], b: readonly OfferModelPriceInput[]) => {
  const key = (rows: readonly OfferModelPriceInput[]) =>
    [...rows]
      .sort((x, y) => x.modelId.localeCompare(y.modelId))
      .map((row) => `${row.modelId}:${row.price}`)
      .join(",");
  return key(a) === key(b);
};

/**
 * What a save of the card sends: only what differs. The price — one price,
 * or the whole table of prices by model (the server takes it whole, with
 * the version).
 */
export function changedServiceValues(
  offer: SupplierOffer,
  values: ServiceValues,
): Partial<Omit<UpdateOfferBody, "expectedVersion">> {
  const changed: Partial<Omit<UpdateOfferBody, "expectedVersion">> = {};
  if (values.price !== undefined) {
    if (offer.pricing.mode !== "single" || offer.price !== values.price) {
      changed.price = values.price;
    }
  } else if (values.modelPrices !== undefined) {
    const current = offer.pricing.models.map((row) => ({
      modelId: row.model.id,
      price: row.price,
    }));
    if (offer.pricing.mode !== "by_model" || !sameTable(current, values.modelPrices)) {
      changed.modelPrices = values.modelPrices;
    }
  }
  for (const key of ["warrantyMonths", "warrantyText", "supplierSku", "supplierName"] as const) {
    if (values[key] !== offer[key]) changed[key] = values[key];
  }
  return changed;
}

/**
 * Where to show the server's refusal: a row of the table by the number
 * the server gave (`modelPrices.<i>.modelId` / `.price` — the i-th of the
 * rows sent), or what `offerProblem` says (the company's type among it).
 */
export function serviceProblem(error: unknown, form: ServiceForm): ServiceProblem {
  if (isApiError(error)) {
    if (error.code === "VALIDATION_ERROR" && Array.isArray(error.details)) {
      const issue = error.details[0] as {
        path?: unknown;
        message?: unknown;
        min?: unknown;
        max?: unknown;
      };
      const match =
        typeof issue?.path === "string"
          ? /^modelPrices\.(\d+)\.(modelId|price)$/.exec(issue.path)
          : null;
      if (match) {
        const row = filledRowIndexes(form)[Number(match[1])] ?? 0;
        if (match[2] === "price") {
          return typeof issue.min === "number" && typeof issue.max === "number"
            ? {
                field: { row, part: "price" },
                key: "offers.error.priceRange",
                params: { min: formatAmount(issue.min), max: formatAmount(issue.max) },
              }
            : { field: { row, part: "price" }, key: "offers.error.price" };
        }
        // The contract refuses a repeated model («already has a price in the
        // table»); the server — a model clients can't choose.
        return {
          field: { row, part: "model" },
          key: /already/i.test(String(issue.message ?? ""))
            ? "serviceForm.error.duplicate"
            : "serviceForm.error.modelUnavailable",
        };
      }
      if (issue?.path === "modelPrices") return { field: "rows", key: "serviceForm.error.noRows" };
    }
  }
  const found = offerProblem(error);
  const field: ServiceField | null =
    found.field === "price" && form.mode === "by_model"
      ? "rows"
      : found.field === "price" ||
          found.field === "warrantyMonths" ||
          found.field === "warrantyText" ||
          found.field === "supplierSku" ||
          found.field === "supplierName"
        ? found.field
        : null;
  return { ...found, field };
}

/** «от 8 000 ₸ · 2 модели» of an offer priced by model; «8 000 ₸» of one price. */
export function servicePriceLine(
  offer: Pick<SupplierOffer, "price" | "pricing">,
  lang: Lang,
  t: Translate,
): string {
  if (offer.pricing.mode === "single") return `${formatAmount(offer.price)} ₸`;
  const n = offer.pricing.models.length;
  const form = pluralForm(lang, n);
  const models = t(
    form === "one"
      ? "offers.models.one"
      : form === "few"
        ? "offers.models.few"
        : "offers.models.many",
    { n },
  );
  return `${t("offers.priceFrom", { price: formatAmount(offer.price) })} · ${models}`;
}

/**
 * «Клиент увидит» of the form (S-OFF-04): for each model of the table, the
 * price its owner sees — by `servicePriceForCar`, the showcase's own rule
 * (a model in the archive: nobody sees it); one price — for any model.
 */
export function servicePreview(form: ServiceForm, t: Translate): string[] {
  if (form.mode === "single") {
    const price = parseAmount(form.price);
    return price === null ? [] : [t("serviceForm.previewSingle", { price: formatAmount(price) })];
  }
  const rows = form.rows.filter((row) => row.model !== null && parseAmount(row.price) !== null);
  const pricing: ServicePricing = {
    mode: "by_model",
    prices: rows.map((row) => ({
      modelId: row.model!.id,
      price: parseAmount(row.price)!,
      available: row.available,
    })),
  };
  const lines = rows.map((row) => {
    const model = [row.make?.label, row.model!.label].filter(Boolean).join(" ");
    const price = servicePriceForCar(pricing, { modelId: row.model!.id });
    return price === null
      ? t("serviceForm.previewHidden", { model })
      : t("serviceForm.previewModel", { model, price: formatAmount(price) });
  });
  return lines.length === 0 ? [] : [...lines, t("serviceForm.previewOthers")];
}

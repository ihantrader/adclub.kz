import { isApiError } from "@adclub/api-client";
import {
  COMPATIBILITY_EVIDENCE_MAX_LENGTH,
  type CreateCompatibilityProposalBody,
  type OfferItem,
} from "@adclub/contracts";
import type { Translate } from "../translate";

/**
 * S-OFF-07 «Данные о совместимости» (TASK-077; SCREENS 6.4): a car from the
 * vehicle catalog — the make required, the model, the generation, the
 * engine and the years as precise as known — and where it comes from. What
 * is consistent, already approved or over the daily limit is the server's
 * to say; its refusals come back to the field they are about.
 */
export { COMPATIBILITY_EVIDENCE_MAX_LENGTH };

export interface Named {
  id: string;
  label: string;
}

export interface ProposalForm {
  make: Named | null;
  model: Named | null;
  generation: Named | null;
  engine: Named | null;
  yearFrom: string;
  yearTo: string;
  evidence: string;
}

export type ProposalField =
  "make" | "model" | "generation" | "engine" | "yearFrom" | "yearTo" | "evidence";

export type ProposalErrors = Partial<Record<ProposalField, string>>;

export const emptyProposalForm: ProposalForm = {
  make: null,
  model: null,
  generation: null,
  engine: null,
  yearFrom: "",
  yearTo: "",
  evidence: "",
};

/** Compatibility is kept for parts and products; a service is done on any car of its model. */
export function proposesCompatibility(item: Pick<OfferItem, "type" | "status">): boolean {
  return item.type !== "service" && item.status === "active";
}

/** A changed level clears the levels under it: they were of the previous one. */
export function chooseLevel(
  form: ProposalForm,
  level: "make" | "model" | "generation" | "engine",
  value: Named | null,
): ProposalForm {
  switch (level) {
    case "make":
      return value?.id === form.make?.id
        ? form
        : { ...form, make: value, model: null, generation: null, engine: null };
    case "model":
      return value?.id === form.model?.id
        ? form
        : { ...form, model: value, generation: null, engine: null };
    case "generation":
      return value?.id === form.generation?.id
        ? form
        : { ...form, generation: value, engine: null };
    case "engine":
      return { ...form, engine: value };
  }
}

const YEAR = /^\d{4}$/;

function year(text: string): number | null | "invalid" {
  const value = text.trim();
  if (value === "") return null;
  return YEAR.test(value) ? Number(value) : "invalid";
}

export function proposalErrors(form: ProposalForm, t: Translate): ProposalErrors {
  const errors: ProposalErrors = {};
  if (!form.make) errors.make = t("compat.error.make");
  const from = year(form.yearFrom);
  const to = year(form.yearTo);
  if (from === "invalid") errors.yearFrom = t("compat.error.year");
  if (to === "invalid") errors.yearTo = t("compat.error.year");
  if (typeof from === "number" && typeof to === "number" && to < from) {
    errors.yearTo = t("compat.error.yearsOrder");
  }
  if (form.evidence.trim() === "") errors.evidence = t("compat.error.evidence");
  return errors;
}

/** The body of `POST /supplier/catalog/items/{itemId}/compatibility-proposals`, or `null`. */
export function proposalBody(form: ProposalForm): CreateCompatibilityProposalBody | null {
  const from = year(form.yearFrom);
  const to = year(form.yearTo);
  const evidence = form.evidence.trim();
  if (!form.make || from === "invalid" || to === "invalid" || evidence === "") return null;
  if (from !== null && to !== null && to < from) return null;
  return {
    conditions: {
      makeId: form.make.id,
      modelId: form.model?.id ?? null,
      generationId: form.generation?.id ?? null,
      engineId: form.engine?.id ?? null,
      yearFrom: from,
      yearTo: to,
    },
    evidence,
  };
}

const FIELD_OF: Record<string, ProposalField> = {
  makeId: "make",
  modelId: "model",
  generationId: "generation",
  engineId: "engine",
  yearFrom: "yearFrom",
  yearTo: "yearTo",
  evidence: "evidence",
};

function detail(details: unknown, key: string): unknown {
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)[key]
    : undefined;
}

/** A refusal of the server: under the field it is about, or above the button. */
export function proposalRefusal(
  error: unknown,
  t: Translate,
): { fields: ProposalErrors; text: string | null } {
  if (!isApiError(error)) return { fields: {}, text: t("common.saveFailed") };
  switch (error.code) {
    case "NETWORK_ERROR":
      return { fields: {}, text: t("common.saveOffline") };
    case "COMPATIBILITY_CONDITIONS_INVALID": {
      const field = FIELD_OF[String(detail(error.details, "field") ?? "")] ?? "make";
      const reason = String(detail(error.details, "reason") ?? "");
      const text =
        reason === "model_of_other_make"
          ? t("compat.error.modelOfOtherMake")
          : reason === "generation_of_other_model"
            ? t("compat.error.generationOfOtherModel")
            : reason === "years_order"
              ? t("compat.error.yearsOrder")
              : reason === "years_outside_generation"
                ? t("compat.error.yearsOutside")
                : t("compat.error.notFound");
      return { fields: { [field]: text }, text: null };
    }
    case "COMPATIBILITY_DUPLICATE":
      return { fields: {}, text: t("compat.error.alreadyApproved") };
    case "COMPATIBILITY_PROPOSAL_DUPLICATE":
      return { fields: {}, text: t("compat.error.alreadyWaiting") };
    case "COMPATIBILITY_NOT_APPLICABLE":
      return { fields: {}, text: t("compat.error.notApplicable") };
    case "NOT_FOUND":
      return { fields: {}, text: t("compat.error.itemGone") };
    case "RATE_LIMITED": {
      const seconds = Number(detail(error.details, "retryAfterSeconds") ?? 60);
      const minutes = Math.max(1, Math.ceil((Number.isFinite(seconds) ? seconds : 60) / 60));
      return { fields: {}, text: t("compat.error.tooMany", { minutes }) };
    }
    case "VALIDATION_ERROR": {
      const fields: ProposalErrors = {};
      const details = Array.isArray(error.details) ? (error.details as { path?: unknown }[]) : [];
      for (const entry of details) {
        const path = String(entry.path ?? "").split(".");
        const field = FIELD_OF[path.at(-1) ?? ""];
        if (field)
          fields[field] =
            field === "evidence" ? t("compat.error.evidence") : t("compat.error.year");
      }
      return Object.keys(fields).length > 0
        ? { fields, text: null }
        : { fields: {}, text: t("common.saveFailed") };
    }
    default:
      return { fields: {}, text: t("common.saveFailed") };
  }
}

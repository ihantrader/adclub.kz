import { isApiError } from "@adclub/api-client";
import type { SubmitSupplierLeadBody, SupplierType } from "@adclub/contracts";
import { checkKzBin, normalizeKzMobilePhone } from "@adclub/domain";
import type { Translate } from "../translate";

/**
 * The rules of S-PUB-01 «Заявка на подключение» (TASK-077; SCREENS 6.1):
 * what the form checks before sending — the БИН's check digit, the mobile
 * number, the fields that must be there — and how the server's refusals
 * read. The server decides everything again: a known БИН gets the same
 * answer as a new one, the hidden field drops a robot's request.
 */
export interface JoinForm {
  companyName: string;
  bin: string;
  cityId: string;
  goods: boolean;
  services: boolean;
  contactName: string;
  phone: string;
  consent: boolean;
  /** The field people never see (`website`): a robot fills it. */
  website: string;
}

export type JoinField =
  "companyName" | "bin" | "cityId" | "type" | "contactName" | "phone" | "consent";

export type JoinErrors = Partial<Record<JoinField, string>>;

export const emptyJoinForm: JoinForm = {
  companyName: "",
  bin: "",
  cityId: "",
  goods: false,
  services: false,
  contactName: "",
  phone: "+7",
  consent: false,
  website: "",
};

export function supplierTypeOf(form: Pick<JoinForm, "goods" | "services">): SupplierType | null {
  if (form.goods && form.services) return "both";
  if (form.goods) return "goods";
  if (form.services) return "services";
  return null;
}

/** What is wrong with the form before it is sent; empty — it can go. */
export function joinErrors(form: JoinForm, t: Translate): JoinErrors {
  const errors: JoinErrors = {};
  if (form.companyName.trim() === "") errors.companyName = t("join.error.companyName");
  const bin = checkKzBin(form.bin);
  if (!bin.ok)
    errors.bin = t(bin.reason === "format" ? "join.error.binFormat" : "join.error.binChecksum");
  if (form.cityId === "") errors.cityId = t("join.error.city");
  if (supplierTypeOf(form) === null) errors.type = t("join.error.type");
  if (form.contactName.trim() === "") errors.contactName = t("join.error.contactName");
  if (normalizeKzMobilePhone(form.phone) === null) errors.phone = t("join.error.phone");
  if (!form.consent) errors.consent = t("join.error.consent");
  return errors;
}

/** The body of `POST /supplier-leads`, or `null` while the form has errors. */
export function joinBody(form: JoinForm, lang: "kk" | "ru"): SubmitSupplierLeadBody | null {
  const bin = checkKzBin(form.bin);
  const phone = normalizeKzMobilePhone(form.phone);
  const type = supplierTypeOf(form);
  if (
    !bin.ok ||
    !phone ||
    !type ||
    !form.consent ||
    form.cityId === "" ||
    form.companyName.trim() === "" ||
    form.contactName.trim() === ""
  ) {
    return null;
  }
  return {
    companyName: form.companyName.trim(),
    bin: bin.bin,
    cityId: form.cityId,
    type,
    contactName: form.contactName.trim(),
    phone,
    consent: true,
    language: lang,
    ...(form.website !== "" && { website: form.website }),
  };
}

const FIELD_OF: Record<string, JoinField> = {
  companyName: "companyName",
  bin: "bin",
  cityId: "cityId",
  type: "type",
  contactName: "contactName",
  phone: "phone",
  consent: "consent",
};

/** A refusal of the server: under its field, or above the button. */
export function joinRefusal(
  error: unknown,
  t: Translate,
): { fields: JoinErrors; text: string | null } {
  if (!isApiError(error)) return { fields: {}, text: t("join.error.failed") };
  switch (error.code) {
    case "NETWORK_ERROR":
      return { fields: {}, text: t("join.error.network") };
    case "RATE_LIMITED": {
      const details = error.details as { retryAfterSeconds?: unknown } | undefined;
      const seconds = Number(details?.retryAfterSeconds ?? 60);
      const minutes = Math.max(1, Math.ceil((Number.isFinite(seconds) ? seconds : 60) / 60));
      return { fields: {}, text: t("join.error.tooMany", { minutes }) };
    }
    case "SERVICE_UNAVAILABLE":
      return { fields: {}, text: t("join.error.unavailable") };
    case "VALIDATION_ERROR": {
      const fields: JoinErrors = {};
      const details = Array.isArray(error.details) ? (error.details as { path?: unknown }[]) : [];
      for (const detail of details) {
        const field = FIELD_OF[String(detail.path ?? "").split(".")[0] ?? ""];
        if (!field) continue;
        fields[field] =
          field === "bin"
            ? t("join.error.binChecksum")
            : field === "phone"
              ? t("join.error.phone")
              : field === "cityId"
                ? t("join.error.city")
                : t("join.error.field");
      }
      return Object.keys(fields).length > 0
        ? { fields, text: null }
        : { fields: {}, text: t("join.error.failed") };
    }
    default:
      return { fields: {}, text: t("join.error.failed") };
  }
}

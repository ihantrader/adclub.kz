import type {
  TranslationEntityType,
  TranslationField,
  TranslationQueueItem,
  TranslationQueueState,
  TranslationTargetLanguage,
} from "@adclub/contracts";
import { catalogItemPath, maintenancePlanPath, routePaths, withQuery } from "../router";
import { TRANSLATION_FAILURE_TEXT } from "./catalog-words";

/**
 * The words and links of «Справочник → Переводы» (TASK-054; SCREENS
 * A-CAT-05): what the server's queue says, read by a person — the reason of
 * a refusal, the kind of the object, where the object is.
 */

/** The tabs in the order of the page; «Отказано» opens first. */
export const TRANSLATION_STATES: readonly { value: TranslationQueueState; label: string }[] = [
  { value: "failed", label: "Отказано" },
  { value: "outdated", label: "Устарело" },
  { value: "queued", label: "Ждёт" },
  { value: "missing", label: "Нет перевода" },
];

/** The kinds of text the filter offers (the plan elements are listed with all, not filtered). */
export const TRANSLATION_KINDS: readonly { value: TranslationEntityType; label: string }[] = [
  { value: "category", label: "Категория" },
  { value: "attribute", label: "Характеристика" },
  { value: "attribute_option", label: "Вариант списка" },
  { value: "catalog_item", label: "Позиция" },
];

const KIND_TEXT: Record<TranslationEntityType, string> = {
  category: "Категория",
  attribute: "Характеристика",
  attribute_option: "Вариант списка",
  catalog_item: "Позиция",
  maintenance_plan_item: "Элемент регламента ТО",
};

export const TRANSLATION_LANGUAGES: readonly { value: TranslationTargetLanguage; label: string }[] =
  [
    { value: "kk", label: "Казахский" },
    { value: "en", label: "Английский" },
  ];

const FIELD_TEXT: Record<TranslationField, string> = { name: "название", unit: "единица" };

/** «Позиция · название», «Характеристика · единица». */
export function translationKindText(item: Pick<TranslationQueueItem, "entityType" | "field">) {
  return `${KIND_TEXT[item.entityType]} · ${FIELD_TEXT[item.field]}`;
}

export function languageText(lang: TranslationTargetLanguage): string {
  return lang === "kk" ? "Казахский" : "Английский";
}

/**
 * The temporary reasons of a waiting translation, as the server names them
 * (`lastError`); an unknown one is shown as it is, never hidden.
 */
const LAST_ERROR_TEXT: Record<string, string> = {
  unavailable: "провайдер ИИ недоступен",
  model_unavailable: "модель недоступна",
  no_private_provider: "нет провайдера без хранения запросов",
  rejected: "провайдер отказал",
  invalid_output: "ответ ИИ не по форме",
  not_configured: "ИИ не настроен",
  incomplete_answer: "ИИ ответил не про все тексты",
};

export function lastErrorText(code: string): string {
  return LAST_ERROR_TEXT[code] ?? code;
}

/**
 * Why the row is in its tab, in words: the reason of a refusal, the
 * temporary failure of a waiting one, «русский текст изменился» for an
 * outdated one; `null` — nothing to say (a missing one).
 */
export function reasonText(item: TranslationQueueItem): string | null {
  switch (item.state) {
    case "failed":
      return item.failure ? TRANSLATION_FAILURE_TEXT[item.failure] : "причина не указана";
    case "queued":
      return item.lastError
        ? `${lastErrorText(item.lastError)}${item.attempts > 0 ? ` · неудачных попыток: ${item.attempts}` : ""}`
        : null;
    case "outdated":
      return "русский текст изменился после перевода";
    case "missing":
      return null;
  }
}

/**
 * Where the object of a row is: an item — its tab «Переводы»; a category,
 * an attribute, an option — the tree with it selected (the tree finds an
 * attribute's and an option's place through `GET /admin/catalog/locate`);
 * a plan element — its plan.
 */
export function objectLink(item: TranslationQueueItem): string | null {
  switch (item.entityType) {
    case "catalog_item":
      return catalogItemPath(item.entityId, "translations");
    case "category":
      return withQuery(routePaths.catalog, { node: item.entityId });
    case "attribute":
      return withQuery(routePaths.catalog, { attribute: item.entityId });
    case "attribute_option":
      return withQuery(routePaths.catalog, { option: item.entityId });
    case "maintenance_plan_item":
      return item.parentId ? maintenancePlanPath(item.parentId) : null;
  }
}

/** The actions of a row: the same routes as the tab «Переводы» of an item. */
export function rowActions(item: TranslationQueueItem): {
  edit: true;
  retranslate: boolean;
  keep: boolean;
  release: boolean;
} {
  const manual = item.currentOrigin === "manual";
  return {
    edit: true,
    // The server refuses it for a text written by hand; a waiting one is already on its way.
    retranslate: !manual && item.state !== "queued",
    // «Оставить как есть»: the administrator looked at a manual text and keeps it.
    keep: manual && item.state === "outdated" && item.currentText !== null,
    release: manual,
  };
}

/** The filters of the page in its address, under the server's names. */
export interface TranslationFilters {
  state: TranslationQueueState;
  entityType?: TranslationEntityType;
  lang?: TranslationTargetLanguage;
}

export function translationFiltersOf(query: URLSearchParams): TranslationFilters {
  const state = TRANSLATION_STATES.find((entry) => entry.value === query.get("state"))?.value;
  const entityType = TRANSLATION_KINDS.find(
    (entry) => entry.value === query.get("entityType"),
  )?.value;
  const lang = TRANSLATION_LANGUAGES.find((entry) => entry.value === query.get("lang"))?.value;
  return { state: state ?? "failed", entityType, lang };
}

export function translationsLink(filters: Partial<TranslationFilters> = {}): string {
  return withQuery(routePaths.catalogTranslations, {
    state: filters.state && filters.state !== "failed" ? filters.state : null,
    entityType: filters.entityType,
    lang: filters.lang,
  });
}

/** «12 переводов» — the number of the mass action and its confirmation. */
export function translationsCount(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "перевод"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "перевода"
        : "переводов";
  return `${n.toLocaleString("ru-RU")} ${word}`;
}

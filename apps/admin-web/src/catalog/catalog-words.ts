import { isApiError } from "@adclub/api-client";
import type {
  AttributeValueType,
  CatalogItemStatus,
  CatalogItemType,
  CategoryStatus,
  CompatibilityLevel,
  CompatibilityResult,
  ItemPhotoSourceType,
  ItemPhotoStatus,
  OfferHiddenReasonValue,
  TranslationFailure,
} from "@adclub/contracts";
import { actionErrorText } from "../errors";

/**
 * The words of the catalog section (TASK-035; SCREENS 7.0, 7.2): states,
 * types and the server's refusals in plain Russian — at the field they are
 * about where there is one. Nothing here decides anything.
 */

export const CATEGORY_STATUS_TEXT: Record<CategoryStatus, string> = {
  active: "Активна",
  hidden: "Скрыта",
  archived: "В архиве",
};

export const ITEM_STATUS_TEXT: Record<CatalogItemStatus, string> = {
  draft: "Черновик",
  active: "Активна",
  archived: "В архиве",
};

export const ITEM_TYPE_TEXT: Record<CatalogItemType, string> = {
  part: "Запчасть",
  generic: "Товар по характеристикам",
  service: "Услуга",
};

export const VALUE_TYPE_TEXT: Record<AttributeValueType, string> = {
  number: "Число",
  enum: "Список",
  bool: "Да / нет",
  text: "Текст",
};

export const PHOTO_STATUS_TEXT: Record<ItemPhotoStatus, string> = {
  proposed: "Предложено",
  approved: "Подтверждено",
  rejected: "Отклонено",
  deleted: "Удалено",
};

export const PHOTO_SOURCE_TEXT: Record<ItemPhotoSourceType, string> = {
  admin_upload: "Свой файл",
  manufacturer: "Сайт производителя",
  official_catalog: "Официальный каталог",
  multi_store: "Интернет-магазин",
  supplier_photo: "Фото поставщика",
};

/** Sources found on the internet: the server asks for the page they come from. */
export const PHOTO_SOURCES_WITH_URL: readonly ItemPhotoSourceType[] = [
  "manufacturer",
  "official_catalog",
  "multi_store",
];

export const COMPATIBILITY_RESULT_TEXT: Record<CompatibilityResult, string> = {
  fits: "Подходит",
  needs_details: "Уточните параметр",
  does_not_fit: "Не подходит",
  not_specified: "Совместимость не указана",
};

export const COMPATIBILITY_LEVEL_TEXT: Record<CompatibilityLevel, string> = {
  make: "марка",
  model: "модель",
  generation: "поколение",
  body: "кузов",
  engine: "двигатель",
  transmission: "КПП",
  drive: "привод",
  year: "год",
};

export const TRANSLATION_FAILURE_TEXT: Record<TranslationFailure, string> = {
  empty: "пустой перевод",
  too_long: "длиннее допустимого",
  control_characters: "служебные символы в тексте",
  wrong_language: "не на том языке",
  name_taken: "такое название уже у соседа",
};

export const SHOWCASE_REASON_TEXT: Record<OfferHiddenReasonValue, string> = {
  offer_withdrawn: "снято с продажи",
  offer_suspended: "приостановлено",
  supplier_blocked: "компания заблокирована",
  supplier_paused: "компания на паузе",
  item_unavailable: "позиция недоступна",
  category_hidden: "категория скрыта",
  no_city: "у точки не указан город",
  hours_not_set: "у точки нет часов работы",
  no_working_day: "нет рабочих дней на ближайшее время",
};

export function showcaseReasonText(reason: string): string {
  return (SHOWCASE_REASON_TEXT as Record<string, string | undefined>)[reason] ?? reason;
}

const LANGUAGE_TEXT: Record<string, string> = { kk: "казахское", ru: "русское", en: "английское" };

function detail<T>(error: unknown, key: string): T | undefined {
  if (!isApiError(error)) return undefined;
  const details = error.details;
  return typeof details === "object" && details !== null && key in details
    ? ((details as Record<string, unknown>)[key] as T)
    : undefined;
}

/** «Эти данные только что изменил {кто}. Обновите страницу» (SCREENS 7.0). */
export function conflictText(who: string | null): string {
  return `Эти данные только что изменил ${who ?? "другой администратор"}. Обновите страницу`;
}

/** Whether a refusal is a colleague's change meanwhile (a version or an order). */
export function isConflict(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return [
    "CATALOG_VERSION_CONFLICT",
    "CATALOG_ORDER_CONFLICT",
    "CATALOG_ORDER_MISMATCH",
    "COMPATIBILITY_VERSION_CONFLICT",
    "COMPATIBILITY_PROPOSAL_STATE",
  ].includes(error.code);
}

/** The field a refusal is about, when the server names one. */
export function errorField(error: unknown): string | null {
  if (!isApiError(error)) return null;
  if (error.code === "VALIDATION_ERROR" && Array.isArray(error.details)) {
    const first = error.details[0] as { path?: unknown } | undefined;
    if (first && Array.isArray(first.path) && first.path.length > 0) {
      return first.path.map(String).join(".");
    }
  }
  if (error.code === "CATALOG_NAME_TAKEN") {
    const lang = detail<string>(error, "lang");
    return lang ? `names.${lang}` : "names";
  }
  if (error.code === "CATALOG_CODE_TAKEN") return "code";
  if (error.code === "COMPATIBILITY_CONDITIONS_INVALID") {
    return detail<string>(error, "field") ?? null;
  }
  return null;
}

const PHOTO_INVALID_TEXT: Record<string, string> = {
  empty: "Файл пустой",
  not_an_image: "Это не изображение",
  unsupported_format: "Формат не поддерживается — нужен JPEG, PNG или WebP",
  broken: "Файл повреждён",
  too_many_pixels: "Слишком большое разрешение",
  source_url_required: "Для фото из интернета укажите ссылку на страницу-источник",
  too_many_photos: "У позиции уже максимум фото",
};

/** A refusal of the catalog section in words. */
export function catalogErrorText(error: unknown): string {
  if (!isApiError(error)) return actionErrorText(error);
  switch (error.code) {
    case "CATALOG_NAME_TAKEN": {
      const lang = detail<string>(error, "lang");
      return `Такое ${lang ? (LANGUAGE_TEXT[lang] ?? "") : ""} название уже есть у соседнего узла`.replace(
        /\s+/g,
        " ",
      );
    }
    case "CATALOG_CODE_TAKEN":
      return "Такой код уже занят";
    case "CATALOG_DEPTH_EXCEEDED":
      return "В дереве только два уровня: узел и подкатегория";
    case "CATALOG_KIND_MISMATCH":
      return "Товары и услуги не смешиваются: выберите узел того же вида";
    case "CATALOG_LEVEL_IMMUTABLE":
      return "Узел не может стать подкатегорией, и наоборот";
    case "CATALOG_PARENT_ARCHIVED":
      return "Родительский узел в архиве";
    case "CATALOG_CATEGORY_ARCHIVED":
      return "Категория в архиве";
    case "CATALOG_NOT_SUBCATEGORY":
      return "Позиции и характеристики бывают только у подкатегории";
    case "CATALOG_ATTRIBUTE_TYPE_IMMUTABLE":
      return "Тип характеристики не меняется: уберите её в архив и создайте новую";
    case "CATALOG_BRAND_ARCHIVED":
      return "Бренд в архиве";
    case "CATALOG_BRAND_SPELLING_TAKEN":
      return "Такое написание уже есть у другого бренда";
    case "CATALOG_ITEM_DUPLICATE":
      return "Такая позиция уже есть";
    case "CATALOG_ITEM_TYPE_IMMUTABLE":
      return "Тип позиции не меняется";
    case "CATALOG_ITEM_HAS_ANALOGS":
      return "У позиции есть аналоги: сначала уберите связи";
    case "CATALOG_ANALOG_INVALID": {
      const reason = detail<string>(error, "reason");
      if (reason === "self") return "Позиция не может быть аналогом самой себя";
      if (reason === "not_part") return "Аналогами бывают только запчасти";
      if (reason === "other_category") return "Аналог должен быть из той же подкатегории";
      if (reason === "archived") return "Позиция в архиве";
      return "Эти позиции нельзя связать";
    }
    case "CATALOG_VALUES_REJECTED":
      return "Часть значений не принята — ошибки у ячеек";
    case "CATALOG_PHOTO_INVALID": {
      const reason = detail<string>(error, "reason") ?? "";
      return PHOTO_INVALID_TEXT[reason] ?? "Файл не принят";
    }
    case "CATALOG_PHOTO_FILES_DELETED":
      return "Файлы этого фото уже удалены — вернуть его нельзя";
    case "CATALOG_PHOTO_NOT_APPROVED":
      return "Порядок задаётся только подтверждённым фото";
    case "PAYLOAD_TOO_LARGE":
      return "Файл слишком большой";
    case "UNSUPPORTED_MEDIA_TYPE":
      return "Формат не поддерживается — нужен JPEG, PNG или WebP";
    case "SERVICE_UNAVAILABLE":
      return "Хранилище недоступно, попробуйте позже";
    case "COMPATIBILITY_CONDITIONS_INVALID": {
      const reason = detail<string>(error, "reason");
      if (reason === "model_of_other_make") return "Модель другой марки";
      if (reason === "generation_of_other_model") return "Поколение другой модели";
      if (reason === "years_order") return "Год «с» позже года «по»";
      if (reason === "years_outside_generation") return "Годы вне лет поколения";
      return "Такого значения нет в справочнике автомобилей";
    }
    case "COMPATIBILITY_VEHICLE_INVALID":
      return "Автомобиль указан несогласованно: проверьте уровни";
    case "COMPATIBILITY_DUPLICATE":
      return "Такая запись уже подтверждена";
    case "COMPATIBILITY_NOT_APPLICABLE":
      return "У услуг совместимости нет";
    case "COMPATIBILITY_NOT_ANALOG":
      return "Копировать можно только с аналога";
    case "COMPATIBILITY_ITEM_ARCHIVED":
      return "Позиция в архиве";
    case "COMPATIBILITY_PROPOSAL_STATE":
      return "Предложение уже рассмотрено. Обновите страницу";
    case "TRANSLATION_MANUALLY_EDITED":
      return "Текст исправлен вручную: сначала снимите ручную правку";
    case "TRANSLATION_NOT_MANUAL":
      return "Этот перевод не исправлялся вручную";
    default:
      return actionErrorText(error);
  }
}

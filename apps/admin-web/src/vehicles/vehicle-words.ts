import { isApiError } from "@adclub/api-client";
import type {
  AdminVehicleImport,
  VehicleEntity,
  VehicleEntryStatus,
  VehicleImportColumn,
  VehicleImportFileInvalidDetails,
  VehicleImportPlan,
  VehicleImportReason,
  VehicleImportStatus,
  VehicleOptionKind,
  VehicleParentRef,
  VehicleYearsInvalidDetails,
} from "@adclub/contracts";
import { VEHICLE_IMPORT_CONTENT_TYPES } from "@adclub/contracts";
import { actionErrorText, validationText } from "../errors";
import { vehicleGenerationPath, vehicleMakePath, vehicleModelPath, withQuery } from "../router";

/**
 * The words of «Автомобили» (TASK-035.B; SCREENS A-CAR-01, A-CAR-02): what
 * the server's answers mean in plain Russian. Nothing here decides anything
 * — uniqueness, years, archived parents and the import file are the
 * server's (ARCHITECTURE 4.24).
 */

export const OPTION_KIND_TEXT: Record<VehicleOptionKind, string> = {
  body: "Кузов",
  transmission: "КПП",
  drive: "Привод",
  fuel: "Топливо",
};

export const STATUS_TEXT: Record<VehicleEntryStatus, string> = {
  active: "Активна",
  archived: "В архиве",
};

/** «2019–н.в.», «2016–2022». */
export function yearsText(yearFrom: number, yearTo: number | null): string {
  return `${yearFrom}–${yearTo ?? "н.в."}`;
}

/** «моделей: 6» and the like, in the right form of the word. */
export function countText(count: number, forms: readonly [string, string, string]): string {
  const tens = count % 100;
  const ones = count % 10;
  const form =
    tens >= 11 && tens <= 14
      ? forms[2]
      : ones === 1
        ? forms[0]
        : ones >= 2 && ones <= 4
          ? forms[1]
          : forms[2];
  return `${count.toLocaleString("ru-RU")} ${form}`;
}

export const MODELS = ["модель", "модели", "моделей"] as const;
export const GENERATIONS = ["поколение", "поколения", "поколений"] as const;
export const MODIFICATIONS = ["модификация", "модификации", "модификаций"] as const;
export const ROWS = ["строка", "строки", "строк"] as const;

// ------------------------------------------------------------ server errors

/** What a failed change says, and at which field of the form. */
export interface VehicleErrorView {
  text: string;
  /** The field of the form the error belongs to; `null` — the form as a whole. */
  field: string | null;
  /** «Открыть» — the record that already has this name. */
  link: { href: string; label: string } | null;
  /** `VEHICLE_VERSION_CONFLICT`: the version stored now. */
  currentVersion: number | null;
  /** `VEHICLE_DUPLICATE`: the record that exists — «Выбрать существующий» in a nested form. */
  existingId?: string | null;
}

const DUPLICATE_TEXT: Record<VehicleEntity, string> = {
  make: "Такая марка уже есть",
  model: "Такая модель у этой марки уже есть",
  generation: "Такое поколение у этой модели уже есть",
  engine: "Такой двигатель уже есть",
  option: "Такое значение в этом списке уже есть",
  modification: "Такая модификация у этого поколения уже есть (возможно, в архиве)",
};

const DUPLICATE_FIELD: Record<VehicleEntity, string | null> = {
  make: "name",
  model: "name",
  generation: "name",
  engine: "code",
  option: "names",
  modification: null,
};

/** Where «Открыть» leads for a record that already exists. */
export function duplicateHref(
  entity: VehicleEntity,
  existingId: string,
  context: { spelling?: string | null; kind?: VehicleOptionKind; generationId?: string },
): string | null {
  switch (entity) {
    case "make":
      return vehicleMakePath(existingId);
    case "model":
      return vehicleModelPath(existingId);
    case "generation":
      return vehicleGenerationPath(existingId);
    case "engine":
      return withQuery("/vehicles/engines", { q: context.spelling ?? undefined });
    case "option":
      return withQuery("/vehicles/options", { kind: context.kind, highlight: existingId });
    case "modification":
      return context.generationId ? vehicleGenerationPath(context.generationId, existingId) : null;
  }
}

/** The make, model or generation above a record that is archived — the one to restore first. */
export function archivedParent(parents: {
  make?: VehicleParentRef;
  model?: VehicleParentRef;
  generation?: VehicleParentRef;
}): { kind: "make" | "model" | "generation"; name: string } | null {
  // The topmost one: what is under an archived make can't come back before the make.
  if (parents.make?.status === "archived") return { kind: "make", name: parents.make.name };
  if (parents.model?.status === "archived") return { kind: "model", name: parents.model.name };
  if (parents.generation?.status === "archived") {
    return { kind: "generation", name: parents.generation.name };
  }
  return null;
}

const PARENT_WORD = { make: "марку", model: "модель", generation: "поколение" } as const;

function detail<T>(error: unknown, key: string): T | undefined {
  if (!isApiError(error)) return undefined;
  const details = error.details;
  return typeof details === "object" && details !== null && key in details
    ? ((details as Record<string, unknown>)[key] as T)
    : undefined;
}

function yearsError(details: Partial<VehicleYearsInvalidDetails>): { text: string; field: string } {
  switch (details.reason) {
    case "order":
      return { text: "Год «по» раньше года «с»", field: "yearTo" };
    case "outside_generation": {
      const years = details.generationYears;
      return {
        text: years
          ? `Годы модификации должны быть в пределах лет поколения: ${yearsText(years.from, years.to)}`
          : "Годы модификации должны быть в пределах лет поколения",
        field: "yearFrom",
      };
    }
    default:
      return {
        text: `В новые годы не попадают модификации поколения (${details.modificationIds?.length ?? 0}). Сначала измените их годы`,
        field: "yearFrom",
      };
  }
}

/**
 * A refused change of the vehicle catalog in words, at its field
 * (SCREENS 7.0, TASK-035.B): a duplicate with «Открыть», years outside the
 * generation, an archived parent («Сначала восстановите марку «Geely»»),
 * an archived engine or option, a colleague's change (the version — for
 * «Обновить данные»; who it was is added by the screen from the journal).
 */
export function vehicleErrorView(
  error: unknown,
  context: {
    parents?: Parameters<typeof archivedParent>[0];
    kind?: VehicleOptionKind;
    generationId?: string;
  } = {},
): VehicleErrorView {
  const view = (text: string, field: string | null = null): VehicleErrorView => ({
    text,
    field,
    link: null,
    currentVersion: null,
  });
  if (!isApiError(error)) return view(actionErrorText(error));
  switch (error.code) {
    case "VEHICLE_DUPLICATE": {
      const entity = detail<VehicleEntity>(error, "entity") ?? "make";
      const existingId = detail<string>(error, "existingId");
      const spelling = detail<string | null>(error, "spelling") ?? null;
      const href = existingId
        ? duplicateHref(entity, existingId, {
            spelling,
            kind: context.kind,
            generationId: context.generationId,
          })
        : null;
      const text =
        spelling && entity !== "modification"
          ? `«${spelling}» уже занято. ${DUPLICATE_TEXT[entity]}`
          : DUPLICATE_TEXT[entity];
      return {
        text,
        field: DUPLICATE_FIELD[entity],
        link: href ? { href, label: "Открыть" } : null,
        currentVersion: null,
        existingId: existingId ?? null,
      };
    }
    case "VEHICLE_YEARS_INVALID": {
      const years = yearsError({
        reason: detail(error, "reason"),
        generationYears: detail(error, "generationYears"),
        modificationIds: detail(error, "modificationIds"),
      });
      return view(years.text, years.field);
    }
    case "VEHICLE_PARENT_ARCHIVED": {
      const parent = context.parents ? archivedParent(context.parents) : null;
      return view(
        parent
          ? `Сначала восстановите ${PARENT_WORD[parent.kind]} «${parent.name}»`
          : "То, что выше в справочнике, в архиве — сначала восстановите его",
      );
    }
    case "VEHICLE_REFERENCE_ARCHIVED":
      return view(
        "Это значение в архиве — выберите другое или сначала восстановите его",
        detail<string>(error, "field") ?? null,
      );
    case "VEHICLE_VERSION_CONFLICT":
    case "VEHICLE_ORDER_CONFLICT":
      return {
        ...view(conflictText(null)),
        currentVersion: detail<number>(error, "currentVersion") ?? null,
      };
    case "VALIDATION_ERROR": {
      const details = error.details;
      const path =
        Array.isArray(details) && typeof (details[0] as { path?: unknown })?.path === "string"
          ? ((details[0] as { path: string }).path.split(".")[0] ?? null)
          : null;
      // A year later than the current one (D-071): the lists don't offer it,
      // but a list drawn before New Year's midnight can still send it.
      if ((path === "yearFrom" || path === "yearTo") && /current year/.test(error.message)) {
        return view("Год выпуска не может быть позже текущего — обновите страницу", path);
      }
      return view(validationText(error) ?? "Проверьте введённое", path);
    }
    case "NOT_FOUND":
      return view("Запись не найдена — обновите страницу");
    default:
      return view(actionErrorText(error));
  }
}

/** SCREENS 7.0: «Эти данные только что изменил {кто}. Обновите страницу». */
export function conflictText(who: string | null): string {
  return who
    ? `Эти данные только что изменил ${who}. Обновите страницу`
    : "Эти данные только что изменил другой администратор. Обновите страницу";
}

// ------------------------------------------------------------------ import

export const IMPORT_STATUS_TEXT: Record<VehicleImportStatus, string> = {
  parsing: "Проверяется",
  ready: "Отчёт готов",
  applying: "Применяется",
  applied: "Применён",
  cancelled: "Отменён",
  failed: "Прервался по времени",
};

export const PLAN_TEXT: Record<VehicleImportPlan, string> = {
  create: "Добавится",
  update: "Обновится",
  unchanged: "Без изменений",
  rejected: "Ошибка",
};

export const OUTCOME_TEXT = {
  created: "Создано",
  updated: "Обновлено",
  unchanged: "Без изменений",
  rejected: "Отклонено",
} as const;

export const COLUMN_TEXT: Record<VehicleImportColumn, string> = {
  make: "Марка",
  model: "Модель",
  generation: "Поколение",
  generation_year_from: "Поколение с",
  generation_year_to: "Поколение по",
  body: "Кузов",
  engine_code: "Двигатель",
  engine_displacement_l: "Объём, л",
  engine_fuel: "Топливо",
  engine_power_hp: "Мощность, л.с.",
  transmission: "КПП",
  drive: "Привод",
  year_from: "Год с",
  year_to: "Год по",
  market: "Рынок",
};

/** A row number the server's message names («row 2 of this file»). */
function rowOf(message: string): string | null {
  return /row (\d+)/.exec(message)?.[1] ?? null;
}

/** Why a row is refused, in words: the column, the value as read, the reason. */
export function reasonText(reason: VehicleImportReason, values?: Record<string, string>): string {
  const value = reason.column ? values?.[reason.column] : undefined;
  const where = reason.column
    ? `«${COLUMN_TEXT[reason.column]}»${value ? `: «${value}»` : ""} — `
    : "";
  const row = rowOf(reason.message);
  const words: Record<VehicleImportReason["code"], string> = {
    wrong_field_count: "в строке больше или меньше ячеек, чем колонок в заголовке",
    missing_value: "пусто, а значение обязательно",
    too_long: "длиннее 100 знаков",
    invalid_year: "это не год",
    invalid_number: "это не число",
    invalid_market: "рынок — kz или global",
    year_order: "последний год раньше первого",
    years_outside_generation: "годы модификации вне лет поколения",
    unknown_option: "нет такого значения в справочном списке (из файла они не создаются)",
    archived_reference: "это значение в архиве",
    generation_not_found:
      "такого поколения у модели нет, а годы поколения, чтобы создать его, не указаны",
    generation_years_mismatch: "поколение уже есть с другими годами",
    engine_mismatch: "двигатель уже есть с другим топливом, объёмом или мощностью",
    engine_fuel_required: "для нового двигателя нужно топливо",
    duplicate_in_file: row ? `повтор строки ${row} этого файла` : "повтор строки этого файла",
    matches_archived: "такая модификация есть в архиве — восстановите её вручную",
  };
  const text = words[reason.code];
  return where ? `${where}${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

const DETECTED_TEXT: Record<string, string> = {
  pdf: "PDF",
  image: "картинка",
  binary: "двоичный файл",
  "utf-16": "UTF-16",
};

/** A file the server didn't take at all, in words (SCREENS A-CAR-02). */
export function importFileErrorText(error: unknown): string {
  if (!isApiError(error)) return actionErrorText(error);
  if (error.code === "PAYLOAD_TOO_LARGE") {
    const mb = /(\d+(?:\.\d+)?) MB/.exec(error.message)?.[1];
    return mb
      ? `Файл больше допустимого (${mb} МБ) — разделите его на несколько`
      : "Файл слишком большой — разделите его на несколько";
  }
  if (error.code !== "VEHICLE_IMPORT_FILE_INVALID") return actionErrorText(error);
  const details = (error.details ?? {}) as Partial<VehicleImportFileInvalidDetails>;
  const columns = (details.columns ?? []).join(", ");
  switch (details.reason) {
    case "unsupported_format":
      return details.detected === "xlsx" || details.detected === "xls"
        ? "Это не CSV — сохраните таблицу как CSV UTF-8 (в Excel: «Файл → Сохранить как → CSV UTF-8»)"
        : `Это не таблица CSV${details.detected && DETECTED_TEXT[details.detected] ? ` (${DETECTED_TEXT[details.detected]})` : ""} — нужен файл CSV UTF-8`;
    case "encoding":
      return "Файл не в кодировке UTF-8 — сохраните таблицу как «CSV UTF-8»";
    case "empty":
      return "Файл пустой";
    case "no_rows":
      return "В файле только заголовок — нет ни одной строки";
    case "malformed":
      return details.line
        ? `Файл повреждён: в строке ${details.line} не закрыта кавычка`
        : "Файл повреждён: не закрыта кавычка";
    case "missing_columns":
      return `Нет обязательных колонок: ${columns}. Сверьте заголовок с шаблоном`;
    case "unknown_columns":
      return `Лишние колонки: ${columns}. Уберите их или исправьте заголовок по шаблону`;
    case "duplicate_columns":
      return `Колонки повторяются: ${columns}`;
    case "too_many_rows":
      return details.limit
        ? `Строк больше, чем можно загрузить за раз (${details.limit.toLocaleString("ru-RU")}) — разделите файл`
        : "Строк слишком много — разделите файл";
    default:
      return "Файл не подходит — сверьте его с шаблоном";
  }
}

/**
 * The type an import file is sent with: its own when the server lists it,
 * otherwise «just bytes» — the server decides what the file is by its
 * content anyway (ARCHITECTURE 4.24 I223), so a `.xlsx` or a file the
 * browser has no type for gets the server's words, not a refusal here.
 */
export function uploadContentType(type: string): (typeof VEHICLE_IMPORT_CONTENT_TYPES)[number] {
  const known = VEHICLE_IMPORT_CONTENT_TYPES.find((entry) => entry === type);
  return known ?? "application/octet-stream";
}

/** The byte order mark. */
const BOM = "\uFEFF";

/** The template as a file Excel opens in UTF-8: the byte order mark first. */
export function templateFileText(csv: string): string {
  return csv.startsWith(BOM) ? csv : BOM + csv;
}

/** Who uploaded or applied: the name, else the number partly hidden. */
export function personText(
  person: { name: string | null; phoneMasked: string | null } | null,
): string {
  if (!person) return "—";
  return person.name ?? person.phoneMasked ?? "администратор";
}

/** Row numbers as a short text: «3–6», «3, 5, 9». */
export function rowNumbersText(rows: readonly number[]): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length;) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    parts.push(end > index ? `${sorted[index]}–${sorted[end]}` : String(sorted[index]));
    index = end + 1;
  }
  return parts.join(", ");
}

/** The numbers of an import in one line: the report before, the result after. */
export function importNumbers(entry: AdminVehicleImport): string {
  if (entry.result) {
    const r = entry.result;
    return `создано ${r.created}, обновлено ${r.updated}, без изменений ${r.unchanged}, отклонено ${r.rejected}`;
  }
  if (entry.report) {
    const r = entry.report;
    return `добавится ${r.create}, обновится ${r.update}, без изменений ${r.unchanged}, ошибок ${r.rejected}`;
  }
  return `строк: ${entry.rowCount.toLocaleString("ru-RU")}`;
}

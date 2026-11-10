import { isApiError } from "@adclub/api-client";
import type {
  AdminMaintenanceItem,
  MaintenanceDueReason,
  MaintenanceItemProblem,
  MaintenanceItemStatus,
  MaintenanceLevel,
  MaintenancePlanSource,
  MaintenancePlanStatus,
  MaintenanceScopeLabel,
} from "@adclub/contracts";
import { actionErrorText } from "../../errors";

/**
 * The words of «Регламенты ТО» (TASK-061): states, sources, the server's
 * refusals and the intervals in plain Russian. Nothing here decides
 * anything — what is due, what is sold and whether a plan may be activated
 * are the server's answers.
 */

export const PLAN_STATUS_TEXT: Record<MaintenancePlanStatus, string> = {
  draft: "Черновик",
  active: "Действует",
  archived: "В архиве",
};

export const PLAN_SOURCE_TEXT: Record<MaintenancePlanSource, string> = {
  ai_draft: "Черновик ИИ",
  manual: "Вручную",
  official: "Официальный",
};

export const ITEM_STATUS_TEXT: Record<MaintenanceItemStatus, string> = {
  proposed: "Предложено ИИ",
  active: "Подтверждено",
  archived: "В архиве",
};

export const ITEM_KIND_TEXT: Record<AdminMaintenanceItem["kind"], string> = {
  part: "Запчасть",
  service: "Услуга",
};

export const PROBLEM_TEXT: Record<MaintenanceItemProblem | "not_confirmed", string> = {
  not_confirmed: "не подтверждено",
  no_rule: "нет правила подбора",
  category_unavailable: "подкатегория скрыта или в архиве",
  attribute_unavailable: "условие по характеристике больше не действует",
  item_unavailable: "позиция в архиве или удалена",
};

export const REASON_TEXT: Record<MaintenanceDueReason, string> = {
  by_code: "по коду ТО",
  by_km: "по пробегу",
  by_months: "по сроку",
  first: "первый раз",
};

export const LEVEL_TEXT: Record<MaintenanceLevel, string> = {
  make: "марку",
  model: "модель",
  generation: "поколение",
  engine: "двигатель",
};

/** «Geely · Atlas · II (FX11) (с 2023) · JLH-4G20TD». */
export function scopeLabelText(label: MaintenanceScopeLabel): string {
  return [label.make, label.model, label.generation, label.engine].filter(Boolean).join(" · ");
}

const km = (value: number) => `${value.toLocaleString("ru-RU")} км`;

/** «каждые 10 000 км / 12 мес», «первый раз — 5 000 км». */
export function intervalText(item: {
  intervalKm: number | null;
  intervalMonths: number | null;
}): string {
  const parts = [
    item.intervalKm === null ? null : km(item.intervalKm),
    item.intervalMonths === null ? null : `${String(item.intervalMonths)} мес`,
  ].filter(Boolean);
  return parts.length === 0 ? "—" : `каждые ${parts.join(" / ")}`;
}

export function firstText(item: {
  firstKm: number | null;
  firstMonths: number | null;
}): string | null {
  const parts = [
    item.firstKm === null ? null : km(item.firstKm),
    item.firstMonths === null ? null : `${String(item.firstMonths)} мес`,
  ].filter(Boolean);
  return parts.length === 0 ? null : `первый раз — ${parts.join(" / ")}`;
}

/** «в справочнике 3 позиции, в продаже 1» — the counts of the check. */
export function catalogCountText(
  catalogTotal: number,
  sold: number | null,
  cityRequired: boolean,
): string {
  const total = `в справочнике ${catalogTotal.toLocaleString("ru-RU")}`;
  if (cityRequired) return `${total} · в продаже — выберите город`;
  return `${total} · в продаже ${(sold ?? 0).toLocaleString("ru-RU")}`;
}

/** Codes typed as one line «ТО-1, ТО-2» → the list the server takes. */
export function codesOf(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[,;\n]/u)
    .map((code) => code.trim())
    .filter((code) => {
      const key = code.toLowerCase();
      if (!code || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** A number typed into a field: digits with spaces; empty — `null`; anything else — `undefined`. */
export function numberOf(text: string): number | null | undefined {
  const compact = text.replace(/[\s\u00a0\u202f]/gu, "");
  if (compact === "") return null;
  if (!/^\d+$/u.test(compact)) return undefined;
  return Number(compact);
}

function detail<T>(error: unknown, key: string): T | undefined {
  if (!isApiError(error)) return undefined;
  const details = error.details;
  return typeof details === "object" && details !== null && key in details
    ? ((details as Record<string, unknown>)[key] as T)
    : undefined;
}

/** Whether a refusal is a colleague's change meanwhile. */
export function isMaintenanceConflict(error: unknown): boolean {
  return isApiError(error) && error.code === "MAINTENANCE_VERSION_CONFLICT";
}

/** The plan already active in the area, when the activation was refused for it. */
export function activePlanOf(error: unknown): string | null {
  if (!isApiError(error) || error.code !== "MAINTENANCE_PLAN_ACTIVE_EXISTS") return null;
  return detail<string>(error, "existingPlanId") ?? null;
}

/** Why the plan can't be activated, one line per element (the server's list). */
export function notReadyLines(
  error: unknown,
  titleOf: (itemId: string) => string,
): string[] | null {
  if (!isApiError(error) || error.code !== "MAINTENANCE_PLAN_NOT_READY") return null;
  const empty = detail<boolean>(error, "empty") ?? false;
  const items =
    detail<{ itemId: string; reasons: (keyof typeof PROBLEM_TEXT)[] }[]>(error, "items") ?? [];
  const lines = items.map(
    (entry) =>
      `«${titleOf(entry.itemId)}»: ${entry.reasons.map((reason) => PROBLEM_TEXT[reason]).join(", ")}`,
  );
  return empty ? ["В плане нет ни одного элемента", ...lines] : lines;
}

const TARGET_TEXT: Record<string, string> = {
  category: "Подкатегория не подходит: выберите активную подкатегорию нужного вида",
  attribute: "Условие не подходит к характеристике подкатегории",
  option: "Такого варианта у характеристики нет",
  item: "Позиция в архиве, не найдена или другого вида",
};

/** A refusal of the section in words. */
export function maintenanceErrorText(error: unknown): string {
  if (!isApiError(error)) return actionErrorText(error);
  switch (error.code) {
    case "MAINTENANCE_PLAN_ACTIVE_EXISTS":
      return "У этой области уже есть действующий план — сначала уберите его в архив";
    case "MAINTENANCE_PLAN_NOT_READY":
      return "План нельзя активировать: не все элементы подтверждены и ведут в справочник";
    case "MAINTENANCE_PLAN_STATE":
      return "Сейчас это сделать нельзя: обновите страницу";
    case "MAINTENANCE_DRAFT_IN_PROGRESS":
      return "ИИ уже составляет черновик для этой области — дождитесь его";
    case "MAINTENANCE_TARGET_INVALID":
      return TARGET_TEXT[detail<string>(error, "reason") ?? ""] ?? "Правило подбора не подходит";
    case "MAINTENANCE_SCOPE_INVALID": {
      const reason = detail<string>(error, "reason");
      if (reason === "model_of_other_make") return "Модель другой марки";
      if (reason === "generation_of_other_model") return "Поколение другой модели";
      return "Такого значения нет в справочнике автомобилей";
    }
    case "COMPATIBILITY_VEHICLE_INVALID":
      return "Автомобиль указан несогласованно: проверьте уровни";
    case "SERVICE_UNAVAILABLE":
      return "ИИ сейчас не смог составить черновик. Попробуйте позже";
    case "RATE_LIMITED":
      return "Сегодня вы уже запросили много черновиков. Попробуйте завтра";
    default:
      return actionErrorText(error);
  }
}

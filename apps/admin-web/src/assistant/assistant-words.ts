import { isApiError } from "@adclub/api-client";
import {
  assistantComplaintConflictDetailsSchema,
  type AdminAssistantComplaint,
  type AssistantCarWords,
  type AssistantComplaintReason,
  type AssistantComplaintStatus,
  type AssistantIntent,
  type AssistantMessageKind,
} from "@adclub/contracts";
import { actionErrorText } from "../errors";
import { formatMoment } from "../format";

/**
 * The words of «Помощник» (TASK-062): complaints about answers of the AI
 * Pilot and the dialog behind each. The server decides; these only say it.
 */
export const ASSISTANT_REASON_TEXT: Record<AssistantComplaintReason, string> = {
  wrong_item: "Не та позиция",
  not_compatible: "Не подходит к автомобилю",
  offensive: "Грубый или неуместный ответ",
  other: "Другое",
};

export const ASSISTANT_STATUS_TEXT: Record<AssistantComplaintStatus, string> = {
  new: "Новая",
  resolved: "Решена",
};

export const ASSISTANT_INTENT_TEXT: Record<AssistantIntent, string> = {
  pick_by_params: "Подбор по параметрам",
  maintenance: "ТО по регламенту",
  symptom: "Симптом",
  other: "Не по теме",
};

export const ASSISTANT_KIND_TEXT: Record<AssistantMessageKind, string> = {
  answer: "Ответ",
  question: "Уточняющий вопрос",
  off_topic: "Не по теме",
  unavailable: "Недоступен",
};

/** The tools of a turn by their names, as an administrator reads them. */
export const TOOL_TEXT: Record<string, string> = {
  search_catalog: "Поиск по каталогу",
  get_item: "Карточка позиции",
  get_maintenance_plan: "Регламент ТО",
  list_categories: "Дерево категорий",
  ask_user: "Вопрос пользователю",
  propose: "Ответ",
};

/** The status filter of the list (the address keeps it). */
export const ASSISTANT_STATUS_FILTERS = [
  { value: "new", label: "Новые" },
  { value: "resolved", label: "Решённые" },
  { value: "all", label: "Все" },
] as const;

/** «Geely Coolray, I (SX11), 2024, JLH-3G15TD 1.5 л». */
export function carText(car: AssistantCarWords): string {
  return [car.make, car.model, car.generation, car.year, car.engine]
    .filter((part) => part !== null && part !== "")
    .join(", ");
}

/** Dollars of AI spend with the precision a dialog needs («$0.0123»). */
export function usdText(usd: number): string {
  return `$${usd.toFixed(usd >= 0.1 ? 2 : 4)}`;
}

/** «Жалобу уже решил {кто} {когда}» — what changed under the administrator's action. */
export function assistantConflictText(complaint: AdminAssistantComplaint): string {
  return complaint.status === "resolved"
    ? `Жалобу уже решил ${complaint.resolvedBy?.name ?? "администратор"}, ${formatMoment(complaint.resolvedAt)}`
    : "Эти данные только что изменили. Обновите страницу";
}

export function assistantComplaintErrorText(error: unknown): string {
  if (isApiError(error) && error.code === "ASSISTANT_COMPLAINT_CONFLICT") {
    const details = assistantComplaintConflictDetailsSchema.safeParse(error.details);
    return details.success
      ? assistantConflictText(details.data.complaint)
      : "Эти данные только что изменили. Обновите страницу";
  }
  return actionErrorText(error);
}

/** A tool call's arguments or result as short text for the card (the server cut them already). */
export function jsonText(value: unknown, max = 600): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

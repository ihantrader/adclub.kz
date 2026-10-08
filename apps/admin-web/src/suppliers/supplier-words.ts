import { isApiError } from "@adclub/api-client";
import type {
  AdminSupplierMember,
  OrderStatusValue,
  SupplierInvitationStatus,
  SupplierLeadStatusValue,
  SupplierLeadSource,
  SupplierStateValue,
  SupplierType,
} from "@adclub/contracts";
import { checkKzBin, normalizeKzMobilePhone, supplierLeadTransition } from "@adclub/domain";
import { actionErrorText, retryMinutes, validationText } from "../errors";
import { supplierPath } from "../router";
import { conflictText, type VehicleErrorView } from "../vehicles/vehicle-words";

/**
 * The words of «Поставщики» (TASK-036; SCREENS A-SUP-01…04, 7.0): what the
 * server's answers mean in plain Russian. Nothing here decides anything —
 * the funnel's moves, the БИН, the numbers, the limits of invitations, the
 * last employee and the blocking are the server's (ARCHITECTURE 4.26,
 * 4.27); the checks here only spare a request that would surely fail.
 */

export const LEAD_STATUS_TEXT: Record<SupplierLeadStatusValue, string> = {
  new: "Новая",
  contacted: "Связались",
  meeting: "Встреча",
  contract_signed: "Договор подписан",
  onboarded: "Заведён",
  rejected: "Отказ",
};

/** The columns of the funnel, in its order. */
export const LEAD_STATUSES: readonly SupplierLeadStatusValue[] = [
  "new",
  "contacted",
  "meeting",
  "contract_signed",
  "onboarded",
  "rejected",
];

export const LEAD_SOURCE_TEXT: Record<SupplierLeadSource, string> = {
  public_form: "форма на сайте",
  admin: "добавлена вручную",
};

export const SUPPLIER_TYPE_TEXT: Record<SupplierType, string> = {
  goods: "Товары",
  services: "Услуги",
  both: "Товары и услуги",
};

export const STATE_TEXT: Record<SupplierStateValue, string> = {
  active: "Активен",
  paused: "Пауза",
  blocked: "Блокировка",
};

export const INVITATION_TEXT: Record<SupplierInvitationStatus, string> = {
  queued: "отправляется",
  sent: "отправлено",
  failed: "не доставлено",
  cancelled: "отменено",
};

export const ORDER_STATUS_TEXT: Record<OrderStatusValue, string> = {
  created: "Ждёт ответа",
  accepted: "Принята",
  ready: "Готова к выдаче",
  completed: "Выдана",
  cancelled_by_user: "Отменена клиентом",
  declined_by_supplier: "Отклонена поставщиком",
  response_expired: "Нет ответа вовремя",
  reserve_expired: "Срок резерва истёк",
};

/**
 * A number partly hidden, as SCREENS 7.0 shows people's numbers:
 * «+7 777 *** ** 12». Revealing it in full (with the journal) is TASK-036.B.
 */
export function hiddenPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length !== 11) return "***";
  return `+${digits[0]} ${digits.slice(1, 4)} *** ** ${digits.slice(9)}`;
}

/** Where a request may go by hand from its status, and whether a reason is asked (the domain's rule). */
export function leadMoves(
  status: SupplierLeadStatusValue,
): { to: SupplierLeadStatusValue; reasonRequired: boolean }[] {
  return LEAD_STATUSES.flatMap((to) => {
    const move = supplierLeadTransition(status, to);
    return move.allowed ? [{ to, reasonRequired: move.reasonRequired }] : [];
  });
}

/** A БИН as typed: what is wrong with it, before asking the server (the same check). */
export function binProblem(text: string): string | null {
  if (!text.trim()) return "Укажите БИН";
  const checked = checkKzBin(text);
  if (checked.ok) return null;
  return checked.reason === "format"
    ? "БИН — 12 цифр"
    : "Такого БИН не бывает: не сходится контрольная цифра. Проверьте цифры";
}

/** A Kazakhstan mobile number as typed: `+77XXXXXXXXX`, or `null` when it isn't one. */
export function mobilePhone(text: string): string | null {
  return normalizeKzMobilePhone(text);
}

export const PHONE_HINT = "Нужен казахстанский мобильный номер, например +7 701 123 45 67";

/** Who added an employee, in a word. */
export function addedByText(member: AdminSupplierMember): string {
  switch (member.addedBy) {
    case "admin":
      return "администратор клуба";
    case "operator":
      return "оператор сервера";
    default:
      return member.addedByMember ? `коллега ${member.addedByMember.displayName}` : "коллега";
  }
}

function detail<T>(error: unknown, key: string): T | undefined {
  if (!isApiError(error)) return undefined;
  const details = error.details;
  return typeof details === "object" && details !== null && key in details
    ? ((details as Record<string, unknown>)[key] as T)
    : undefined;
}

/** The field of the first `VALIDATION_ERROR` issue (`firstMember.phone`, `closedDates.0.date`). */
function validationPath(error: unknown): string | null {
  if (!isApiError(error) || error.code !== "VALIDATION_ERROR") return null;
  const details = error.details;
  return Array.isArray(details) && typeof (details[0] as { path?: unknown })?.path === "string"
    ? (details[0] as { path: string }).path
    : null;
}

const LEAD_REFUSAL_TEXT: Record<string, string> = {
  same: "Заявка уже на этом этапе — обновите страницу",
  onboarded_only_by_onboarding: "«Заведён» ставится только заведением поставщика из заявки",
  final: "Поставщик по этой заявке уже заведён — заявка больше не меняется",
  contract_not_signed: "Завести поставщика можно только из заявки «Договор подписан»",
};

const STATE_REFUSAL_TEXT: Record<string, string> = {
  not_paused: "Компания уже не на паузе — обновите страницу",
  not_blocked: "Компания уже не заблокирована — обновите страницу",
  not_verified: "Компания уже не отмечена проверенной — обновите страницу",
  already_blocked: "Компания уже заблокирована — обновите страницу",
};

/** «через 5 мин» or «через 3 ч» — when a refused invitation may be asked again. */
export function waitText(error: unknown): string {
  const minutes = retryMinutes(error);
  return minutes > 90 ? `через ${Math.ceil(minutes / 60)} ч` : `через ${minutes} мин`;
}

/**
 * A refused change of «Поставщики» in words, at its field (SCREENS 7.0):
 * a БИН taken by another supplier with «Открыть», the funnel's and the
 * states' refusals, the blocking (D-070), the limits of invitations, a
 * colleague's change (the version — for «Обновить данные»; who it was is
 * added by the screen from the journal).
 */
export function supplierErrorView(error: unknown): VehicleErrorView {
  const view = (text: string, field: string | null = null): VehicleErrorView => ({
    text,
    field,
    link: null,
    currentVersion: null,
  });
  if (!isApiError(error)) return view(actionErrorText(error));
  switch (error.code) {
    case "SUPPLIER_VERSION_CONFLICT":
      return {
        ...view(conflictText(null)),
        currentVersion: detail<number>(error, "currentVersion") ?? null,
      };
    case "SUPPLIER_BIN_TAKEN": {
      const existing = detail<string>(error, "existingSupplierId");
      return {
        ...view("Поставщик с этим БИН уже есть", "bin"),
        link: existing ? { href: supplierPath(existing), label: "Открыть" } : null,
      };
    }
    case "SUPPLIER_LEAD_STATE":
      return view(
        LEAD_REFUSAL_TEXT[detail<string>(error, "refusal") ?? ""] ??
          "Заявка уже в другом состоянии — обновите страницу",
      );
    case "SUPPLIER_STATE":
      return view(
        STATE_REFUSAL_TEXT[detail<string>(error, "refusal") ?? ""] ??
          "Состояние компании уже другое — обновите страницу",
      );
    case "SUPPLIER_BLOCKED":
      return view(
        "Компания заблокирована: добавлять сотрудников и отправлять приглашения нельзя, пока блокировка не снята",
      );
    case "SUPPLIER_MEMBER_EXISTS":
      return view(
        detail<string>(error, "status") === "removed"
          ? "Этот номер — удалённый сотрудник компании. Верните его кнопкой «Восстановить доступ» в списке удалённых"
          : "Этот номер уже сотрудник компании",
        "phone",
      );
    case "SUPPLIER_MEMBER_STATE":
      return view(
        detail<string>(error, "refusal") === "not_removed"
          ? "Сотрудник уже не удалён — обновите страницу"
          : "Сотрудник удалён — сначала восстановите доступ",
      );
    case "SUPPLIER_LAST_MEMBER":
      return view("У компании должен остаться хотя бы один сотрудник");
    case "SUPPLIER_NOTIFICATION_LIMIT":
      return view(
        `Достигнут предел получателей уведомлений — ${detail<number>(error, "limit") ?? ""}`,
      );
    case "CITY_ARCHIVED":
      return view("Город в архиве — выберите другой или восстановите его", "cityId");
    case "RATE_LIMITED":
      return detail<string>(error, "limit") === "supplier_invitation_resend"
        ? view(`Приглашение этому сотруднику уже отправляли недавно. Повторно — ${waitText(error)}`)
        : view(actionErrorText(error));
    case "VALIDATION_ERROR": {
      const path = validationPath(error);
      const field = path?.split(".").at(-1) ?? null;
      if (path === "bin") return view("Неверный БИН — проверьте цифры", "bin");
      if (field === "phone" || field === "contactPhone") return view(PHONE_HINT, path);
      if (path?.startsWith("closedDates")) {
        return view(
          "Нерабочая дата — не раньше сегодняшней (по часовому поясу поставщика) и не дальше двух лет",
          "closedDates",
        );
      }
      if (path?.startsWith("weeklyHours")) {
        return view(
          "Проверьте часы работы: конец позже начала, перерывы по порядку",
          "weeklyHours",
        );
      }
      if (path === "contractSignedOn") {
        return view("Дата договора не может быть позже сегодняшней", "contractSignedOn");
      }
      if (path === "reason" || path === "note") return view("Укажите причину", path);
      return view(validationText(error) ?? "Проверьте введённое", path);
    }
    case "NOT_FOUND":
      return view("Не найдено — обновите страницу");
    default:
      return view(actionErrorText(error));
  }
}

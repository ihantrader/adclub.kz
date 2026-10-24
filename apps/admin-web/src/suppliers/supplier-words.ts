import { isApiError } from "@adclub/api-client";
import type {
  AdminSupplierMember,
  PriceImport,
  PriceImportFailure,
  SupplierInvitationStatus,
  SupplierLeadStatusValue,
  SupplierOffer,
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

/**
 * A number partly hidden, as SCREENS 7.0 shows people's numbers:
 * «+7 777 *** ** 12». Revealing it in full (with the journal) is TASK-036.B.
 */
export function hiddenPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  // TASK-036.B: the server hides people's numbers itself; such a value is shown as it came.
  if (phone.includes("*")) return phone;
  const digits = phone.replace(/\D/g, "");
  if (digits.length !== 11) return "***";
  return `+${digits[0]} ${digits.slice(1, 4)} *** ** ${digits.slice(9)}`;
}

/**
 * «Название или БИН» of the funnel (X4): digits (spaces and dashes aside)
 * are a БИН — the server finds it whole, so it is `complete` at 12 digits;
 * anything else is a part of the name.
 */
export function leadSearchOf(text: string): { q?: string; bin?: string; complete?: boolean } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const digits = trimmed.replace(/[\s-]/g, "");
  if (/^\d+$/.test(digits)) return { bin: digits, complete: digits.length === 12 };
  return { q: trimmed };
}

const MONTH_TEXT = [
  "янв.",
  "февр.",
  "марта",
  "апр.",
  "мая",
  "июня",
  "июля",
  "авг.",
  "сент.",
  "окт.",
  "нояб.",
  "дек.",
];

/**
 * The version of a consent text in words (X28): «2026-09-mvp» — «версия
 * текста от сент. 2026», any other — «версия текста 1».
 */
export function consentVersionText(version: string): string {
  const dated = /^(\d{4})-(\d{2})(?:\b|-)/.exec(version);
  const month = dated ? Number(dated[2]) : 0;
  if (dated && month >= 1 && month <= 12) {
    return `версия текста от ${MONTH_TEXT[month - 1]} ${dated[1]}`;
  }
  return `версия текста ${version}`;
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

/**
 * Where a session was last used, without technical marks (X28): an
 * address the server could not shorten to a network («0:0::*», empty) is
 * «IP скрыт».
 */
export function ipText(hint: string | null): string {
  if (!hint || /^[0:.*]+$/.test(hint)) return "IP скрыт";
  return `IP ${hint}`;
}

/** Sessions alike in a row: the same employee on the same device. */
export interface SessionGroup<T> {
  first: T;
  rest: T[];
}

/**
 * Folds the sessions of one employee on one device that follow each other
 * (X22: «Chrome · Windows» ten times is one row with «ещё 9 таких»).
 */
export function sessionGroups<
  T extends {
    member: { id: string };
    deviceName: string | null;
    platform: string | null;
    clientVersion: string | null;
  },
>(sessions: readonly T[]): SessionGroup<T>[] {
  const groups: SessionGroup<T>[] = [];
  for (const session of sessions) {
    const last = groups.at(-1)?.first;
    if (
      last &&
      last.member.id === session.member.id &&
      last.deviceName === session.deviceName &&
      last.platform === session.platform &&
      last.clientVersion === session.clientVersion
    ) {
      groups.at(-1)!.rest.push(session);
    } else {
      groups.push({ first: session, rest: [] });
    }
  }
  return groups;
}

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

/** «2 модели» under the price of a service priced by model (A-SUP-03 «Предложения»). */
export function offerPriceLine(offer: Pick<SupplierOffer, "pricing">): string {
  if (offer.pricing.mode === "single") return "";
  const count = offer.pricing.models.length;
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "модель"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "модели"
        : "моделей";
  return `${count} ${word}`;
}

/** The prices by model in the hint: «Geely Atlas — 10 000 ₸; Geely Coolray — 8 000 ₸». */
export function offerModelsText(offer: Pick<SupplierOffer, "pricing">): string | null {
  if (offer.pricing.mode === "single") return null;
  return offer.pricing.models
    .map(
      (row) =>
        `${row.make.name} ${row.model.name} — ${row.price.toLocaleString("ru-RU")} ₸${
          row.available ? "" : " (в архиве)"
        }`,
    )
    .join("; ");
}

/** The state of a price list upload (A-SUP-03 «Прайс», TASK-046). */
export const PRICE_IMPORT_STATUS_TEXT: Record<PriceImport["status"], string> = {
  parsing: "Файл читается",
  columns: "Ждёт подтверждения колонок",
  reading: "Строки разбираются",
  parsed: "Разобран",
  // TASK-047.
  matching: "Сопоставляется со справочником",
  review: "Ждёт сверки поставщика",
  applying: "Применяется",
  applied: "Применён",
  failed: "Не прочитан",
  expired: "Сверка истекла",
};

const PRICE_FAILURE_TEXT: Record<PriceImportFailure["reason"], string> = {
  not_a_table: "не таблица",
  old_excel: "старый .xls",
  encrypted: "защищён паролем",
  broken: "файл повреждён",
  empty: "нет строк с товарами",
  too_many_rows: "слишком много строк",
  encoding: "неизвестная кодировка",
  file_missing: "файл удалён по сроку хранения",
  timeout: "обрабатывался слишком долго",
};

/** Why an upload was not read, in a few words. */
export function priceImportFailureText(failure: PriceImportFailure): string {
  return PRICE_FAILURE_TEXT[failure.reason] ?? failure.reason;
}

/**
 * The type of an uploaded file by its content — as the server read it, the
 * same for the cabinet: «Excel», «CSV»; a name that says otherwise
 * («renamed.csv» holding a workbook) gets «по содержимому».
 */
export function priceImportTypeText(entry: Pick<PriceImport, "format" | "fileName">): string {
  const type = entry.format === "xlsx" ? "Excel" : "CSV";
  const extension = /\.([a-z0-9]+)$/i.exec(entry.fileName ?? "")?.[1]?.toLowerCase();
  if (!extension) return type;
  const named = ["xlsx", "xlsm", "xls"].includes(extension) ? "xlsx" : "csv";
  return named === entry.format ? type : `${type} по содержимому`;
}

const ENCODING_TEXT: Record<string, string> = {
  "utf-8": "UTF-8",
  "windows-1251": "Windows-1251",
  "utf-16le": "UTF-16",
};

const DELIMITER_TEXT: Record<string, string> = {
  ",": "запятая",
  ";": "точка с запятой",
  "\t": "табуляция",
  "|": "вертикальная черта",
};

/** «1 240». */
function n(value: number): string {
  return value.toLocaleString("ru-RU");
}

/**
 * What the server knows of one upload, «подпись — значение» (A-SUP-03
 * «Прайс», «Подробнее»): the sheet or the encoding, the rows, the matching,
 * what applying did, who applied it, the file kept or not. Only what there
 * is; nothing technical.
 */
export function priceImportFacts(
  entry: PriceImport,
  moment: (iso: string) => string,
): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  const add = (label: string, value: string | null | false | undefined) => {
    if (value) facts.push({ label, value });
  };
  add("Загрузил", `${entry.uploadedBy.name ?? "сотрудник"}, ${moment(entry.createdAt)}`);
  add("Лист", entry.sheetName);
  if (entry.format === "csv") {
    add(
      "Кодировка",
      [
        entry.encoding ? (ENCODING_TEXT[entry.encoding] ?? entry.encoding) : null,
        entry.delimiter
          ? `разделитель — ${DELIMITER_TEXT[entry.delimiter] ?? `«${entry.delimiter}»`}`
          : null,
      ]
        .filter(Boolean)
        .join(", "),
    );
  }
  add("Строка заголовка", entry.headerRowNo !== null ? n(entry.headerRowNo) : null);
  if (entry.stats) {
    const stats = entry.stats;
    add(
      "Строки",
      [
        `всего ${n(stats.rows)}`,
        `с товарами ${n(stats.dataRows)}`,
        stats.serviceRows > 0 ? `служебных ${n(stats.serviceRows)}` : null,
        stats.parsedRows !== null ? `разобрано ${n(stats.parsedRows)}` : null,
        stats.errorRows !== null ? `с ошибками ${n(stats.errorRows)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  if (entry.match) {
    const match = entry.match;
    add(
      "Сверка",
      `уверенно ${n(match.confident)} · проверить ${n(match.review)} · не найдено ${n(match.notFound)} · ошибки ${n(match.errors)}` +
        (match.done < match.total ? ` (сопоставлено ${n(match.done)} из ${n(match.total)})` : ""),
    );
  }
  add(
    "Сверка до",
    entry.status === "review" && entry.reviewUntil ? moment(entry.reviewUntil) : null,
  );
  if (entry.result) {
    const result = entry.result;
    const withdrawn = result.withdrawnOutOfStock + result.withdrawnMissing;
    const notApplied = result.notApplied.reduce((sum, row) => sum + row.rows, 0);
    add(
      "Применение",
      [
        `обновлено ${n(result.updated)}`,
        `создано ${n(result.created)}`,
        `без изменений ${n(result.unchanged)}`,
        result.returned > 0 ? `вернулось в продажу ${n(result.returned)}` : null,
        withdrawn > 0 ? `снято ${n(withdrawn)}` : null,
        result.requested > 0 ? `на добавление ${n(result.requested)}` : null,
        notApplied > 0 ? `не применено ${n(notApplied)}` : null,
        result.skipped > 0 ? `пропущено ${n(result.skipped)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  add(
    "Применил",
    entry.appliedBy && entry.appliedAt
      ? `${entry.appliedBy.name ?? "сотрудник"}, ${moment(entry.appliedAt)}`
      : null,
  );
  add(
    "Причина",
    entry.failure
      ? `${priceImportFailureText(entry.failure)}${entry.failure.line !== null ? `, строка ${n(entry.failure.line)}` : ""}`
      : null,
  );
  add("Файл", entry.fileKept ? "хранится" : "удалён по сроку хранения");
  add("Тот же файл", entry.sameFileAsImportId ? "уже загружали раньше" : null);
  return facts;
}

/** «Строк с товарами: 1 240, с ошибками: 12» — what is known of the rows so far. */
export function priceImportNumbers(entry: PriceImport): string {
  if (!entry.stats) return "—";
  const goods = `с товарами: ${entry.stats.dataRows.toLocaleString("ru-RU")}`;
  return entry.stats.errorRows === null
    ? goods
    : `${goods}, с ошибками: ${entry.stats.errorRows.toLocaleString("ru-RU")}`;
}

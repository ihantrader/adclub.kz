import type { AuditActor, AuditActorRole } from "@adclub/contracts";
import { formatMoment } from "../format";
import { ORDER_STATUS_TEXT } from "../orders/order-words";
import { COMPLAINT_REASON_TEXT, HOLD_KIND_TEXT, REJECT_REASON_TEXT } from "../reviews/review-words";
import {
  SUBSCRIPTION_BY_TEXT,
  SUBSCRIPTION_EVENT_TEXT,
  SUBSCRIPTION_PROVIDER_TEXT,
  SUBSCRIPTION_STATUS_TEXT,
} from "../users/subscription-words";
import {
  catalogItemPath,
  catalogRequestPath,
  complaintPath,
  orderPath,
  routePaths,
  settingHistoryPath,
  supplierLeadPath,
  supplierPath,
  userPath,
  vehicleGenerationPath,
  vehicleImportPath,
  vehicleMakePath,
  vehicleModelPath,
  withQuery,
} from "../router";
import {
  INVITATION_TEXT,
  LEAD_SOURCE_TEXT,
  LEAD_STATUS_TEXT,
  SUPPLIER_TYPE_TEXT,
} from "../suppliers/supplier-words";

/**
 * The words of A-AUD (TASK-034 requirement 5): an action of the journal in
 * plain Russian, who did it, what it was about and «было → стало». An
 * action this dictionary doesn't know yet is shown as it is (the journal
 * gets new actions with every task, ARCHITECTURE 4.13).
 */
const ACTIONS: Record<string, string> = {
  "setting.changed": "Изменена настройка",
  "setting.reset": "Настройка возвращена по умолчанию",
  "admin.granted": "Назначен администратор",
  "admin.removed": "Снят администратор",
  "admin.totp_reset": "Сброшен второй фактор",
  "admin.backup_codes_regenerated": "Созданы новые резервные коды",
  "admin_signal.acknowledged": "Сигнал взят в работу",
  "admin_signal.closed": "Сигнал закрыт",
  "supplier.created": "Создана компания",
  "supplier.changed": "Изменены данные компании",
  "supplier.schedule_changed": "Изменены часы работы",
  "supplier.verification_changed": "Изменён статус «проверенный партнёр»",
  "supplier.pause_changed": "Пауза компании",
  "supplier.block_changed": "Блокировка компании",
  "supplier_member.added": "Добавлен сотрудник",
  "supplier_member.removed": "Удалён сотрудник",
  "supplier_member.restored": "Восстановлен сотрудник",
  "supplier_member.changed": "Изменены настройки сотрудника",
  "supplier_member.contact_person_changed": "Назначено контактное лицо",
  "supplier_member.sessions_ended": "Завершены сессии сотрудников",
  "supplier_invitation.requested": "Отправлено приглашение сотруднику",
  "supplier_lead.created": "Новая заявка на подключение",
  "supplier_lead.changed": "Изменена заявка на подключение",
  "supplier_lead.status_changed": "Заявка на подключение перешла на другой этап",
  "supplier_lead.note_added": "Заметка к заявке на подключение",
  "catalog_category.created": "Создана категория",
  "catalog_category.changed": "Изменена категория",
  "catalog_category.status_changed": "Изменён статус категории",
  "catalog_category.reordered": "Изменён порядок категорий",
  "catalog_attribute.created": "Создана характеристика",
  "catalog_attribute.changed": "Изменена характеристика",
  "catalog_attribute.status_changed": "Изменён статус характеристики",
  "catalog_attribute.reordered": "Изменён порядок характеристик",
  "catalog_attribute_option.created": "Создан вариант характеристики",
  "catalog_attribute_option.changed": "Изменён вариант характеристики",
  "catalog_attribute_option.status_changed": "Изменён статус варианта",
  "catalog_attribute_option.reordered": "Изменён порядок вариантов",
  "catalog_brand.created": "Создан бренд",
  "catalog_brand.changed": "Изменён бренд",
  "catalog_brand.status_changed": "Изменён статус бренда",
  "catalog_item.created": "Создана позиция",
  "catalog_item.changed": "Изменена позиция",
  "catalog_item.status_changed": "Изменён статус позиции",
  "catalog_item.values_changed": "Изменены характеристики позиции",
  "catalog_item.analog_linked": "Связаны аналоги",
  "catalog_item.analog_unlinked": "Убрана связь аналогов",
  "catalog_synonym.added": "Добавлен синоним для поиска",
  "catalog_synonym.removed": "Убран синоним для поиска",
  "catalog_translation.edited": "Перевод исправлен вручную",
  "catalog_translation.released": "Снята ручная правка перевода",
  "catalog_translation.requeued": "Перевод поставлен заново",
  "catalog_item_photo.uploaded": "Загружено фото позиции",
  "catalog_item_photo.status_changed": "Изменён статус фото",
  "catalog_item_photo.reordered": "Изменён порядок фото",
  "vehicle_option.created": "Создано значение справочника автомобилей",
  "vehicle_option.changed": "Изменено значение справочника автомобилей",
  "vehicle_option.status_changed": "Изменён статус значения справочника автомобилей",
  "vehicle_option.reordered": "Изменён порядок справочного списка автомобилей",
  "vehicle_make.created": "Создана марка",
  "vehicle_make.changed": "Изменена марка",
  "vehicle_make.status_changed": "Изменён статус марки",
  "vehicle_model.created": "Создана модель",
  "vehicle_model.changed": "Изменена модель",
  "vehicle_model.status_changed": "Изменён статус модели",
  "vehicle_generation.created": "Создано поколение",
  "vehicle_generation.changed": "Изменено поколение",
  "vehicle_generation.status_changed": "Изменён статус поколения",
  "vehicle_engine.created": "Создан двигатель",
  "vehicle_engine.changed": "Изменён двигатель",
  "vehicle_engine.status_changed": "Изменён статус двигателя",
  "vehicle_modification.created": "Создана модификация",
  "vehicle_modification.changed": "Изменена модификация",
  "vehicle_modification.status_changed": "Изменён статус модификации",
  "vehicle_import.uploaded": "Загружен файл импорта автомобилей",
  "vehicle_import.apply_started": "Подтверждён импорт автомобилей",
  "vehicle_import.applied": "Импорт автомобилей применён",
  "vehicle_import.cancelled": "Импорт автомобилей отменён",
  "vehicle_import.failed": "Импорт автомобилей прерван",
  "item_compatibility.created": "Добавлена совместимость",
  "item_compatibility.changed": "Изменена совместимость",
  "item_compatibility.archived": "Убрана совместимость",
  "item_compatibility_proposal.created": "Поставщик предложил совместимость",
  "item_compatibility_proposal.approved": "Предложение совместимости подтверждено",
  "item_compatibility_proposal.rejected": "Предложение совместимости отклонено",
  "city.created": "Добавлен город",
  "city.changed": "Изменён город",
  "city.status_changed": "Изменён статус города",
  "city.reordered": "Изменён порядок городов",
  "offer.created": "Выставлено предложение",
  "offer.changed": "Изменено предложение",
  "offer.withdrawn": "Предложение снято с продажи",
  "offer.returned": "Предложение возвращено в продажу",
  "club_access.granted": "Выдан клубный доступ",
  "club_access.revoked": "Отозван клубный доступ",
  "subscription.changed": "Изменилась подписка",
  "plan.added": "Добавлен тариф",
  "review_login.enabled": "Включён служебный вход для сторов",
  "review_login.disabled": "Выключен служебный вход для сторов",
  "review_login.signed_in": "Вход в приложение служебным входом для сторов",
  "supplier.card_changed": "Изменилась привязка карты поставщика",
  "order.phone_revealed": "Поставщику открыт телефон покупателя",
  "order.closed_by_admin": "Заявка закрыта администратором без кода",
  "order.lookup_blocked": "Поиск по коду временно закрыт после неверных кодов",
  "order.deadline_extended": "Продлён срок заявки",
  "user_discipline_event.revoked": "Снята дисциплинарная отметка",
  "account.registration_completed": "Пользователь завершил регистрацию",
  "account.profile_updated": "Пользователь изменил свои данные",
  "order.cancelled_by_admin": "Заявка отменена администратором",
  "phone.revealed": "Открыт полный номер",
  "account.sessions_ended": "Завершены сессии приложения пользователя",
  "price_import.applied": "Прайс применён к предложениям",
  "catalog_request.created": "Поставщик запросил добавить позицию",
  "catalog_request.approved": "Запрос на позицию закрыт: позиция в справочнике",
  "catalog_request.rejected": "Запрос на позицию отклонён",
  // TASK-049.
  "review.created": "Пользователь оставил отзыв",
  "review.checked": "Отзыв проверен автоматически",
  "review.published": "Отзыв опубликован администратором",
  "review.text_rejected": "Текст отзыва отклонён",
  "review.hidden": "Отзыв скрыт",
  "review.restored": "Отзыв возвращён",
  "review.text_edited": "Автор исправил текст отзыва",
  "review.score_only": "Автор опубликовал только оценку",
  "complaint.created": "Пользователь подал жалобу",
  "complaint.taken": "Жалоба взята в работу",
  "complaint.resolved": "Жалоба решена",
};

/** The actions the filter offers, in the order of the dictionary. */
export const knownActions: readonly string[] = Object.keys(ACTIONS);

export function actionText(action: string): string {
  return ACTIONS[action] ?? action;
}

/**
 * The reason of an entry: the administrator's own words as written, a reason
 * from a list (the refused text of a review, TASK-049) in its words.
 */
export function reasonText(action: string, reason: string): string {
  if (action === "review.text_rejected") {
    return REJECT_REASON_TEXT[reason as keyof typeof REJECT_REASON_TEXT] ?? reason;
  }
  return reason;
}

const ENTITIES: Record<string, string> = {
  setting: "Настройка",
  admin_user: "Администратор",
  admin_signal: "Сигнал",
  supplier: "Компания",
  supplier_member: "Сотрудник поставщика",
  supplier_lead: "Заявка на подключение",
  supplier_invitation: "Приглашение",
  catalog_category: "Категория",
  catalog_attribute: "Характеристика",
  catalog_attribute_option: "Вариант характеристики",
  catalog_brand: "Бренд",
  catalog_item: "Позиция",
  catalog_translation: "Перевод",
  catalog_item_photo: "Фото позиции",
  vehicle_option: "Справочник автомобилей",
  vehicle_make: "Марка",
  vehicle_model: "Модель",
  vehicle_generation: "Поколение",
  vehicle_engine: "Двигатель",
  vehicle_modification: "Модификация",
  vehicle_import: "Импорт автомобилей",
  item_compatibility: "Совместимость",
  item_compatibility_proposal: "Предложение совместимости",
  city: "Город",
  offer: "Предложение",
  club_access_grant: "Клубный доступ",
  subscription: "Подписка",
  plan: "Тариф",
  review_login: "Служебный вход для сторов",
  order: "Заявка",
  user_discipline_event: "Дисциплинарная отметка",
  account: "Пользователь",
  price_import: "Загрузка прайса",
  catalog_request: "Запрос на позицию",
  review: "Отзыв",
  complaint: "Жалоба",
};

/** The kinds of objects the filter offers. */
export const knownEntities: readonly string[] = Object.keys(ENTITIES);

export function entityText(entityType: string): string {
  return ENTITIES[entityType] ?? entityType;
}

export const ROLE_TEXT: Record<AuditActorRole, string> = {
  admin: "Администратор",
  supplier: "Сотрудник поставщика",
  user: "Пользователь",
  operator: "Оператор сервера",
  system: "Система",
};

/**
 * Who acted: the name when there is one, the number partly hidden (a
 * user's number is never shown in full here, SCREENS 7.0).
 */
export function actorText(actor: AuditActor): string {
  if (actor.role === "operator" || actor.role === "system") return ROLE_TEXT[actor.role];
  const who = [actor.name, actor.phoneMasked].filter(Boolean).join(" · ");
  return who || ROLE_TEXT[actor.role];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A field of `before`/`after` of an entry, if it is a string. */
function named(
  payload: { before?: unknown; after?: unknown } | undefined,
  key: string,
): string | null {
  for (const side of [payload?.after, payload?.before]) {
    if (typeof side === "object" && side !== null && key in side) {
      const value = (side as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
  }
  return null;
}

/** Where a thing of the catalog opens: an item — its card, the structure — the tree on it (TASK-035). */
function catalogLink(entityType: string, entityId: string): string | null {
  if (!UUID.test(entityId)) return null;
  switch (entityType) {
    case "catalog_item":
      return catalogItemPath(entityId);
    case "category":
    case "catalog_category":
      return withQuery(routePaths.catalog, { node: entityId });
    case "attribute":
    case "catalog_attribute":
      return withQuery(routePaths.catalog, { attribute: entityId });
    case "attribute_option":
    case "catalog_attribute_option":
      return withQuery(routePaths.catalog, { option: entityId });
    case "catalog_brand":
      return withQuery(routePaths.catalogItems, { brandId: entityId });
    default:
      return null;
  }
}

/**
 * Where the object of an entry opens, if its section exists already;
 * `payload` — the entry's `before`/`after`, which name the item of a
 * photo or a compatibility record and the thing a translation is of.
 */
export function entityLink(
  entityType: string,
  entityId: string,
  payload?: { before?: unknown; after?: unknown },
): string | null {
  switch (entityType) {
    case "catalog_item":
    case "catalog_category":
    case "catalog_attribute":
    case "catalog_attribute_option":
    case "catalog_brand":
      return catalogLink(entityType, entityId);
    case "catalog_translation": {
      const of = named(payload, "entityType");
      if (of === "catalog_item" && UUID.test(entityId))
        return catalogItemPath(entityId, "translations");
      return of ? catalogLink(of, entityId) : null;
    }
    case "catalog_item_photo": {
      const itemId = named(payload, "itemId");
      return itemId && UUID.test(itemId) ? catalogItemPath(itemId, "photos") : null;
    }
    case "item_compatibility":
    case "item_compatibility_proposal": {
      const itemId = named(payload, "itemId");
      return itemId && UUID.test(itemId) ? catalogItemPath(itemId, "compatibility") : null;
    }
    case "setting":
      return /^[a-z][a-z0-9_]*$/.test(entityId) ? settingHistoryPath(entityId) : null;
    case "admin_signal":
      return routePaths.signals;
    case "city":
    case "cities":
      return routePaths.cities;
    case "admin_user":
      return routePaths.security;
    // The vehicle catalog (TASK-035.B): a level opens with what lies under it.
    case "vehicle_make":
      return UUID.test(entityId) ? vehicleMakePath(entityId) : null;
    case "vehicle_model":
      return UUID.test(entityId) ? vehicleModelPath(entityId) : null;
    case "vehicle_generation":
      return UUID.test(entityId) ? vehicleGenerationPath(entityId) : null;
    case "vehicle_modification": {
      const generationId = named(payload, "generationId");
      return generationId && UUID.test(generationId) && UUID.test(entityId)
        ? vehicleGenerationPath(generationId, entityId)
        : null;
    }
    case "vehicle_engine":
      return routePaths.vehicleEngines;
    case "vehicle_option": {
      const kind = named(payload, "kind");
      return withQuery(routePaths.vehicleOptions, {
        kind: kind ?? undefined,
        highlight: UUID.test(entityId) ? entityId : undefined,
      });
    }
    case "vehicle_import":
      return UUID.test(entityId) ? vehicleImportPath(entityId) : null;
    // Suppliers (TASK-036): the company opens its card, an employee and an
    // invitation — the card's «Сотрудники», a request — its card.
    case "supplier":
      return UUID.test(entityId) ? supplierPath(entityId) : null;
    case "supplier_member":
    case "supplier_invitation": {
      const supplierId = named(payload, "supplierId");
      return supplierId && UUID.test(supplierId) ? supplierPath(supplierId, "members") : null;
    }
    case "supplier_lead":
      return UUID.test(entityId) ? supplierLeadPath(entityId) : null;
    // A request to add an item opens its card; a price list — its company's «Прайс» (TASK-047).
    case "catalog_request":
      return UUID.test(entityId) ? catalogRequestPath(entityId) : null;
    case "price_import": {
      const supplierId = named(payload, "supplierId");
      return supplierId && UUID.test(supplierId) ? supplierPath(supplierId, "price") : null;
    }
    // Orders and users (TASK-036.B): an order its card, an account its card;
    // a grant of club access — its user's «Клубный доступ», a discipline
    // mark — its order (the user's «Дисциплина» when the order isn't named).
    case "order":
      return UUID.test(entityId) ? orderPath(entityId) : null;
    // TASK-049: a review opens the card of its order, a complaint its own card.
    case "review": {
      const orderId = named(payload, "orderId");
      return orderId && UUID.test(orderId) ? orderPath(orderId) : null;
    }
    case "complaint":
      return UUID.test(entityId) ? complaintPath(entityId) : null;
    case "account":
      return UUID.test(entityId) ? userPath(entityId) : null;
    // TASK-040: a subscription opens «Клубный доступ» of its user, as a grant does.
    case "club_access_grant":
    case "subscription": {
      const accountId = named(payload, "accountId");
      return accountId && UUID.test(accountId) ? userPath(accountId, "access") : null;
    }
    case "user_discipline_event": {
      const orderId = named(payload, "orderId");
      if (orderId && UUID.test(orderId)) return orderPath(orderId);
      const accountId = named(payload, "accountId");
      return accountId && UUID.test(accountId) ? userPath(accountId, "discipline") : null;
    }
    default:
      return null;
  }
}

/**
 * One line of «было → стало». `technical` — a field that says nothing to an
 * administrator (an id, a version, a service mark): only «Подробнее» shows it.
 */
export interface ChangeLine {
  field: string | null;
  before: string;
  after: string;
  technical?: true;
}

/** What a line needs besides the two values: whose entry it is and the names of the ids. */
export interface ChangeContext {
  entityType?: string;
  /** The server's names of the ids `before`/`after` refer to (TASK-036.B). */
  names?: Record<string, string>;
}

/**
 * The fields of the journal in words (TASK-036.B: «поля — словами»). A field
 * this dictionary doesn't know is shown by its key — and a test keeps the
 * fields of the entries the admin panel writes in it.
 */
const FIELD_TEXT: Record<string, string> = {
  // TASK-049: reviews and complaints.
  score: "Оценка",
  withText: "С текстом",
  reasons: "Причины проверки",
  rejectedReason: "Причина отклонения текста",
  value: "Значение",
  isDefault: "По умолчанию",
  version: "Версия",
  status: "Статус",
  state: "Состояние",
  names: "Названия",
  name: "Название",
  displayName: "Имя",
  companyName: "Компания",
  reason: "Причина",
  note: "Заметка",
  totpConfigured: "Второй фактор настроен",
  sessionsEnded: "Завершено сессий",
  invitationsCancelled: "Отменено приглашений",
  ended: "Завершено сессий",
  cityId: "Город",
  supplierId: "Компания",
  itemId: "Позиция",
  analogItemId: "Аналог",
  term: "Синоним",
  fromItemId: "Скопировано с позиции",
  categoryId: "Категория",
  parentId: "Узел",
  attributeId: "Характеристика",
  optionId: "Вариант",
  brandId: "Бренд",
  makeId: "Марка",
  modelId: "Модель",
  generationId: "Поколение",
  engineId: "Двигатель",
  modificationId: "Модификация",
  bodyTypeId: "Кузов",
  transmissionTypeId: "Коробка передач",
  driveTypeId: "Привод",
  fuelId: "Топливо",
  orderId: "Заявка",
  otherOrderId: "Другая заявка",
  offerId: "Предложение",
  leadId: "Заявка на подключение",
  contactPersonMemberId: "Контактное лицо",
  removedAt: "Удалён",
  restored: "Восстановлен",
  again: "Повторно",
  type: "Тип",
  bin: "БИН",
  binMasked: "БИН",
  phoneMasked: "Телефон",
  source: "Откуда",
  contactName: "Контактное лицо",
  contactPhone: "Телефон компании",
  address: "Адрес",
  district: "Район",
  timeZone: "Часовой пояс",
  deliveryByDefault: "Доставка по умолчанию",
  notificationsEnabled: "Получает уведомления",
  notificationLanguage: "Язык уведомлений",
  blocked: "Блокировка",
  paused: "Пауза",
  pauseReason: "Причина паузы",
  verified: "Проверенный партнёр",
  visibleOnShowcase: "Видно клиентам",
  contractSignedOn: "Договор подписан",
  weeklyHours: "Часы работы",
  closedDates: "Нерабочие даты",
  price: "Цена",
  availability: "Наличие",
  leadDays: "Срок, дней",
  pickup: "Самовывоз",
  delivery: "Доставка",
  warrantyMonths: "Гарантия, мес.",
  warrantyText: "Гарантия",
  supplierSku: "Свой артикул",
  supplierName: "Своё название",
  // A price list applied, a request to add an item (TASK-047).
  importId: "Загрузка прайса",
  rowNo: "Строка прайса",
  how: "Как",
  updated: "Обновлено",
  created: "Создано",
  unchanged: "Без изменений",
  returned: "Вернулось в продажу",
  withdrawnOutOfStock: "Снято: нет в наличии",
  withdrawnMissing: "Снято: нет в прайсе",
  requested: "Отправлено на добавление",
  skipped: "Пропущено",
  notApplied: "Не применено",
  validUntil: "До",
  endedAt: "Завершена",
  number: "Номер",
  deadline: "Срок",
  until: "До",
  minutes: "Минут",
  subject: "Чей номер",
  revoked: "Снята",
  kind: "Вид",
  accountCreated: "Учётная запись создана",
  email: "E-mail",
  emailNewsConsent: "Новости на e-mail",
  language: "Язык",
  consentVersion: "Версия согласия",
  article: "Артикул",
  yearFrom: "Год с",
  yearTo: "Год по",
  code: "Код",
  icon: "Значок",
  compatibilityRequired: "Совместимость обязательна",
  // TASK-040: a subscription, a tariff, a supplier's card.
  periodEnd: "Оплачено до",
  graceUntil: "Льготный период до",
  unconfirmedSince: "Не подтверждена с",
  changedBy: "Кто изменил",
  eventKind: "Событие",
  provider: "Провайдер",
  audience: "Для кого",
  validFrom: "Действует с",
  validTo: "Действует по",
  announceBeforeDays: "Объявить за, дней",
  currency: "Валюта",
  period: "Период",
  cardLinked: "Карта привязана",
  isRequiredForComplete: "Участвует в полноте",
  isFilterable: "В фильтрах",
  unit: "Единица",
  aliases: "Написания",
  evidence: "Источник",
  fileName: "Файл",
  comment: "Комментарий",
};

/**
 * Fields that say nothing to an administrator in the line itself — ids
 * whose object the entry is anyway, versions, service marks — shown only
 * under «Подробнее» (TASK-036.B).
 */
const TECHNICAL_FIELDS = new Set([
  "accountId",
  "billingEventId",
  "memberId",
  "noteId",
  "adminId",
  "grantId",
  "sessionId",
  "sessionIds",
  "removedByMemberId",
  "version",
  "self",
  "one",
  "id",
  "requestId",
  "entityType",
  "field",
  "lang",
]);

const ACTIVE_ARCHIVED: Record<string, string> = {
  active: "Активна",
  hidden: "Скрыта",
  archived: "В архиве",
  draft: "Черновик",
};

/** The values of a status by the kind of object. */
const STATUS_WORDS: Record<string, Record<string, string>> = {
  supplier_lead: LEAD_STATUS_TEXT,
  supplier_member: { active: "Активен", removed: "Удалён" },
  order: ORDER_STATUS_TEXT,
  admin_signal: { open: "Новый", acknowledged: "В работе", closed: "Закрыт" },
  offer: { active: "В продаже", withdrawn: "Снято с продажи", suspended: "Приостановлено" },
  catalog_request: { new: "Новый", approved: "Добавлено", rejected: "Отклонено" },
  subscription: SUBSCRIPTION_STATUS_TEXT,
  review: {
    checking: "Проверяется",
    held: "На проверке",
    published: "Опубликован",
    hidden: "Скрыт",
    text_rejected: "Текст отклонён",
  },
  complaint: { new: "Новая", in_progress: "В работе", resolved: "Решена" },
  supplier_invitation: INVITATION_TEXT,
  catalog_item_photo: {
    proposed: "Предложено",
    approved: "Подтверждено",
    rejected: "Отклонено",
    deleted: "Убрано",
  },
  item_compatibility_proposal: {
    pending: "Ждёт решения",
    approved: "Подтверждено",
    rejected: "Отклонено",
  },
};

/** The values of other coded fields, whatever the object. */
const VALUE_WORDS: Record<string, Record<string, string>> = {
  state: { draft: "Черновик", active: "Активен", paused: "Пауза", blocked: "Блокировка" },
  type: { ...SUPPLIER_TYPE_TEXT, part: "Запчасть", generic: "Товар", service: "Услуга" },
  source: { ...LEAD_SOURCE_TEXT, manual: "вручную", price_import: "из прайса" },
  how: { created: "создана новая позиция", existing: "существующая позиция" },
  deadline: { response: "срок ответа", reserve: "резерв" },
  subject: {
    account: "пользователь",
    supplier_member: "сотрудник поставщика",
    supplier_lead: "заявка на подключение",
    order: "клиент заявки",
  },
  availability: { in_stock: "В наличии", on_order: "Под заказ" },
  reason: {
    manual: "вручную",
    missing_in_import: "нет в прайсе",
    out_of_stock_in_import: "нет в наличии по прайсу",
    // The reasons of a complaint (TASK-049).
    ...COMPLAINT_REASON_TEXT,
  },
  rejectedReason: REJECT_REASON_TEXT,
  // The reasons a check gave, «source:kind» (TASK-049).
  reasons: Object.fromEntries(
    Object.entries(HOLD_KIND_TEXT).flatMap(([kind, text]) => [
      [`rule:${kind}`, text],
      [`ai:${kind}`, `[AI] ${text}`],
      [`system:${kind}`, text],
    ]),
  ),
  language: { kk: "Қазақша", ru: "Русский", en: "English" },
  notificationLanguage: { kk: "Қазақша", ru: "Русский" },
  pauseReason: { admin: "решение администратора", billing: "не оплачена подписка" },
  // TASK-040: a subscription's changes.
  changedBy: SUBSCRIPTION_BY_TEXT,
  eventKind: SUBSCRIPTION_EVENT_TEXT,
  provider: SUBSCRIPTION_PROVIDER_TEXT,
  audience: { user: "Пользователь", supplier: "Поставщик" },
  note: { replaced: "заменена новой покупкой" },
  fulfillment: { pickup: "Самовывоз", delivery: "Доставка" },
  kind: {
    pickup_no_show: "Неявка",
    service_no_show: "Неявка на услугу",
    body: "Кузов",
    transmission: "Коробка передач",
    drive: "Привод",
    fuel: "Топливо",
    goods: "Товары",
    services: "Услуги",
  },
};

const DAY_SHORT = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/**
 * Fields whose numbers are codes, not amounts: a year, a БИН, the number of
 * an order, a version — written as they are, «2025», never «2 025»
 * (TASK-036; the remark of TASK-035.C).
 */
const CODE_FIELD = /year|number|bin|version|code|article|^id$|Id$/i;

/** A number of the journal: an amount with the thousands apart, a code as it is. */
export function numberText(value: number, field?: string | null): string {
  if (field && CODE_FIELD.test(field)) return String(value);
  return value.toLocaleString("ru-RU");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** «Пн 09:00–13:00, 14:00–18:00; Вт выходной» — the hours of a week. */
function weekText(days: unknown[]): string | null {
  const parts: string[] = [];
  for (const day of days) {
    if (!isRecord(day) || typeof day.day !== "number" || !Array.isArray(day.intervals)) return null;
    const intervals = day.intervals
      .filter(isRecord)
      .map((interval) => `${String(interval.from)}–${String(interval.to)}`);
    parts.push(
      `${DAY_SHORT[day.day] ?? day.day} ${intervals.length ? intervals.join(", ") : "выходной"}`,
    );
  }
  return parts.join("; ");
}

/** One value of the journal in words (TASK-036.B: «значения — словами»). */
export function valueText(
  value: unknown,
  field?: string | null,
  context: ChangeContext = {},
): string {
  if (value === undefined) return "—";
  if (value === null) return "пусто";
  if (value === true) return "да";
  if (value === false) return "нет";
  if (typeof value === "number") return numberText(value, field);
  if (typeof value === "string") {
    if (UUID.test(value)) {
      const name = context.names?.[value];
      if (name) return name;
      return field && FIELD_TEXT[field] && !TECHNICAL_FIELDS.has(field) ? "не найден" : value;
    }
    const words =
      field === "status" && context.entityType
        ? (STATUS_WORDS[context.entityType] ?? ACTIVE_ARCHIVED)
        : field
          ? VALUE_WORDS[field]
          : undefined;
    if (words?.[value]) return words[value]!;
    if (field === "status" && ACTIVE_ARCHIVED[value]) return ACTIVE_ARCHIVED[value]!;
    if (ISO_MOMENT.test(value) && !Number.isNaN(Date.parse(value))) return formatMoment(value);
    if (ISO_DATE.test(value)) return value.split("-").reverse().join(".");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "пусто";
    if (field === "weeklyHours") return weekText(value) ?? `${value.length} дн.`;
    if (value.every((entry) => isRecord(entry) && typeof entry.date === "string")) {
      return value
        .map((entry) => (entry as { date: string }).date.split("-").reverse().join("."))
        .join(", ");
    }
    if (value.every((entry) => typeof entry !== "object" || entry === null)) {
      return value.map((entry) => valueText(entry, field, context)).join(", ");
    }
    return `${value.length} шт.`;
  }
  if (isRecord(value)) {
    const text = value.ru ?? value.text ?? value.kk ?? value.en;
    if (typeof text === "string") return text;
    if (isRecord(text) && typeof text.text === "string") return text.text;
  }
  return JSON.stringify(value);
}

/**
 * Fields of an entry that say nothing to an administrator and aren't
 * shown at all: the market of a modification is kept by the server and the
 * import file, but the admin panel doesn't offer it (TASK-035.C, D-071).
 */
const HIDDEN_FIELDS: Record<string, readonly string[]> = {
  vehicle_modification: ["market"],
};

/** The fields of `entityType`'s entries «было → стало» leaves out. */
export function hiddenFieldsOf(entityType: string): readonly string[] {
  return HIDDEN_FIELDS[entityType] ?? [];
}

/** A field that reads otherwise on one kind of object: a person's `name` is a name, not a title. */
const ENTITY_FIELD_TEXT: Record<string, Record<string, string>> = {
  account: { name: "Имя" },
  admin_user: { name: "Имя" },
};

function line(key: string, before: unknown, after: unknown, context: ChangeContext): ChangeLine {
  const entry: ChangeLine = {
    field:
      (context.entityType ? ENTITY_FIELD_TEXT[context.entityType]?.[key] : undefined) ??
      FIELD_TEXT[key] ??
      key,
    before: valueText(before, key, context),
    after: valueText(after, key, context),
  };
  if (TECHNICAL_FIELDS.has(key)) entry.technical = true;
  return entry;
}

/**
 * «было → стало», compactly: field by field when both sides are objects
 * (only the fields that differ, then the ones only one side has; never
 * `hidden`), else one line. Fields and values in words; the technical ones
 * marked (only «Подробнее» shows them). Nothing — no change to show.
 */
export function changeLines(
  before: unknown,
  after: unknown,
  hidden: readonly string[] = [],
  context: ChangeContext = {},
): ChangeLine[] {
  if (before === null && after === null) return [];
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys
      .filter((key) => !hidden.includes(key))
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => {
        const entry = line(key, before[key], after[key], context);
        // An id only «before» names what the object belonged to (an employee's
        // company on its removal), not a change: under «Подробнее».
        const value = before[key];
        if (!(key in after) && typeof value === "string" && UUID.test(value)) {
          entry.technical = true;
        }
        return entry;
      });
  }
  if (isRecord(after) && (before === null || before === undefined)) {
    return Object.entries(after)
      .filter(([key]) => !hidden.includes(key))
      .map(([key, value]) => line(key, undefined, value, context));
  }
  if (isRecord(before) && (after === null || after === undefined)) {
    return Object.entries(before)
      .filter(([key]) => !hidden.includes(key))
      .map(([key, value]) => line(key, value, undefined, context));
  }
  return [{ field: null, before: valueText(before), after: valueText(after) }];
}

/**
 * The object of an entry by its name now (the server's `entityName`), with
 * its kind; an object the server can't find — the kind and «не найден», never
 * an id (the id is under «Подробнее»).
 */
export function entityTitle(entry: { entityType: string; entityName: string | null }): string {
  return `${entityText(entry.entityType)}: ${entry.entityName ?? "не найден"}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The start of a calendar day in Almaty (UTC+5, no daylight saving), as the API takes it. */
export function almatyDayStart(date: string, plusDays = 0): string | undefined {
  if (!DATE.test(date)) return undefined;
  const start = new Date(`${date}T00:00:00+05:00`);
  start.setUTCDate(start.getUTCDate() + plusDays);
  return start.toISOString();
}

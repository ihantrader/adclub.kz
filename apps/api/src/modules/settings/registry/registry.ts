import type { SettingEditableBy } from "@adclub/contracts";
import { z } from "zod";
import { define, type SettingDefinition } from "./setting-definition";

/**
 * The settings registry (ARCHITECTURE 14, 4.11; SCREENS A-SET-01,
 * A-SET-02): every product threshold, limit, time frame and text with its
 * type, unit, range, default and who may change it. A setting that isn't
 * here doesn't exist; a value stored for an unknown key is ignored.
 *
 * Defaults come from PRODUCT.md and ARCHITECTURE.md; where neither names a
 * value, the default is an assumption listed in TASK-007-REPORT.
 *
 * Hard safety limits are the `max` of the sign-in security settings
 * (admin session ≤ 12 hours, an unfinished sign-in ≤ 30 minutes): no
 * stored value above them is ever used (`registry.test.ts`).
 */

type Builder = (group: string, editableBy: SettingEditableBy) => SettingDefinition;

interface GroupSpec<Defs extends Record<string, Builder>> {
  id: string;
  title: string;
  editableBy: SettingEditableBy;
  settings: Defs;
}

function group<const Defs extends Record<string, Builder>>(spec: GroupSpec<Defs>) {
  const settings = Object.fromEntries(
    Object.entries(spec.settings).map(([key, build]) => [key, build(spec.id, spec.editableBy)]),
  ) as { [K in keyof Defs]: ReturnType<Defs[K]> };
  return { id: spec.id, title: spec.title, settings };
}

/** Admin session hard cap: 12 hours from sign-in (ARCHITECTURE 8.2, 4.7 I63). */
export const ADMIN_SESSION_MAX_SECONDS = 12 * 60 * 60;
/** An unfinished sign-in never stays open longer than 30 minutes (ARCHITECTURE 4.9 I84). */
export const SIGN_IN_STEP_MAX_SECONDS = 30 * 60;

const HOUR = 3600;
const DAY = 24 * HOUR;

const orders = group({
  id: "orders",
  title: "Заявки",
  editableBy: "admin",
  settings: {
    supplier_response_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 48,
      default: 2,
      description:
        "Сколько часов поставщик может не отвечать на новую заявку; затем заявка отменяется автоматически.",
    }),
    pickup_reserve_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 168,
      default: 24,
      description: "Сколько часов товар в наличии ждёт пользователя при самовывозе.",
    }),
    on_order_pickup_reserve_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 336,
      default: 72,
      description: "Сколько часов товар под заказ ждёт пользователя после поступления.",
    }),
    term_agreement_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 168,
      default: 24,
      description:
        "Сколько часов пользователь может отвечать на предложенный поставщиком срок (товар под заказ).",
    }),
    time_agreement_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 168,
      default: 24,
      description:
        "Сколько часов пользователь может отвечать на предложенное поставщиком время (услуга).",
    }),
    service_grace_hours: define.duration({
      unit: "hours",
      min: 0,
      max: 72,
      default: 2,
      description: "Сколько часов после назначенного времени услуга остаётся действующей.",
    }),
    reserve_warning_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 72,
      default: 3,
      description: "За сколько часов до конца резерва пользователь получает напоминание.",
    }),
    late_cancel_hours: define.duration({
      unit: "hours",
      min: 0,
      max: 72,
      default: 2,
      description:
        "Отмена услуги позже чем за столько часов до времени записывается в дисциплину пользователя.",
    }),
    late_close_window_hours: define.duration({
      unit: "hours",
      min: 0,
      max: 336,
      default: 48,
      description:
        "Сколько часов после истечения заявки поставщик ещё может закрыть её кодом (позднее закрытие).",
    }),
    deadline_extension_max_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 168,
      default: 24,
      description:
        "На сколько часов администратор может продлить сроки незакрытых заявок при сбое уведомлений.",
    }),
    attention_after_days: define.duration({
      unit: "days",
      min: 1,
      max: 90,
      default: 7,
      description:
        "Через сколько дней заявка с доставкой без движения попадает к администратору как сигнал.",
    }),
  },
});

const notificationKinds = [
  "order_accepted",
  "order_ready",
  "order_confirmed",
  "order_declined",
  "order_expired_no_response",
  "term_proposed",
  "time_proposed",
  "reserve_expiring",
  "order_closed",
  "maintenance_reminder",
  "payment_failed",
] as const;

const notifications = group({
  id: "notifications",
  title: "Уведомления",
  editableBy: "admin",
  settings: {
    max_notified_members: define.integer({
      unit: "count",
      min: 1,
      max: 50,
      default: 5,
      description: "Сколько сотрудников поставщика максимум получают уведомление о заявке.",
    }),
    whatsapp_fallback_minutes: define.duration({
      unit: "minutes",
      min: 1,
      max: 1440,
      default: 15,
      description:
        "Через сколько минут недоставленного WhatsApp поставщику уходит SMS «новая заявка».",
    }),
    push_ack_timeout_minutes: define.duration({
      unit: "minutes",
      min: 1,
      max: 1440,
      default: 10,
      description:
        "Через сколько минут без подтверждения получения push критичное уведомление дублируется в WhatsApp.",
    }),
    critical_notification_kinds: define.composite({
      schema: z.array(z.enum(notificationKinds)).max(notificationKinds.length),
      default: [
        "order_accepted",
        "order_declined",
        "time_proposed",
        "term_proposed",
        "reserve_expiring",
        "order_closed",
        "payment_failed",
      ],
      description:
        "Какие уведомления пользователю дублируются в WhatsApp, если push не подтверждён.",
    }),
    whatsapp_batch_window_seconds: define.duration({
      unit: "seconds",
      min: 0,
      max: 600,
      default: 60,
      description: "За какое окно однотипные сообщения WhatsApp одному получателю объединяются.",
    }),
    whatsapp_outage_window_minutes: define.duration({
      unit: "minutes",
      min: 1,
      max: 1440,
      default: 15,
      description: "Окно, за которое считается доля ошибок доставки WhatsApp (детектор сбоя).",
    }),
    whatsapp_outage_error_ratio: define.number({
      unit: "ratio",
      min: 0.01,
      max: 1,
      default: 0.5,
      description:
        "Доля ошибок доставки WhatsApp в окне, при которой администратор получает сигнал о сбое.",
    }),
    moderation_digest_hour: define.integer({
      unit: "hour_of_day",
      min: 0,
      max: 23,
      default: 18,
      description: "В котором часу (Алматы) поставщик получает сводку результатов модерации.",
    }),
  },
});

const guestLimitsSchema = z.strictObject({
  photo_recognitions: z.number().int().min(0).max(100),
  voice_requests: z.number().int().min(0).max(100),
  assistant_dialogs: z.number().int().min(0).max(100),
});

const guestAssistant = group({
  id: "guest_assistant",
  title: "Гость и помощник",
  editableBy: "admin",
  settings: {
    guest_limits: define.composite({
      schema: guestLimitsSchema,
      default: { photo_recognitions: 3, voice_requests: 5, assistant_dialogs: 3 },
      description:
        "Бессрочный лимит гостя на устройство: распознавания фото, голосовые запросы, диалоги с помощником.",
    }),
    guest_ai_daily_budget_usd: define.number({
      unit: "usd",
      min: 0,
      max: 10_000,
      default: 10,
      description:
        "Дневной бюджет на ИИ-операции всех гостей; при исчерпании гостю предлагается войти.",
    }),
    guest_ip_rate_limit_per_hour: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 10,
      description: "Сколько гостевых ИИ-запросов в час принимается с одного адреса.",
    }),
    guest_attestation_required: define.boolean({
      default: false,
      description:
        "Требовать проверку подлинности приложения (App Attest / Play Integrity) у гостя.",
    }),
    assistant_daily_dialogs_per_user: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 20,
      description: "Сколько диалогов с помощником в день доступно пользователю.",
    }),
    assistant_max_turns: define.integer({
      unit: "count",
      min: 1,
      max: 100,
      default: 8,
      description: "Сколько ходов может быть в одном диалоге с помощником.",
    }),
    ai_daily_budget_usd: define.number({
      unit: "usd",
      min: 0,
      max: 100_000,
      default: 100,
      description:
        "Общий дневной бюджет на ИИ (сутки по времени Алматы); при исчерпании помощник отключается и новые задачи автоперевода не отправляются.",
    }),
    assistant_symptom_disclaimer: define.localizedText({
      maxLength: 500,
      default: {
        kk: "Көмекші қателесуі мүмкін. Ақаудың нақты себебін тек автосервис анықтайды.",
        ru: "Помощник может ошибаться. Точную причину неисправности определит только автосервис.",
        en: "The assistant may be wrong. Only a car service can find the exact cause of the problem.",
      },
      description: "Оговорка, которую сервер добавляет к ответу помощника на описание симптома.",
    }),
  },
});

/**
 * An OpenRouter model identifier: `author/slug`, optionally an alias
 * (`~author/slug-latest`) or a variant (`author/slug:batch`). Checked
 * here so a typo is refused where it is made; whether OpenRouter actually
 * serves the model is answered by the call itself (`model_unavailable`,
 * ARCHITECTURE 4.20 I187).
 */
const MODEL_ID = {
  regex: /^~?[a-z0-9]([a-z0-9._-]*[a-z0-9])?\/[a-z0-9]([a-z0-9._:-]*[a-z0-9])?$/,
  message: "Must be an OpenRouter model identifier, e.g. google/gemini-3.8-flash",
};

const ai = group({
  id: "ai",
  title: "ИИ",
  editableBy: "admin",
  settings: {
    ai_model_translate_primary: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "google/gemini-2.5-flash-lite",
      description:
        "Модель OpenRouter для автоперевода справочника. Выбрана измерением на наборе примеров (TASK-053.B, D-058): вдесятеро дешевле прежней при том же результате проверок и самый устойчивый ответ по времени. Меняется без релиза; после изменения новые пакеты уходят новой модели не позже чем через 30 секунд.",
    }),
    ai_model_translate_fallback: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "deepseek/deepseek-v4-flash",
      description:
        "Запасная модель автоперевода: используется, когда основная недоступна или её нет у OpenRouter. Другой поставщик, чем основная, — иначе сбой у одного остановит обе (TASK-053.B). Чтобы запасной не было, укажите ту же модель, что и основную.",
    }),
    ai_call_reservation_usd: define.number({
      unit: "usd",
      min: 0.001,
      max: 10,
      default: 0.05,
      description:
        "Сколько резервируется из дневного бюджета на один вызов ИИ, пока провайдер не сообщит настоящую стоимость. Резерв держит предел при одновременных вызовах и остаётся учтённой стоимостью, если провайдер стоимость не сообщил.",
    }),
  },
});

const translation = group({
  id: "translation",
  title: "Переводы справочника",
  editableBy: "admin",
  settings: {
    translation_batch_size: define.integer({
      unit: "count",
      min: 1,
      max: 100,
      default: 20,
      description:
        "Сколько названий справочника отправляется ИИ на автоперевод одним запросом (пакет).",
    }),
    translation_retry_limit: define.integer({
      unit: "count",
      min: 0,
      max: 10,
      default: 3,
      description:
        "Сколько раз задача автоперевода повторяется при временной ошибке ИИ, прежде чем попасть в мёртвую очередь (0 — без повторов). Действует на задачи, поставленные после изменения.",
    }),
    translation_glossary_enabled: define.boolean({
      default: true,
      description:
        "Передавать ли модели короткий словарь терминов вместе с текстами (файл translation-glossary.json). На нашем наборе примеров словарь убрал русизмы и разнобой терминов у обеих дешёвых моделей; выключается, если словарь начнёт мешать.",
    }),
    translation_retry_delay_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: 3600,
      default: 60,
      description:
        "Пауза перед первым повтором задачи автоперевода; каждый следующий повтор вдвое дольше. Действует на задачи, поставленные после изменения.",
    }),
  },
});

const ratingWeightsSchema = z
  .strictObject({
    reviews: z.number().min(0).max(1),
    response_rate: z.number().min(0).max(1),
    deadline_rate: z.number().min(0).max(1),
  })
  .refine(
    (weights) =>
      Math.abs(weights.reviews + weights.response_rate + weights.deadline_rate - 1) < 1e-9,
    { message: "The weights must add up to 1" },
  );

const rating = group({
  id: "rating",
  title: "Рейтинг",
  editableBy: "admin",
  settings: {
    rating_min_reviews: define.integer({
      unit: "count",
      min: 1,
      max: 100,
      default: 5,
      description:
        "С какого числа оценок рейтинг поставщика показывается (до этого — «новый поставщик»).",
    }),
    rating_weights: define.composite({
      schema: ratingWeightsSchema,
      default: { reviews: 0.6, response_rate: 0.2, deadline_rate: 0.2 },
      description: "Веса оценок, доли ответов и доли соблюдения сроков в рейтинге (в сумме 1).",
    }),
    views_signal_min: define.integer({
      unit: "count",
      min: 1,
      max: 1_000_000,
      default: 100,
      description:
        "С какого числа просмотров предложений проверяется расхождение просмотров и заявок.",
    }),
    views_signal_ratio: define.number({
      unit: "ratio",
      min: 0.01,
      max: 1,
      default: 0.3,
      description:
        "Конверсия ниже этой доли от медианы категории — сигнал администратору об обходе платформы.",
    }),
  },
});

const pricelist = group({
  id: "pricelist",
  title: "Прайс",
  editableBy: "admin",
  settings: {
    price_match_confidence_threshold: define.number({
      unit: "ratio",
      min: 0.5,
      max: 1,
      default: 0.85,
      description:
        "Уверенность ИИ ниже этого порога — строка прайса требует подтверждения поставщиком.",
    }),
    price_change_threshold_percent: define.number({
      unit: "percent",
      min: 1,
      max: 1000,
      default: 30,
      description:
        "Изменение цены больше этого процента — строка не применяется без отдельного подтверждения.",
    }),
    import_max_file_mb: define.integer({
      unit: "megabytes",
      min: 1,
      max: 100,
      default: 20,
      description: "Наибольший размер файла прайса.",
    }),
    import_max_rows: define.integer({
      unit: "rows",
      min: 100,
      max: 200_000,
      default: 50_000,
      description: "Наибольшее число строк в одном прайсе.",
    }),
  },
});

const reviews = group({
  id: "reviews",
  title: "Отзывы",
  editableBy: "admin",
  settings: {
    review_check_max_wait_minutes: define.duration({
      unit: "minutes",
      min: 1,
      max: 10_080,
      default: 60,
      description:
        "Если автоматическая проверка отзыва не завершилась за это время, отзыв уходит администратору.",
    }),
  },
});

const photos = group({
  id: "photos",
  title: "Фото",
  editableBy: "admin",
  settings: {
    photo_display_mode: define.enum({
      values: ["link", "copy"],
      default: "link",
      description:
        "Как показывать найденные фото деталей: ссылкой на источник или копией в своём хранилище.",
    }),
    document_photo_ttl_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 168,
      default: 24,
      description: "Через сколько часов удаляются фото документов (техпаспорт, приборная панель).",
    }),
    photo_max_size_mb: define.integer({
      unit: "megabytes",
      min: 1,
      max: 50,
      default: 10,
      description:
        "Предельный размер файла фотографии позиции справочника при загрузке администратором.",
    }),
    photo_link_ttl_minutes: define.duration({
      unit: "minutes",
      min: 1,
      max: 1440,
      default: 60,
      description:
        "Сколько минут действует ссылка на изображение, выданная клиенту; истёкшую заменяет новая при следующем запросе.",
    }),
    photo_removed_retention_days: define.duration({
      unit: "days",
      min: 0,
      max: 90,
      default: 7,
      description:
        "Через сколько дней после отклонения или удаления фотографии её файлы удаляются из хранилища (до этого удаление можно отменить).",
    }),
    photo_orphan_retention_hours: define.duration({
      unit: "hours",
      min: 0,
      max: 720,
      default: 24,
      description:
        "Через сколько часов удаляются файлы изображений, на которые нет записей (прерванная загрузка). 0 — при ближайшем проходе задачи; так проверяют уборку, но при этом может попасть под удаление загрузка, идущая прямо сейчас.",
    }),
  },
});

const vehicles = group({
  id: "vehicles",
  title: "Справочник автомобилей",
  editableBy: "admin",
  settings: {
    vehicle_import_max_file_mb: define.integer({
      unit: "megabytes",
      min: 1,
      max: 20,
      default: 5,
      description: "Наибольший размер файла импорта справочника автомобилей.",
    }),
    vehicle_import_max_rows: define.integer({
      unit: "rows",
      min: 10,
      max: 50_000,
      default: 10_000,
      description: "Наибольшее число строк в одном файле импорта справочника автомобилей.",
    }),
    vehicle_import_batch_size: define.integer({
      unit: "rows",
      min: 10,
      max: 5000,
      default: 500,
      description:
        "Сколько строк импорта фоновая задача проверяет или применяет за один пакет (одну транзакцию).",
    }),
    vehicle_import_timeout_minutes: define.duration({
      unit: "minutes",
      min: 1,
      max: 60,
      default: 30,
      description:
        "Сколько минут может идти проверка или применение одного импорта; дольше — импорт помечается ошибкой.",
    }),
  },
});

const compatibility = group({
  id: "compatibility",
  title: "Совместимость",
  editableBy: "admin",
  settings: {
    compatibility_proposals_per_supplier_day: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 200,
      description:
        "Сколько предложений совместимости один поставщик может прислать за скользящие 24 часа; сверх — отказ с временем ожидания.",
    }),
  },
});

const billing = group({
  id: "billing",
  title: "Подписки и оплата",
  editableBy: "admin",
  settings: {
    billing_retry_days: define.duration({
      unit: "days",
      min: 1,
      max: 14,
      default: 3,
      description: "Сколько дней повторяется списание у поставщика до снятия товаров с витрины.",
    }),
    billing_notify_hour: define.integer({
      unit: "hour_of_day",
      min: 0,
      max: 23,
      default: 10,
      description: "В котором часу (Алматы) повторяется списание и уходят напоминания об оплате.",
    }),
    price_increase_notice_text: define.localizedText({
      maxLength: 1000,
      default: {
        kk: "Жазылым құны өзгереді. Жаңа баға келесі кезеңнен бастап қолданылады.",
        ru: "Стоимость подписки меняется. Новая цена начнёт действовать со следующего периода.",
        en: "The subscription price is changing. The new price applies from the next period.",
      },
      description: "Текст уведомления о повышении цены подписки.",
    }),
    store_lag_tolerance_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 720,
      default: 48,
      description:
        "Сколько часов после конца периода подписка стора считается действующей без подтверждения.",
    }),
    store_outage_signal_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 720,
      default: 24,
      description: "Сколько часов без успешного обращения к API стора до сигнала администратору.",
    }),
    user_billing_reminder_days: define.duration({
      unit: "days",
      min: 1,
      max: 30,
      default: 3,
      description: "За сколько дней до конца льготного периода пользователю напоминают об оплате.",
    }),
  },
});

const defaultUpdateMessages = {
  ru: "Эта версия приложения больше не поддерживается. Обновите приложение, чтобы продолжить.",
  kk: "Қосымшаның бұл нұсқасына қолдау көрсетілмейді. Жалғастыру үшін қосымшаны жаңартыңыз.",
  en: "This version of the app is no longer supported. Please update the app to continue.",
};

const clients = group({
  id: "clients",
  title: "Клиенты",
  editableBy: "admin",
  settings: {
    client_min_version_ios: define.appVersion({
      default: "0.0.0",
      description: "Минимальная поддерживаемая версия приложения на iOS.",
    }),
    client_min_version_android: define.appVersion({
      default: "0.0.0",
      description: "Минимальная поддерживаемая версия приложения на Android.",
    }),
    client_min_version_supplier_web: define.appVersion({
      default: "0.0.0",
      description: "Минимальная поддерживаемая версия кабинета поставщика.",
    }),
    client_min_version_admin_web: define.appVersion({
      default: "0.0.0",
      maxVersion: "admin_web_release",
      description:
        "Минимальная поддерживаемая версия админки. Нельзя установить выше текущей версии админки.",
    }),
    client_update_message: define.localizedText({
      maxLength: 500,
      default: defaultUpdateMessages,
      description: "Текст экрана «нужно обновление».",
    }),
    default_city: define.string({
      maxLength: 100,
      default: "Алматы",
      description: "Город по умолчанию, если город не определён и не выбран.",
    }),
    offline_cache_max_age_days: define.duration({
      unit: "days",
      min: 1,
      max: 365,
      default: 30,
      description:
        "Через сколько дней без синхронизации приложение скрывает сохранённые коды заявок.",
    }),
  },
});

const cleanup = group({
  id: "cleanup",
  title: "Очистка",
  editableBy: "admin",
  settings: {
    cleanup_login_code_retention_days: define.duration({
      unit: "days",
      min: 1,
      max: 365,
      default: 7,
      description:
        "Через сколько дней после окончания действия удаляются коды входа (использованные, заменённые, истёкшие).",
    }),
    cleanup_sign_in_step_retention_days: define.duration({
      unit: "days",
      min: 1,
      max: 30,
      default: 1,
      description:
        "Через сколько дней после завершения или истечения удаляются шаги входа (выбор компании, второй фактор).",
    }),
    cleanup_session_retention_days: define.duration({
      unit: "days",
      min: 1,
      max: 365,
      default: 30,
      description:
        "Через сколько дней после выхода или истечения удаляются сессии (нужны, чтобы разобраться в сообщении о чужом входе).",
    }),
  },
});

const loginCode = group({
  id: "login_code",
  title: "Коды входа",
  editableBy: "operator",
  settings: {
    login_code_length: define.integer({
      unit: "count",
      min: 4,
      max: 8,
      default: 6,
      description: "Число цифр в коде входа.",
    }),
    login_code_ttl_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: 1800,
      default: 300,
      description: "Сколько действует код входа с момента отправки.",
    }),
    login_code_max_attempts: define.integer({
      unit: "count",
      min: 1,
      max: 10,
      default: 5,
      description: "Сколько попыток ввода даётся на один код.",
    }),
    login_code_resend_interval_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: 600,
      default: 60,
      description: "Наименьший интервал между кодами на один номер.",
    }),
    login_code_verify_free_failures: define.integer({
      unit: "count",
      min: 0,
      max: 10,
      default: 2,
      description: "Сколько ошибок ввода подряд допускается без задержки.",
    }),
    login_code_verify_delay_base_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: 60,
      default: 2,
      description: "Задержка после первой ошибки сверх допустимых; каждая следующая удваивается.",
    }),
    login_code_requests_per_phone: define.integer({
      unit: "count",
      min: 1,
      max: 100_000,
      default: 5,
      description: "Сколько кодов можно запросить на один номер за окно.",
    }),
    login_code_requests_per_phone_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: HOUR,
      description: "Окно лимита запросов кода на номер.",
    }),
    login_code_requests_per_ip: define.integer({
      unit: "count",
      min: 1,
      max: 100_000,
      default: 30,
      description: "Сколько кодов можно запросить с одного адреса за окно.",
    }),
    login_code_requests_per_ip_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: HOUR,
      description: "Окно лимита запросов кода с адреса.",
    }),
    login_code_verifications_per_phone: define.integer({
      unit: "count",
      min: 1,
      max: 100_000,
      default: 15,
      description: "Сколько проверок кода на один номер допускается за окно.",
    }),
    login_code_verifications_per_phone_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: HOUR,
      description: "Окно лимита проверок кода на номер.",
    }),
    login_code_sms_per_phone_daily: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 5,
      description: "Сколько SMS с кодом в сутки отправляется на один номер.",
    }),
    login_code_sms_per_ip_daily: define.integer({
      unit: "count",
      min: 1,
      max: 100_000,
      default: 10,
      description: "Сколько SMS с кодом в сутки запрашивается с одного адреса.",
    }),
  },
});

const session = group({
  id: "session",
  title: "Сессии",
  editableBy: "operator",
  settings: {
    session_access_token_ttl_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: 900,
      description: "Срок действия access-токена.",
    }),
    session_mobile_ttl_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: 365 * DAY,
      default: 90 * DAY,
      description: "Срок мобильной сессии; продлевается при каждом обновлении токенов.",
    }),
    session_supplier_web_ttl_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: 365 * DAY,
      default: 180 * DAY,
      description: "Срок сессии кабинета поставщика; продлевается при каждом обновлении токенов.",
    }),
    session_admin_web_ttl_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: ADMIN_SESSION_MAX_SECONDS,
      default: ADMIN_SESSION_MAX_SECONDS,
      description: "Срок сессии админки от входа, без продления; не больше 12 часов.",
    }),
    session_refresh_reuse_grace_seconds: define.duration({
      unit: "seconds",
      min: 0,
      max: 600,
      default: 60,
      description:
        "Сколько секунд заменённый refresh-токен ещё возвращает ту же новую пару (повторы и параллельные обновления).",
    }),
    session_refresh_per_session: define.integer({
      unit: "count",
      min: 1,
      max: 100_000,
      default: 30,
      description: "Сколько обновлений токенов одной сессии допускается за окно.",
    }),
    session_refresh_per_session_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: HOUR,
      description: "Окно лимита обновлений на сессию.",
    }),
    session_refresh_per_ip: define.integer({
      unit: "count",
      min: 1,
      max: 1_000_000,
      default: 600,
      description: "Сколько обновлений токенов с одного адреса допускается за окно.",
    }),
    session_refresh_per_ip_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: HOUR,
      description: "Окно лимита обновлений с адреса.",
    }),
  },
});

const signIn = group({
  id: "sign_in",
  title: "Вход в кабинет и админку",
  editableBy: "operator",
  settings: {
    sign_in_supplier_selection_ttl_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: SIGN_IN_STEP_MAX_SECONDS,
      default: 600,
      description:
        "Сколько действует начатый выбор компании при входе в кабинет; не больше 30 минут.",
    }),
    sign_in_admin_totp_ttl_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: SIGN_IN_STEP_MAX_SECONDS,
      default: 600,
      description:
        "Сколько вход в админку ждёт второй фактор (включая настройку приложения); не больше 30 минут.",
    }),
    admin_totp_allowed_drift_steps: define.integer({
      unit: "count",
      min: 0,
      max: 5,
      default: 1,
      description:
        "На сколько 30-секундных шагов код приложения-аутентификатора может отставать или спешить.",
    }),
    admin_backup_code_count: define.integer({
      unit: "count",
      min: 1,
      max: 50,
      default: 10,
      description: "Число резервных кодов в наборе.",
    }),
    admin_totp_verify_per_admin: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 5,
      description: "Сколько проверок второго фактора одного администратора допускается за окно.",
    }),
    admin_totp_verify_per_admin_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: 900,
      description: "Окно лимита проверок второго фактора на администратора.",
    }),
    admin_totp_verify_per_ip: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 20,
      description: "Сколько проверок второго фактора с одного адреса допускается за окно.",
    }),
    admin_totp_verify_per_ip_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: 900,
      description: "Окно лимита проверок второго фактора с адреса.",
    }),
  },
});

/** Groups in the order the admin panel shows them. */
export const settingGroups = [
  orders,
  notifications,
  guestAssistant,
  ai,
  translation,
  rating,
  pricelist,
  reviews,
  photos,
  vehicles,
  compatibility,
  billing,
  clients,
  cleanup,
  loginCode,
  session,
  signIn,
] as const;

export const settingDefinitions = {
  ...orders.settings,
  ...notifications.settings,
  ...guestAssistant.settings,
  ...ai.settings,
  ...translation.settings,
  ...rating.settings,
  ...pricelist.settings,
  ...reviews.settings,
  ...photos.settings,
  ...vehicles.settings,
  ...compatibility.settings,
  ...billing.settings,
  ...clients.settings,
  ...cleanup.settings,
  ...loginCode.settings,
  ...session.settings,
  ...signIn.settings,
};

export type SettingDefinitions = typeof settingDefinitions;
export type SettingKey = keyof SettingDefinitions;
export type SettingValue<Key extends SettingKey> = SettingDefinitions[Key]["default"];
export type SettingValues = { [Key in SettingKey]: SettingValue<Key> };

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingDefinitions, key);
}

export function settingDefinition(key: SettingKey): SettingDefinition {
  return settingDefinitions[key];
}

/** Every key with its default (a fresh object each time). */
export function defaultSettingValues(): SettingValues {
  return structuredClone(
    Object.fromEntries(
      Object.entries(settingDefinitions).map(([key, definition]) => [key, definition.default]),
    ),
  ) as SettingValues;
}

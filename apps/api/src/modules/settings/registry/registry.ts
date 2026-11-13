import {
  MODEL_REQUEST_SERVER_MAX_SECONDS,
  notificationKinds,
  type SettingEditableBy,
} from "@adclub/contracts";
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
      // TASK-038 (ARCHITECTURE 4.62): записывается заметкой «поздняя отмена»
      // в журнал заявки; дисциплинарной отметки нет до EPIC-19.
      description:
        "Отмена подтверждённой записи на услугу позже чем за столько часов до времени отмечается в журнале заявки как поздняя.",
    }),
    // TASK-038 (ARCHITECTURE 4.62).
    service_booking_horizon_days: define.duration({
      unit: "days",
      min: 1,
      max: 90,
      default: 30,
      description:
        "На сколько дней вперёд можно записаться на услугу (и предложить другое время записи).",
    }),
    // TASK-022 (ARCHITECTURE 4.32): раньше ключ назывался
    // `late_close_window_hours` и ничем не читался.
    order_late_close_hours: define.duration({
      unit: "hours",
      min: 0,
      max: 336,
      default: 48,
      description:
        "Сколько часов после истечения резерва сотрудник поставщика ещё может закрыть заявку кодом или QR (позднее закрытие). Окно фиксируется в заявке при истечении: изменение настройки не меняет уже истёкшие заявки.",
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
    // TASK-021 (ARCHITECTURE 4.31).
    order_max_quantity: define.integer({
      unit: "count",
      min: 1,
      max: 999,
      default: 50,
      description: "Наибольшее количество товара в одной заявке.",
    }),
    order_create_per_account: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 20,
      description:
        "Сколько заявок один пользователь может создать за окно; сверх — отказ с временем ожидания (защита от спама). Повтор той же заявки двойным нажатием не считается.",
    }),
    order_create_per_account_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: DAY,
      default: HOUR,
      description: "Окно лимита создания заявок одним пользователем.",
    }),
    // TASK-022 (ARCHITECTURE 4.32).
    order_lookup_per_member: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 60,
      description:
        "Сколько раз один сотрудник может искать заявку по коду или QR за окно (общий предел, успешные поиски тоже).",
    }),
    order_lookup_per_member_window_seconds: define.duration({
      unit: "seconds",
      min: 10,
      max: DAY,
      default: 60,
      description: "Окно общего предела поиска заявки по коду.",
    }),
    order_lookup_failures_per_member: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 10,
      description:
        "Сколько неудачных поисков (код не найден или заявка другого поставщика) допускается одному сотруднику за окно; сверх — отказ с временем ожидания. Защита от перебора шестизначного кода.",
    }),
    order_lookup_failures_per_member_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: DAY,
      default: HOUR,
      description: "Окно предела неудачных поисков одного сотрудника.",
    }),
    order_lookup_failures_per_supplier: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 30,
      description:
        "Сколько неудачных поисков допускается всей компании за окно; сверх — отказ всей компании (перебор с нескольких учётных записей).",
    }),
    order_lookup_failures_per_supplier_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: DAY,
      default: HOUR,
      description: "Окно предела неудачных поисков одной компании.",
    }),
    order_actions_per_member: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 120,
      description:
        "Сколько действий по заявкам (принять, готово, отказать) один сотрудник может сделать за окно.",
    }),
    order_actions_per_member_window_seconds: define.duration({
      unit: "seconds",
      min: 10,
      max: DAY,
      default: 60,
      description: "Окно предела действий сотрудника по заявкам.",
    }),
    // TASK-023 (ARCHITECTURE 4.33).
    active_orders_copy_limit: define.integer({
      unit: "count",
      min: 1,
      max: 500,
      default: 50,
      description:
        "Сколько активных заявок приложение получает в сохранённую копию за раз. Если у пользователя их больше, отдаются ближайшие по сроку — те, с которыми он сейчас пойдёт к поставщику.",
    }),
    active_orders_per_account: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 60,
      description:
        "Сколько раз за окно один пользователь может обновить сохранённую копию активных заявок (приложение обновляет её при каждом открытии и по уведомлению, поэтому предел щедрый).",
    }),
    active_orders_per_account_window_seconds: define.duration({
      unit: "seconds",
      min: 10,
      max: DAY,
      default: 60,
      description: "Окно предела обновлений сохранённой копии активных заявок.",
    }),
    admin_close_signal_count: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 3,
      description:
        "Сколько закрытий заявок администратором без кода у одного поставщика за период дают сигнал администратору (D-043).",
    }),
    admin_close_signal_days: define.duration({
      unit: "days",
      min: 1,
      max: 365,
      default: 30,
      description: "Период, за который считаются закрытия администратором для сигнала.",
    }),
  },
});

// The kinds of notifications to the user: one list, in the contract
// (TASK-051) — the push gateway and this setting take them from there.

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
    push_send_attempts: define.integer({
      unit: "count",
      min: 1,
      max: 20,
      default: 5,
      description:
        "Сколько раз push пользователю пробуют отправить на устройство, если провайдер временно недоступен; после этого отправка попадает в мёртвую очередь и видна оператору. Постоянный отказ не повторяется, мёртвый токен устройства снимается с рассылки.",
    }),
    push_retry_delay_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: HOUR,
      default: 30,
      description:
        "Пауза перед повторной попыткой отправки push; каждая следующая вдвое дольше (механизм очереди).",
    }),
    push_send_claim_seconds: define.duration({
      unit: "seconds",
      min: 10,
      max: 600,
      default: 120,
      description:
        "На сколько отправка push на устройство закрепляется за попыткой: пока срок не прошёл, второй worker её не берёт. Попытка, прерванная остановкой процесса, после срока не повторяется — отправка помечается «неизвестно, ушло ли».",
    }),
    push_token_retention_days: define.duration({
      unit: "days",
      min: 1,
      max: 365,
      default: 30,
      description:
        "Сколько дней хранится токен устройства, снятый с рассылки (сессия завершена, провайдер сказал, что токен мёртв); потом его удаляет уборка.",
    }),
    push_unacked_window_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 720,
      default: 24,
      description:
        "За какое окно метрика считает долю отправленных push, которые приложение не подтвердило.",
    }),
    push_fallback_max_age_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 168,
      default: 24,
      description:
        "Сколько часов после срока подтверждения push ещё может уйти в резерв WhatsApp; более старое событие (например, пока worker стоял) не дублируется.",
    }),
    push_fallback_per_account_day: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 30,
      description:
        "Сколько резервных сообщений WhatsApp одному пользователю уходит за скользящие сутки; сверх — только push, отказ виден в журнале уведомлений.",
    }),
    push_unreliable_after: define.integer({
      unit: "count",
      min: 1,
      max: 50,
      default: 3,
      description:
        "После скольких критичных push подряд без подтверждения пользователь считается «push ненадёжен»: следующие критичные уведомления сразу дублируются в WhatsApp. Любое подтверждение снимает отметку.",
    }),
    push_fallback_signal_share: define.number({
      unit: "ratio",
      min: 0.01,
      max: 1,
      default: 0.5,
      description:
        "Доля критичных push за окно `push_unacked_window_hours`, ушедших в резерв WhatsApp, при которой администратор получает сигнал.",
    }),
    push_fallback_signal_min: define.integer({
      unit: "count",
      min: 1,
      max: 10000,
      default: 20,
      description:
        "Сколько критичных push за окно нужно, чтобы доля резерва считалась: на нескольких уведомлениях доля ничего не говорит.",
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
    whatsapp_outage_min_failures: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 3,
      description:
        "Сколько недошедших уведомлений о заявках в окне нужно, чтобы доля ошибок считалась сбоем канала: одна-две неудачи ещё не сбой.",
    }),
    whatsapp_outage_delivery_timeout_minutes: define.duration({
      unit: "minutes",
      min: 1,
      max: 1440,
      default: 10,
      description:
        "Через сколько минут уведомление о заявке, которое всё ещё в очереди или отправлено, но не подтверждено как доставленное, считается недошедшим (детектор сбоя).",
    }),
    order_button_valid_hours: define.duration({
      unit: "hours",
      min: 1,
      max: 720,
      default: 72,
      description:
        "Сколько часов после отправки действуют кнопки «Подтвердить» и «Отказать» уведомления о заявке; позже нажатие не применяется.",
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
        // SCREENS T-AI-01 (TASK-062).
        kk: "Бұл диагноз емес. Нақты себебін тек автосервис анықтайды.",
        ru: "Это не диагноз. Точную причину определит сервис.",
        en: "This is not a diagnosis. Only a car service can find the exact cause.",
      },
      description: "Оговорка, которую сервер добавляет к ответу помощника на описание симптома.",
    }),
    assistant_max_tool_calls: define.integer({
      unit: "count",
      min: 1,
      max: 50,
      default: 12,
      description:
        "Сколько вызовов инструментов (поиск по каталогу, карточка, регламент, дерево категорий) модель может сделать за один ход помощника (TASK-062); больше — ход заканчивается ответом «не удалось подобрать» без карточек.",
    }),
    assistant_turn_seconds: define.duration({
      unit: "seconds",
      min: 5,
      // The app waits for a turn only so long (TASK-063.B, `waitsForModel`).
      max: MODEL_REQUEST_SERVER_MAX_SECONDS,
      default: 45,
      description:
        "Сколько секунд может длиться один ход помощника целиком — все шаги модели и инструменты (TASK-062); дольше — «AI Pilot сейчас недоступен», ход не засчитывается. Не больше 75: дольше приложение ответа не ждёт (TASK-063.B).",
    }),
    assistant_guest_per_ip: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 20,
      description:
        "Сколько сообщений помощнику гости могут отправить с одного адреса (сети IPv6 /64) за окно (TASK-062) — против обхода пробного лимита устройства новым устройством.",
    }),
    assistant_guest_per_ip_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: DAY,
      default: HOUR,
      description: "Окно предела сообщений помощнику гостей с одного адреса.",
    }),
    assistant_messages_per_account: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 60,
      description:
        "Сколько сообщений помощнику вошедший пользователь может отправить за окно (TASK-062) — против зацикливания, не против обычного разговора; диалоги в сутки держит assistant_daily_dialogs_per_user.",
    }),
    assistant_messages_per_account_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: DAY,
      default: HOUR,
      description: "Окно предела сообщений помощнику одной учётной записи.",
    }),
    assistant_retention_days: define.duration({
      unit: "days",
      min: 1,
      max: 3650,
      default: 90,
      description:
        "Через сколько дней тексты сообщений диалогов с помощником обезличиваются — заменяются пометкой (TASK-062; ARCHITECTURE 11.1). Записи, намерения и позиции ответов остаются для статистики.",
    }),
    assistant_diagnostics_category: define.string({
      maxLength: 64,
      pattern: {
        regex: /^$|^[a-z][a-z0-9_]{0,63}$/,
        message: "Код подкатегории справочника (например computer_diagnostics) или пусто",
      },
      default: "computer_diagnostics",
      description:
        "Код подкатегории услуги диагностики: при симптоме помощник добавляет её карточку, если в городе пользователя такая услуга продаётся (TASK-062). Пусто — карточки диагностики нет.",
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
    ai_model_price_match_primary: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "google/gemini-2.5-flash-lite",
      description:
        "Модель OpenRouter для сопоставления строк прайса со справочником: выбирает одного из кандидатов поиска или отвечает «нет в справочнике» (TASK-047). Умолчание — как у автоперевода; замер на наборе примеров (D-058) — отдельной задачей. Меняется без релиза, действует не позже чем через 30 секунд.",
    }),
    ai_model_price_match_fallback: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "deepseek/deepseek-v4-flash",
      description:
        "Запасная модель сопоставления прайса: используется, когда основная недоступна. Чтобы запасной не было, укажите ту же модель, что и основную.",
    }),
    ai_model_review_check_primary: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "google/gemini-2.5-flash-lite",
      description:
        "Модель OpenRouter для проверки текста отзыва до публикации: мат и оскорбления, угрозы, личные данные, реклама (TASK-049). Критика и низкая оценка нарушением не являются; модель не отклоняет, а только задерживает отзыв для администратора. Умолчание — как у автоперевода; замер на наборе ai-eval/review-check (D-058) — отдельной задачей. Меняется без релиза, действует не позже чем через 30 секунд.",
    }),
    ai_model_review_check_fallback: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "deepseek/deepseek-v4-flash",
      description:
        "Запасная модель проверки отзывов: используется, когда основная недоступна. Чтобы запасной не было, укажите ту же модель, что и основную.",
    }),
    ai_model_maintenance_plan_primary: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "google/gemini-3.1-flash-lite",
      description:
        "Модель OpenRouter для черновика регламента ТО (TASK-061): по марке, модели, поколению и двигателю и по перечню подкатегорий справочника предлагает работы с интервалами на 60 000 км; черновик подтверждает администратор, ИИ ничего не активирует. Умолчание — дешёвая модель с широкими знаниями; замер на наборе примеров (D-058) — отдельной задачей. Меняется без релиза, действует не позже чем через 30 секунд.",
    }),
    ai_model_maintenance_plan_fallback: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "openai/gpt-4.1-mini",
      description:
        "Запасная модель черновика регламента ТО: используется, когда основная недоступна. Чтобы запасной не было, укажите ту же модель, что и основную.",
    }),
    ai_model_assistant_primary: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "google/gemini-3.1-flash-lite",
      description:
        "Модель OpenRouter для помощника AI Pilot (TASK-062): шаг диалога с инструментами (поиск по каталогу, карточка позиции, регламент ТО); должна поддерживать вызов инструментов, запросы уходят только провайдерам без хранения (D-057). Выбрана замером на наборе ai-eval/assistant (D-058, ARCHITECTURE 4.85 I970): намерение 94 %, допустимые позиции 97 %, ни одного «диагноза», около $0.0025 за диалог, медиана хода 4,4 с. Меняется без релиза, действует не позже чем через 30 секунд.",
    }),
    ai_model_assistant_fallback: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "openai/gpt-4.1-mini",
      description:
        "Запасная модель помощника: используется, когда основная недоступна, не нашла эндпоинта без хранения или ответила пусто. Другой поставщик; на замере у порога (намерение 88–94 %, позиции 94 %), без единой ошибки, около $0.0015 за диалог. Чтобы запасной не было, укажите ту же модель, что и основную.",
    }),
    ai_model_vehicle_document_primary: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "google/gemini-3.1-flash-lite",
      description:
        "Модель OpenRouter для распознавания фото техпаспорта (TASK-057, D-064). Должна понимать изображения; запросы уходят только провайдерам без хранения (D-057). Выбрана замером на синтетическом наборе (D-058, ARCHITECTURE 4.58): самая дешёвая из прошедших порог (VIN и госномер 17 из 17, вид документа 24 из 24), около $0.0006 за скан, медиана 1,6 с. Меняется без релиза, действует не позже чем через 30 секунд.",
    }),
    ai_model_vehicle_document_fallback: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "openai/gpt-4.1-mini",
      description:
        "Запасная модель распознавания техпаспорта: используется, когда основная недоступна. Другой поставщик, чем основная, и тоже прошла порог замера (около $0.0008 за скан). Чтобы запасной не было, укажите ту же модель, что и основную.",
    }),
    ai_model_dashboard_primary: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "google/gemma-3-27b-it",
      description:
        "Модель OpenRouter для чтения пробега с фото приборной панели (TASK-058). Должна понимать изображения; запросы уходят только провайдерам без хранения (D-057). Выбрана замером на синтетическом наборе ai-eval/dashboard (D-058, ARCHITECTURE 4.83): самая дешёвая из прошедших порог (точный пробег 17 из 17, «не панель» 3 из 3), около $0.00005 за скан, медиана 1,7 с. Меняется без релиза, действует не позже чем через 30 секунд.",
    }),
    ai_model_dashboard_fallback: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "google/gemini-3.1-flash-lite",
      description:
        "Запасная модель чтения пробега: используется, когда основная недоступна. Другой поставщик модели, тоже прошла порог замера (около $0.0005 за скан). Чтобы запасной не было, укажите ту же модель, что и основную.",
    }),
    ai_model_part_photo_primary: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "openai/gpt-4.1-nano",
      description:
        "Модель OpenRouter для чтения артикула с фото детали или упаковки (TASK-058). Должна понимать изображения; запросы уходят только провайдерам без хранения (D-057). Выбрана замером на синтетическом наборе ai-eval/part-photo (D-058, ARCHITECTURE 4.83): самая дешёвая из прошедших порог (артикул 17 из 17, ложный артикул 1 из 23 — у самого порога 5 %), около $0.00025 за скан. Меняется без релиза, действует не позже чем через 30 секунд.",
    }),
    ai_model_part_photo_fallback: define.string({
      maxLength: 100,
      pattern: MODEL_ID,
      default: "google/gemini-3.1-flash-lite",
      description:
        "Запасная модель чтения артикула: используется, когда основная недоступна. Другой поставщик, прошла порог без единого ложного артикула (около $0.0005 за скан). Чтобы запасной не было, укажите ту же модель, что и основную.",
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
      description:
        "Веса оценок, доли ответов и доли соблюдения сроков в рейтинге (в сумме 1). Рейтинг — взвешенная сумма: доля переводится в звёзды как 1 + 4 × доля. Новые веса — на ближайшей ночной сверке (или operator jobs:run ratings.reconcile).",
    }),
    rating_window_days: define.duration({
      unit: "days",
      min: 30,
      max: 730,
      default: 180,
      description:
        "За сколько последних дней считаются оценки (по дате публикации) и заявки (по дате оформления) в рейтинге поставщика.",
    }),
    rating_min_orders: define.integer({
      unit: "count",
      min: 1,
      max: 100,
      default: 5,
      description:
        "С какого числа заявок показываются доля ответов и доля соблюдения сроков (до этого — «Мало заявок для оценки», и доля не входит в рейтинг).",
    }),
    rating_low_signal: define.number({
      unit: "ratio",
      min: 1,
      max: 5,
      default: 3.5,
      description:
        "Рейтинг ниже этого числа звёзд (при показанном рейтинге) — сигнал администратору «Низкий рейтинг». Автоматической блокировки нет.",
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
      // The server reads at most 20 MB of an upload (PRICE_IMPORT_MAX_UPLOAD_BYTES).
      max: 20,
      default: 20,
      description: "Наибольший размер файла прайса.",
    }),
    import_max_rows: define.integer({
      unit: "rows",
      min: 100,
      max: 200_000,
      default: 50_000,
      description:
        "Наибольшее число непустых строк в одном прайсе (с шапкой и строками групп); больше — файл не принимается.",
    }),
    price_import_uploads_per_supplier_hour: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 20,
      description:
        "Сколько прайсов сотрудники одного поставщика могут загрузить за скользящий час; сверх — отказ с временем ожидания.",
    }),
    price_import_file_retention_days: define.duration({
      unit: "days",
      min: 1,
      max: 365,
      default: 30,
      description:
        "Сколько дней хранится файл загруженного прайса; затем он удаляется из хранилища, а загрузка и её строки остаются как история.",
    }),
    price_import_timeout_minutes: define.duration({
      unit: "minutes",
      min: 5,
      max: 240,
      default: 30,
      description:
        "Сколько минут может идти чтение файла прайса или его строк; дольше — загрузка помечается ошибкой, и поставщик загружает файл снова.",
    }),
    price_match_batch_size: define.integer({
      unit: "rows",
      min: 1,
      max: 200,
      default: 50,
      description:
        "Сколько строк прайса уходит модели ИИ одним вызовом при сопоставлении со справочником (у каждой — до трёх кандидатов).",
    }),
    price_match_retry_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: 3600,
      default: 60,
      description:
        "Через сколько секунд сопоставление прайса снова обращается к ИИ, если тот был недоступен или исчерпан дневной бюджет; загрузка всё это время ждёт и продолжается сама.",
    }),
    price_import_review_days: define.duration({
      unit: "days",
      min: 1,
      max: 90,
      default: 7,
      description:
        "Сколько дней хранится незаконченная сверка прайса; после этого загрузка истекает и ничего из неё не применяется.",
    }),
    price_export_per_member: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 10,
      description:
        "Сколько раз один сотрудник поставщика может скачать свой прайс («Скачать мой прайс») за окно; сверх — отказ с временем ожидания.",
    }),
    price_export_per_member_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: 600,
      description: "Окно лимита скачиваний своего прайса одним сотрудником.",
    }),
    catalog_requests_per_supplier_day: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 50,
      description:
        "Сколько запросов на добавление позиции сотрудники одного поставщика могут отправить вручную («Нет в справочнике?») за скользящие 24 часа; сверх — отказ с временем ожидания. Запросы из прайса не считаются.",
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
    // TASK-049 (ARCHITECTURE 4.69).
    review_text_max_length: define.integer({
      unit: "count",
      min: 100,
      max: 2000,
      default: 1000,
      description: "Наибольшая длина текста отзыва в знаках; длиннее — отказ у поля.",
    }),
    review_check_retry_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: 3600,
      default: 60,
      description:
        "Через сколько секунд проверка отзыва снова обращается к ИИ, если тот был недоступен или исчерпан дневной бюджет; отзыв всё это время ждёт проверки.",
    }),
    review_create_per_account: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 20,
      description:
        "Сколько запросов на отзыв (новый отзыв) один пользователь может отправить за окно; сверх — отказ с временем ожидания (защита от цикла, не от человека).",
    }),
    review_create_per_account_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: DAY,
      default: HOUR,
      description: "Окно предела новых отзывов одного пользователя.",
    }),
    complaint_text_max_length: define.integer({
      unit: "count",
      min: 100,
      max: 2000,
      default: 1000,
      description: "Наибольшая длина текста жалобы в знаках; длиннее — отказ у поля.",
    }),
    complaint_create_per_account: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 10,
      description:
        "Сколько жалоб один пользователь может отправить за окно; сверх — отказ с временем ожидания.",
    }),
    complaint_create_per_account_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: DAY,
      default: HOUR,
      description: "Окно предела жалоб одного пользователя.",
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

const garage = group({
  id: "garage",
  title: "Гараж",
  editableBy: "admin",
  settings: {
    garage_max_cars: define.integer({
      unit: "count",
      min: 1,
      max: 500,
      default: 30,
      description:
        "Наибольшее число автомобилей в гараже учётной записи (TASK-029); щедрый предел от случайного переполнения, не от обычного использования.",
    }),
    vehicle_document_max_size_mb: define.integer({
      unit: "megabytes",
      min: 1,
      max: 20,
      default: 10,
      description:
        "Предельный размер фото, которое сервер распознаёт: техпаспорт (TASK-057), приборная панель и деталь (TASK-058) — один предел на все три; приложение уменьшает снимок до отправки, так что обычный снимок много меньше. Имя — историческое (ARCHITECTURE 4.83).",
    }),
    vehicle_document_per_ip: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 30,
      description:
        "Сколько распознаваний фото (техпаспорт, приборная панель и деталь вместе — один счёт, TASK-058) гости могут сделать с одного адреса за окно — против обхода пробного лимита устройства (guest_limits) новым устройством. Адрес мобильного оператора бывает общим у многих людей, поэтому предел щедрый. Имя — историческое (ARCHITECTURE 4.83).",
    }),
    vehicle_document_per_ip_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: 7 * DAY,
      default: DAY,
      description: "Окно предела распознаваний фото гостями с одного адреса (все три вида).",
    }),
    vehicle_document_per_account: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 20,
      description:
        "Сколько распознаваний фото (техпаспорт, приборная панель и деталь вместе — один счёт, TASK-058) вошедший пользователь может сделать за окно (сутки по умолчанию). Имя — историческое (ARCHITECTURE 4.83).",
    }),
    vehicle_document_per_account_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: 7 * DAY,
      default: DAY,
      description: "Окно предела распознаваний фото одной учётной записи (все три вида).",
    }),
  },
});

// TASK-069 (ARCHITECTURE 4.87): reminders about a planned replacement and the mileage question.
const reminders = group({
  id: "reminders",
  title: "Напоминания",
  editableBy: "admin",
  settings: {
    mileage_ask_days: define.duration({
      unit: "days",
      min: 1,
      max: 365,
      default: 30,
      description:
        "Через сколько дней без нового показания пробега приложение спрашивает его (M-REM-02) и не чаще какого срока уходит push «Обновите пробег» (P-REM-02).",
    }),
    reminder_lead_km: define.integer({
      unit: "count",
      min: 0,
      max: 10_000,
      default: 500,
      description: "За сколько километров до плановой замены напоминать (км).",
    }),
    reminder_lead_days: define.duration({
      unit: "days",
      min: 0,
      max: 90,
      default: 14,
      description: "За сколько дней до плановой замены по сроку напоминать.",
    }),
    reminder_snooze_days: define.duration({
      unit: "days",
      min: 1,
      max: 90,
      default: 7,
      description: "На сколько дней «Напомнить позже» откладывает напоминание.",
    }),
    reminder_push_interval_days: define.duration({
      unit: "days",
      min: 1,
      max: 90,
      default: 3,
      description:
        "Не чаще какого срока уходит push о замене (P-REM-01) по одному автомобилю — сколько бы элементов ни подошло.",
    }),
    reminder_mileage_window_days: define.duration({
      unit: "days",
      min: 14,
      max: 730,
      default: 180,
      description:
        "За сколько последних дней берутся показания пробега, по которым считается средний дневной пробег.",
    }),
    reminder_hour: define.integer({
      unit: "hour_of_day",
      min: 0,
      max: 23,
      default: 11,
      description:
        "В котором часу (Алматы) ежедневно уходят напоминания о замене и вопросы о пробеге.",
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

const suppliers = group({
  id: "suppliers",
  title: "Поставщики",
  editableBy: "admin",
  settings: {
    supplier_lead_per_phone: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 3,
      description:
        "Сколько новых заявок на подключение можно отправить с одним номером телефона для одного БИН за окно (повтор той же заявки не считается); сверх — отказ с временем ожидания.",
    }),
    supplier_lead_per_phone_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: 7 * DAY,
      default: DAY,
      description: "Окно лимита заявок на подключение с одного номера.",
    }),
    supplier_lead_duplicate_window_minutes: define.duration({
      unit: "minutes",
      min: 0,
      max: 1440,
      default: 10,
      description:
        "Повтор той же заявки (тот же БИН и номер) в течение стольких минут не создаёт вторую заявку (двойное нажатие); 0 — не проверять.",
    }),
    supplier_lead_consent_version: define.string({
      maxLength: 50,
      default: "1",
      description:
        "Версия текста согласия на обработку персональных данных на форме заявки; записывается в заявку вместе со временем согласия.",
    }),
    supplier_invitation_resend_interval_minutes: define.duration({
      unit: "minutes",
      min: 1,
      max: 1440,
      default: 5,
      description:
        "Через сколько минут после предыдущего приглашения сотруднику можно отправить его снова.",
    }),
    supplier_invitations_per_member_day: define.integer({
      unit: "count",
      min: 1,
      max: 100,
      default: 5,
      description: "Сколько приглашений одному сотруднику можно отправить за скользящие 24 часа.",
    }),
    supplier_members_added_per_supplier_day: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 20,
      description:
        "Сколько сотрудников сотрудники одного поставщика могут добавить в кабинете за скользящие 24 часа; сверх — отказ с временем ожидания. Администратор не ограничен.",
    }),
  },
});

const offers = group({
  id: "offers",
  title: "Предложения поставщиков",
  editableBy: "admin",
  settings: {
    offer_price_min_kzt: define.integer({
      unit: "kzt",
      min: 1,
      max: 1_000_000,
      default: 1,
      description: "Наименьшая цена предложения поставщика, тенге.",
    }),
    offer_price_max_kzt: define.integer({
      unit: "kzt",
      min: 1,
      max: 2_000_000_000,
      default: 100_000_000,
      description:
        "Наибольшая цена предложения поставщика, тенге; защита от ошибки ввода (лишние нули).",
    }),
    offer_lead_days_max: define.duration({
      unit: "days",
      min: 1,
      max: 365,
      default: 90,
      description: "Наибольший срок предложения в рабочих днях с момента подтверждения заявки.",
    }),
    offer_item_search_per_member: define.integer({
      unit: "count",
      min: 1,
      max: 100_000,
      default: 60,
      description:
        "Сколько поисков позиции справочника один сотрудник поставщика может сделать за окно; сверх — отказ с временем ожидания (справочник целиком поставщику не выдаётся).",
    }),
    offer_item_search_per_member_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: 60,
      description: "Окно лимита поисков позиции справочника одним сотрудником.",
    }),
  },
});

/**
 * «Рекомендуемые» of the catalog (TASK-020; ARCHITECTURE 4.29): the
 * weights of the parts of `recommendedScore` (`@adclub/domain`) — the
 * price, the receipt date, an offer in the chosen city, a verified partner
 * and the rating of the supplier (TASK-050). Each from 0 to 100; not all zero.
 */
const recommendedWeightsSchema = z
  .strictObject({
    price: z.number().min(0).max(100),
    receipt: z.number().min(0).max(100),
    city: z.number().min(0).max(100),
    verified: z.number().min(0).max(100),
    rating: z.number().min(0).max(100),
  })
  .refine(
    (weights) =>
      weights.price + weights.receipt + weights.city + weights.verified + weights.rating > 0,
    { message: "At least one weight must be above 0" },
  );

const showcase = group({
  id: "showcase",
  title: "Каталог для пользователя",
  editableBy: "admin",
  settings: {
    catalog_recommended_weights: define.composite({
      schema: recommendedWeightsSchema,
      default: { price: 1, receipt: 1, city: 3, verified: 0.5, rating: 0.5 },
      description:
        "Веса сортировки «Рекомендуемые» в каталоге: цена (дешевле — выше), дата получения (раньше — выше), предложение в выбранном городе, «проверенный партнёр», рейтинг поставщика (звёзды ÷ 5; у «нового поставщика» — 0). Каждая часть — от 0 до 1, умножается на свой вес; по умолчанию предложение своего города выше остальных.",
    }),
  },
});

const publicLimits = group({
  id: "public_limits",
  title: "Открытые маршруты",
  editableBy: "admin",
  settings: {
    supplier_lead_per_ip: define.integer({
      unit: "count",
      min: 1,
      max: 100_000,
      default: 10,
      description:
        "Сколько заявок на подключение можно отправить с одного адреса (сети IPv6 /64) за окно; сверх — отказ с временем ожидания.",
    }),
    supplier_lead_per_ip_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: HOUR,
      description: "Окно лимита заявок на подключение с одного адреса.",
    }),
    compatibility_check_per_ip: define.integer({
      unit: "count",
      min: 1,
      max: 1_000_000,
      default: 120,
      description:
        "Сколько проверок совместимости без входа можно сделать с одного адреса за окно; сверх — отказ с временем ожидания.",
    }),
    compatibility_check_per_ip_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: 60,
      description: "Окно лимита проверок совместимости с одного адреса.",
    }),
    catalog_read_per_ip: define.integer({
      unit: "count",
      min: 1,
      max: 1_000_000,
      default: 300,
      description:
        "Сколько запросов каталога (список подкатегории и карточка позиции) без входа можно сделать с одного адреса (сети IPv6 /64) за окно; сверх — отказ с временем ожидания. Щедро: за одним адресом мобильного оператора много людей, а каталог не для выгрузки целиком.",
    }),
    catalog_read_per_ip_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: 60,
      description: "Окно лимита запросов каталога без входа с одного адреса.",
    }),
    catalog_read_per_account: define.integer({
      unit: "count",
      min: 1,
      max: 1_000_000,
      default: 120,
      description:
        "Сколько запросов каталога может сделать одна учётная запись с сессией за окно, с любого адреса; сверх — отказ с временем ожидания. Человек, быстро листающий каталог, делает в разы меньше.",
    }),
    catalog_read_per_account_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: 60,
      description: "Окно лимита запросов каталога одной учётной записью.",
    }),
    whatsapp_webhook_per_ip: define.integer({
      unit: "count",
      min: 1,
      max: 1_000_000,
      default: 600,
      description:
        "Сколько вебхуков провайдера сообщений принимается с одного адреса за окно; сверх — отказ с временем ожидания. Щедро: провайдер присылает события пачками и повторяет их, а настоящая защита маршрута — проверка подписи.",
    }),
    whatsapp_webhook_per_ip_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: 60,
      description: "Окно лимита вебхуков провайдера сообщений с одного адреса.",
    }),
    payment_webhook_per_ip: define.integer({
      unit: "count",
      min: 1,
      max: 1_000_000,
      default: 600,
      description:
        "Сколько вебхуков платёжной системы принимается с одного адреса за окно; сверх — отказ с временем ожидания. Настоящая защита маршрута — проверка подписи.",
    }),
    payment_webhook_per_ip_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: 60,
      description: "Окно лимита вебхуков платёжной системы с одного адреса.",
    }),
  },
});

/**
 * Messages to suppliers through the gateway (TASK-024, ARCHITECTURE 4.35).
 * The templates themselves are a registry of code, not settings: a text
 * changed here would no longer be the one Meta approved (SCREENS 8.5).
 */
const messages = group({
  id: "messages",
  title: "Сообщения поставщикам",
  editableBy: "admin",
  settings: {
    message_send_attempts: define.integer({
      unit: "count",
      min: 1,
      max: 20,
      default: 5,
      description:
        "Сколько раз сообщение поставщику пробуют отправить, если провайдер отвечает временной ошибкой; после этого сообщение попадает в мёртвую очередь и видно оператору. Постоянный отказ (шаблон не одобрен, номера нет в WhatsApp) не повторяется вовсе.",
    }),
    message_retry_delay_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: HOUR,
      default: 60,
      description:
        "Пауза перед повторной попыткой отправки; каждая следующая вдвое дольше (механизм очереди).",
    }),
    message_send_claim_seconds: define.duration({
      unit: "seconds",
      min: 10,
      max: 600,
      default: 120,
      description:
        "На сколько сообщение закрепляется за попыткой отправки: пока срок не прошёл, второй worker его не берёт. Попытка, прерванная остановкой процесса, после срока не отправляется повторно — сообщение помечается «неизвестно, ушло ли» и ждёт решения оператора.",
    }),
    message_body_max_length: define.integer({
      unit: "count",
      min: 100,
      max: 1024,
      default: 1024,
      description:
        "Предел длины текста шаблонного сообщения (у WhatsApp — 1024 символа). Сообщение, которое с подстановками длиннее, не отправляется: это видно оператору, а не обрезается молча.",
    }),
    message_variables_retention_days: define.duration({
      unit: "days",
      min: 1,
      max: 90,
      default: 7,
      description:
        "Сколько дней подстановки сообщения (в них бывают имя и телефон клиента) хранятся у сообщения, которое не удалось отправить: столько времени оператор может повторить отправку, потом остаётся только запросить событие заново. У отправленного сообщения подстановки стираются сразу.",
    }),
    webhook_event_retention_days: define.duration({
      unit: "days",
      min: 1,
      max: 365,
      default: 30,
      description:
        "Сколько дней хранятся записи о принятых вебхуках провайдера после обработки; тело события стирается сразу после применения.",
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
    billing_provider_retry_minutes: define.duration({
      unit: "minutes",
      min: 1,
      max: 1440,
      default: 60,
      description:
        "Через сколько минут повторяется списание, которое платёжная система не приняла (недоступна или ответ потерялся). Это не отказ банка: уведомления плательщику нет, дни повторов не тратятся.",
    }),
    billing_binding_minutes: define.duration({
      unit: "minutes",
      min: 5,
      max: 1440,
      default: 60,
      description:
        "Сколько минут открыта страница платёжной системы для привязки карты; после этого привязка считается брошенной.",
    }),
    payment_outage_signal_minutes: define.duration({
      unit: "minutes",
      min: 5,
      max: 1440,
      default: 60,
      description:
        "Сколько минут платёжная система не отвечает на списания, прежде чем администратор получит сигнал «Платёжная система недоступна».",
    }),
    billing_actions_per_member: define.integer({
      unit: "count",
      min: 1,
      max: 1000,
      default: 20,
      description:
        "Сколько раз один сотрудник поставщика может перейти к привязке карты или нажать «Оплатить сейчас» за окно; сверх — отказ с временем ожидания.",
    }),
    billing_actions_per_member_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: 600,
      description: "Окно лимита действий с оплатой одного сотрудника.",
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
    supplier_card_required: define.boolean({
      default: false,
      description:
        "Показывать предложения поставщика клиентам только после привязки карты (D-041). Выключено до подписок поставщиков; включение не меняет предложения и заявки — только видимость.",
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
      description:
        "Минимальная поддерживаемая версия сборки приложения на iOS — версия из App Store (ниже неё приложение не обслуживается). OTA-обновление её не меняет; поднимать — через несколько недель после выхода новой версии в сторе.",
    }),
    client_min_version_android: define.appVersion({
      default: "0.0.0",
      description:
        "Минимальная поддерживаемая версия сборки приложения на Android — версия из Google Play (ниже неё приложение не обслуживается). OTA-обновление её не меняет; поднимать — через несколько недель после выхода новой версии в сторе.",
    }),
    client_store_url_ios: define.string({
      maxLength: 500,
      default: "",
      allowEmpty: true,
      pattern: {
        regex: /^$|^https:\/\/apps\.apple\.com\/[^\s]+$/,
        message: "Адрес страницы приложения в App Store (https://apps.apple.com/…) или пусто",
      },
      description:
        "Страница приложения в App Store — кнопка «Откройте App Store» экрана «Нужно обновить приложение». Пусто — поиск приложения по названию.",
    }),
    client_store_url_android: define.string({
      maxLength: 500,
      default: "",
      allowEmpty: true,
      pattern: {
        regex: /^$|^https:\/\/play\.google\.com\/[^\s]+$/,
        message: "Адрес страницы приложения в Google Play (https://play.google.com/…) или пусто",
      },
      description:
        "Страница приложения в Google Play — кнопка «Откройте Google Play» экрана «Нужно обновить приложение». Пусто — поиск приложения по названию.",
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
      default: "almaty",
      reference: "city",
      description:
        "Город по умолчанию, если город не определён и не выбран: код активного города справочника (например, almaty); для совместимости принимается и его название.",
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

/** An empty value, or an address a phone opens in the browser. */
const WEB_ADDRESS = {
  regex: /^$|^https?:\/\/[^\s]+$/,
  message: "Адрес страницы (https://…) или пусто",
};

/**
 * What the app shows on «Документы и поддержка» (M-PRO-06) and where «Стать
 * партнёром клуба» leads (TASK-077): read by `GET /meta/club-info`. Empty —
 * the item is not shown at all (no placeholder), until the lawyer's texts
 * and the club's contact exist.
 */
const club = group({
  id: "club",
  title: "Документы и поддержка",
  editableBy: "admin",
  settings: {
    club_terms_url: define.string({
      maxLength: 500,
      default: "",
      allowEmpty: true,
      pattern: WEB_ADDRESS,
      description:
        "Адрес страницы «Условия использования» (M-PRO-06); пусто — пункта в приложении нет.",
    }),
    club_privacy_url: define.string({
      maxLength: 500,
      default: "",
      allowEmpty: true,
      pattern: WEB_ADDRESS,
      description:
        "Адрес страницы «Политика конфиденциальности» (M-PRO-06); пусто — пункта в приложении нет.",
    }),
    club_support_contact: define.string({
      maxLength: 500,
      default: "",
      allowEmpty: true,
      pattern: {
        regex: /^$|^\+7\d{10}$|^https:\/\/[^\s]+$/,
        message: "Номер +7XXXXXXXXXX, ссылка https://… (например, https://wa.me/7…) или пусто",
      },
      description:
        "«Связаться с клубом» (M-PRO-06): номер телефона (+7XXXXXXXXXX — позвонить или написать в WhatsApp) или ссылка https://…; пусто — пункта нет.",
    }),
    club_partner_form_url: define.string({
      maxLength: 500,
      default: "",
      allowEmpty: true,
      pattern: WEB_ADDRESS,
      description:
        "Адрес страницы «Станьте партнёром клуба» (S-PUB-01, /join кабинета); открывается из профиля приложения. Пусто — в разработке берётся кабинет на машине разработчика, в рабочей сборке пункта нет.",
    }),
  },
});

/** The admin panel's own limits (TASK-036.B): per administrator. */
const adminPanel = group({
  id: "admin_panel",
  title: "Админка",
  editableBy: "admin",
  settings: {
    admin_search_per_account: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 120,
      description:
        "Сколько поисков строки шапки админки один администратор может сделать за окно (поиск идёт по мере набора).",
    }),
    admin_search_per_account_window_seconds: define.duration({
      unit: "seconds",
      min: 10,
      max: DAY,
      default: 60,
      description: "Окно предела поиска в шапке админки.",
    }),
    phone_reveal_per_account: define.integer({
      unit: "count",
      min: 1,
      max: 10_000,
      default: 60,
      description:
        "Сколько полных номеров (кнопка «Показать номер») один администратор может открыть за окно — против выписывания номеров клуба подряд.",
    }),
    phone_reveal_per_account_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: DAY,
      default: HOUR,
      description: "Окно предела «Показать номер».",
    }),
    maintenance_draft_per_admin_day: define.integer({
      unit: "count",
      min: 1,
      max: 1_000,
      default: 10,
      description:
        "Сколько черновиков регламента ТО (кнопка «Сгенерировать черновик ИИ») один администратор может запросить за окно (TASK-061). Расход держит и общий дневной бюджет ИИ.",
    }),
    maintenance_draft_per_admin_day_window_seconds: define.duration({
      unit: "seconds",
      min: 60,
      max: DAY,
      default: DAY,
      description: "Окно предела черновиков регламента ТО (по умолчанию — сутки).",
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
    // TASK-022 (ARCHITECTURE 4.32).
    cleanup_order_idempotency_retention_days: define.duration({
      unit: "days",
      min: 1,
      max: 365,
      default: 30,
      description:
        "Через сколько дней после завершения заявки у неё очищается ключ повторной отправки (сама заявка и её журнал остаются).",
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
    session_refresh_per_web_session: define.integer({
      unit: "count",
      min: 1,
      max: 100_000,
      default: 300,
      description:
        "Сколько обновлений токенов одной сессии кабинета или админки допускается за окно: каждая перезагрузка страницы — обновление.",
    }),
    session_refresh_per_web_session_window_seconds: define.duration({
      unit: "seconds",
      min: 1,
      max: DAY,
      default: HOUR,
      description: "Окно лимита обновлений на сессию кабинета или админки.",
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
  garage,
  reminders,
  suppliers,
  offers,
  showcase,
  publicLimits,
  messages,
  billing,
  clients,
  club,
  adminPanel,
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
  ...garage.settings,
  ...reminders.settings,
  ...suppliers.settings,
  ...offers.settings,
  ...showcase.settings,
  ...publicLimits.settings,
  ...messages.settings,
  ...billing.settings,
  ...clients.settings,
  ...club.settings,
  ...adminPanel.settings,
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

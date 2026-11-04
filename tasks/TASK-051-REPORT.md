# TASK REPORT — TASK-051

## Status
PARTIAL — 8/9 AC (AC-7 «на телефоне» — NOT RUN: телефона в этой сессии нет; живая отправка FCM — BLOCKED до TASK-056, как и предусмотрено задачей)

## Result
Пользователь получает push о событиях своей заявки, отзыва и оплаты — по одному на событие, на языке учётной записи, с открытием заявки по нажатию:

- **Сервер.** Новый модуль `apps/api/src/modules/notifications`: порт `PushProvider` с тестовой реализацией (`TestPushProvider`, режимы `PUSH_TEST_MODE`) и настоящей (`FcmPushProvider` — FCM HTTP v1 на `fetch`, OAuth2 сервисного аккаунта через `node:crypto`); единственный вход `Notifications.enqueue(tx, …)` в транзакции события с ключом `dedupeKey`; журнал `notification` (одна строка на событие и получателя) и доставки по устройствам `notification_delivery`; отправка `PushSender` в три шага без открытой транзакции во время вызова провайдера; повторы, мёртвая очередь, `unknown` без второй копии, свипер прерванных попыток; токены устройств `device_token`, привязанные к сессии; ack; метрики; `/dev/pushes`; команды `push:list`, `push:retry`, `push:status`.
- **События** (таблица п. 4 задачи): принята (P-ORD-01), готова (P-ORD-02; у доставки — P-ORD-02a), резерв истекает (P-ORD-03), отказ (P-ORD-04), другой срок / время (P-ORD-05), закрыта по коду / поздно / администратором (P-ORD-06), поставщик не ответил (P-ORD-07), срок подтверждён (P-ORD-08), время подтверждено (P-ORD-09), срок поставки прошёл (P-ORD-10, наш текст), отзыв не опубликован (P-REV-01), проблема с оплатой подписки (P-SUB-01). Действия самого пользователя push не дают.
- **Приложение.** Порт push с изолированным `expo-notifications` и заглушкой для браузера и тестов; шторка M-PUSH-01 после M-ORD-01 (не больше двух раз на учётную запись на устройстве); регистрация токена; нажатие открывает M-ORD-03 (холодный старт — через `decideStart` правило 6); получение в открытом приложении обновляет копию заявок и открытый экран; экран заявки подтверждает свои push; строка «Уведомления» в профиле (M-PRO-04); «Сообщим, когда можно забирать» вернулось — только при разрешённых push.

## Changes
- **Контракт** — `packages/contracts/src/notifications.ts` (новый: `notificationKinds` — единый список видов, `pushTargetSchema`, тела и ответы), `routes.ts` (+4 маршрута: `PUT/DELETE /notifications/device-token`, `POST /notifications/{id}/ack`, `POST /orders/{orderId}/notifications/ack`), `openapi.ts` (компоненты), `apps/api/openapi.json` (перегенерирован, аддитивно).
- **Миграция** `infra/migrations/1791750000000_push-notifications.sql` — `device_token`, `notification`, `notification_delivery` с проверками; `testing/expected/migrations.ts`, `orm-tables.ts`, `testing/database.ts` (TRUNCATE), `schema-drift.test.ts`.
- **Модуль `notifications`** — `schema.ts`, `push-provider.ts`, `test-push-provider.ts`, `fcm-push-provider.ts`, `push-templates.ts`, `notifications.service.ts`, `push-sender.ts`, `push-jobs.ts`, `device-token-cleanup.ts`, `notifications.controller.ts`, `dev-pushes.controller.ts`, `notifications-admin.ts`, `notifications.module.ts`, `index.ts`; подключён в `app.module.ts`, `worker.module.ts`, `operator.ts`, `background-jobs.ts`, `testing/expected/background-jobs.ts` (+3 задачи), `openapi/check-served-routes.ts`.
- **События** — `orders/order-pushes.ts` (новый: `pushOfMove`, значения подстановок kk/ru/en, `OrderPushes`), `orders/order-transitions.ts` (вызов в `apply`, `warn`, `noteSupplyOverdue`), `orders/order-views.ts` (`supplierNameForUser`), `orders/orders.service.ts` + `orders.controller.ts` (ack по заявке), `orders.module.ts`, `order-deadlines.ts` (провайдеры worker'а), `reviews/reviews.service.ts` (P-REV-01), `billing/subscription-events.ts` (P-SUB-01).
- **Настройки** — `settings/registry/registry.ts`: виды `critical_notification_kinds` — из контракта (+`supply_overdue`, `review_text_rejected`); новые `push_send_attempts`, `push_retry_delay_seconds`, `push_send_claim_seconds`, `push_token_retention_days`, `push_unacked_window_hours`; `apps/admin-web/src/settings/setting-rules.ts` — слова двух новых видов.
- **Конфигурация** — `config/env.schema.ts` (`PUSH_PROVIDER`, `PUSH_TEST_MODE`, `FCM_*`, отказ production без FCM), `.env.example`.
- **Наблюдаемость** — `metrics.service.ts` (`adclub_push_notifications`, `adclub_push_deliveries`, `adclub_push_unacked_ratio`), `sanitizer.ts` (токен FCM и Expo в тексте).
- **Приложение** — `src/push/push-logic.ts`, `push-port.ts`, `stub-push-port.ts`, `native-push-port.ts`, `services/push.ts`, `state/push-provider.tsx`, `navigation/navigation-ref.ts` (новые); `App.tsx`, `RootNavigator.tsx`, `AppStart.tsx`, `root-start.ts`, `CheckoutScreen.tsx`, `OrderScreen.tsx`, `ProfileScreen.tsx`, `orders/order-status.ts`, `state/stores.ts`; словарь `packages/i18n/src/mobile/{ru,kk,en}.json` (+10 ключей); значок `bell` (Phosphor Light, `design/icons`, `packages/ui-core`).
- **Документы** — `ARCHITECTURE.md` 0.86: раздел 4.79 (I854–I864), 9.3, 14, I455, I612, I615, I752, строки 6.2/6.3; `CLAUDE.md` блок 0 — «Push пользователю в dev».

## Technical Decisions
Все внесены в ARCHITECTURE 4.79:
- **FCM напрямую, без SDK и без Expo Push Service** (I854) — меньше звеньев, токены не у третьей стороны; класс проверен только на подменённом `fetch`.
- **Уведомление — одна строка на событие и получателя, доставки по устройствам — отдельная таблица** (I856); статус уведомления выводится из доставок; ack любого устройства подтверждает уведомление.
- **Ключ дедупликации — от строки события** (версия заявки после перехода, срок резерва, версия отзыва и подписки) (I857): гонка двух сотрудников и повтор задачи дают одно уведомление.
- **Токен привязан к сессии через «жива ли сессия» при постановке и при захвате**, а не через перечень путей выхода (I859): любой способ конца сессии снимает устройство сразу, включая уже поставленные push.
- **«Поставщик» без клубного доступа — функция `supplierNameForUser` в `order-views.ts`** (I860); экран заявки по-прежнему показывает название (17.5).
- **Ack по заявке — отдельный маршрут** `POST /orders/{orderId}/notifications/ack` (I862), без перечня идентификаторов.
- **Баннер поверх открытого экрана той же заявки не показывается**, экран перечитывается (I864).

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS (0 ошибок; 1 старое предупреждение в `ratings/supplier-ratings.service.ts`, не из этой задачи)
- `pnpm typecheck` — PASS (20/20)
- `pnpm test` — PASS (19/19 задач; новые: `push-templates.test.ts`, `fcm-push-provider.test.ts`, `order-pushes.test.ts`, `apps/mobile/src/push/push-logic.test.ts`, push в `env.schema.test.ts`, `sanitizer.test.ts`, `root-start.test.ts`, `openapi.test.ts`)
- `pnpm build` — PASS (12/12)
- `pnpm icons --check` — PASS
- `openapi:generate` — выполнен; `openapi:check` — PASS; `openapi:compat --base HEAD` — PASS (обратно совместим)
- Интеграционные (Testcontainers):
  - `schema-drift`, `billing`, `on-order`, `order-notices`, `orders`, `service-orders`, `reviews` — PASS (общий прогон 9 файлов: эти 7 зелёные)
  - `database.integration.test.ts` + `notifications.integration.test.ts` — PASS, 66/66 (после двух исправлений: тест отката новой миграции; ожидание мёртвой очереди под нагрузкой)
  - `session`, `messaging` и прочие модули не менялись — не запускались локально, их прогонит CI

## UAT / E2E
Пройдено в браузере (встроенная панель скрыта, клики и ввод — через DOM и `form_input`), `.claude/launch.json` → `api-test-ai`, `worker`, `supplier-web`, `mobile-web` с временными `DATABASE_URL`/`S3_ENDPOINT` на 5433/9002 и `AI_PROVIDER=test`; тестовый номер `+77010000511` (клубный доступ — `club-access:grant`), сотрудник «Автомаркета» `+77055550101`:
1. Вход в приложении: номер → код с `/dev/login-codes` → имя и согласие. «Профиль» показывает «Уведомления · Выключены — статус заявок смотрите в приложении · Открыть настройки».
2. Каталог → «Тормоза» → «Тормозные колодки» → `04465-0K090` → «Оформить» у «Автомаркета» → «Оформить заявку» → экран заявки № 1120 и поверх него шторка «Уведомления о заявках · Сообщим, когда поставщик примет заявку и когда можно забирать · Включить · Не сейчас»; «Не сейчас» — `adclub.mobile.push-offers` = 1.
3. Вторая заявка (№ 1121, «Оформить ещё одну») — шторка снова, счёт 2; «Не сейчас».
4. Третья заявка (№ 1122) — шторки нет.
5. «Профиль → Уведомления» (заглушка отвечает «разрешено») → строка «Включены»; в `device_token` — токен заглушки за сессией приложения (`platform = android`, активен).
6. Принятие № 1120 сотрудником (API кабинета) → `/dev/pushes`: P-ORD-01 «Автомаркет принял заявку: Колодки тормозные передние 04465-0K090», доставка `sent`, токен `web-de…tub0`, `ackedAt: null`.
7. `__adclubPush.open(…)` с данными с `/dev/pushes` → открылся M-ORD-03 № 1120 «Поставщик принял заявку · Готовит товар. Сообщим, когда можно забирать», `acked_at` записан.
8. «Готово к выдаче» → P-ORD-02 «Можно забирать: … Резерв до 00:00, 8 ноября»; `__adclubPush.receive(…)` в открытом экране → экран сам перечитался («Можно забирать»), push подтверждён.
9. Принятие № 1121 кнопкой «Принять» **в UI кабинета** (`http://localhost:5175/orders/<id>`, вход по коду, выбор компании) → P-ORD-01 по № 1121; открытие этой заявки во вкладке «Заявки» приложения подтвердило её push (`acked_at`).
10. Ack из сессии кабинета — 403.

## Acceptance Criteria
- **AC-1 — PASS** — `notifications.integration.test.ts` (настоящие API и два worker'а): каждое событие п. 4 — ровно одно уведомление с текстом SCREENS 8.4 (русский дословно, `kk` — P-ORD-04, `en` — P-ORD-07, P-REV-01, P-SUB-01, P-ORD-09 в юнит-тесте), `target` на заявку; отмена и «Согласиться» пользователя — ни одного; гонка двух сотрудников (4 раунда) — одно; откат транзакции — нет строки; два одновременных `enqueue` одного события — одно; повтор задачи доставки — второй отправки нет. Результат прогона: 10/10 (отдельный запуск).
- **AC-2 — PASS** — тест «never lets a code, a QR, a phone, an address, an employee's name or a whole token out»: ни в `payload`, ни в отправленном провайдеру, ни в выводе процесса (`captureOutput`), ни в `push:list`; без клубного доступа — «Поставщик принял заявку…» при названии на экране заявки (17.5).
- **AC-3 — PASS** — тест токенов: два устройства получают оба; мёртвый токен — `invalid_token`, деактивирован, второй получил; после `logout` уведомление, поставленное до выхода, — `cancelled`, следующее — `no_device`; «Завершить на всех других» — второе устройство не получает; тот же токен с другим номером — переходит; уборка удаляет старый и помечает `session_ended`.
- **AC-4 — PASS** — `unavailable` — 2 попытки по настройке и мёртвая очередь, `push:retry` (`NotificationsAdmin.retry`) отправляет; `rejected` — 1 попытка; `unknown` — `unknown`, второй попытки нет; прерванная попытка — свипер ставит `unknown` без отправки; во время медленного вызова провайдера открытых транзакций нет, строка доставки берётся `FOR UPDATE` с `lock_timeout` 500 мс. `FcmPushProvider` — 6 юнит-тестов на подменённом `fetch`.
- **AC-5 — PASS** — тест ack: своё — 200 и `ackedAt`, повтор — тот же момент; чужое и несуществующее — 404; кабинет и админка — 403 (`FORBIDDEN`); гость — 401; `POST /orders/{id}/notifications/ack` — `{acked: 1}`, чужая заявка — 404; `/metrics` — `adclub_push_unacked_ratio`, `adclub_push_notifications{…}`.
- **AC-6 — PASS** — UAT выше, шаги 1–10.
- **AC-7 — NOT RUN** — телефона с Expo Go в этой сессии нет. Живая отправка через FCM — BLOCKED до TASK-056 (проекта Firebase нет).
- **AC-8 — PASS** — `ARCHITECTURE.md` 0.86 (4.79 I854–I864, 9.3, 14, I455, I612, I615, I752, 6.2/6.3); `CLAUDE.md` — «Push пользователю в dev».
- **AC-9 — PASS** — format:check, lint, typecheck, test, build и интеграционные изменённых модулей зелёные (см. «Verification»); push в `main` без ожидания CI.

## Errors & Fixes
- Nest падал при инициализации (exit 134) — схемы новых ответов не были в `componentSchemas` OpenAPI; добавлены.
- В `PushSender` попытка считалась дважды (захват возвращал уже увеличенный счётчик) — «попытки кончились» на первой; исправлено.
- Скрипт вставки ключей словаря через `JSON.stringify` стёр пустые строки-разделители в JSON словаря — откат и вставка построчно.
- `database.integration.test.ts`: тесты отката рассчитаны на «последнюю миграцию» — добавлен тест миграции push, два соседних теста получили по лишнему `down`.

## Deviations
- **«Поставщик» без подписки только в push.** SCREENS 8.4 требует «Поставщик» без подписки, а `order-views.ts` показывает пользователю название поставщика его заявки и после конца доступа (edge case 17.5). Правило вынесено в одну функцию `order-views.ts` (`supplierNameForUser`), экран заявки не менялся — push читается на заблокированном экране.
- **P-SUB-01 открывает профиль**, а не M-SUB-02 — экрана нет до TASK-041 (задача это предусмотрела).
- **Фонового обработчика push нет** (требование 6 «где платформа будит»): для него нужен `expo-task-manager`, которого нет в зависимостях; ack приходит при получении в открытом приложении, при нажатии и при открытии заявки, неотправленные — при следующем возврате. Предлагается вместе с TASK-056 (сборка с FCM).
- **Строка «push: есть» во вкладке «Сессии» админки** не сделана (в задаче — по желанию).
- **В M-PRO-04 нет отдельного экрана** — строка профиля «Уведомления» с состоянием и «Открыть настройки»; нажатие открывает системный запрос, пока система может спросить, иначе — системные настройки.

## Known Issues / Risks
- `FcmPushProvider` ни разу не вызывался вживую; разбор ошибок — по документации FCM (`errorCode`), без проверки на настоящих ответах.
- Expo Go не даёт токен FCM на Android (и на iOS без dev-сборки) — на телефоне в Expo Go push не придёт; это ожидаемо и не ошибка.
- Казахские и английские тексты push и шторки — рабочие, казахский требует проверки носителем языка.
- `.claude/launch.json` менялся временно (порты 5433/9002, `AI_PROVIDER=test`) и возвращён перед коммитом.

## Remaining Work
- AC-7: проверка на телефоне (системный запрос после первой заявки; отсутствие токена в Expo Go) — при наличии телефона.
- Живая отправка через FCM и фоновый обработчик — TASK-056; резерв WhatsApp, `push_unreliable` — TASK-052.

## Новые тексты на утверждение Product Owner
Push (kk — рабочий перевод; ru/en):
| ID | Событие | ru | kk | en |
|---|---|---|---|---|
| P-ORD-02a | Готово, доставка (резерва нет) | Заказ готов: {позиция} | Тапсырыс дайын: {позиция} | Your order is ready: {item} |
| P-ORD-05 (срок) | Другой срок | Поставщик предлагает срок до {дата}. Ответьте до {время} | Жеткізуші {дата} дейінгі мерзімді ұсынады. {время} дейін жауап беріңіз | The supplier proposes a term until {date}. Reply by {time} |
| P-ORD-05 (время) | Другое время | Поставщик предлагает {дата} в {время}. Ответьте до {время} | Жеткізуші {дата}, сағат {время} уақытын ұсынады. {время} дейін жауап беріңіз | The supplier proposes {date} at {time}. Reply by {time} |
| P-ORD-10 | Срок поставки прошёл (отправляется) | Срок поставки прошёл: {позиция}. Свяжитесь с поставщиком | Жеткізу мерзімі өтті: {позиция}. Жеткізушімен байланысыңыз | The delivery term has passed: {item}. Contact the supplier |

Тексты SCREENS 8.4 на kk и en (переводы наши): все P-ORD-01…09, P-REV-01, P-SUB-01 — в `apps/api/src/modules/notifications/push-templates.ts`.

**Не отправляются — предлагаемые тексты** (после утверждения — одна строка в `pushOfMove` и шаблон):
| Событие | Предлагаемый текст (ru) |
|---|---|
| Резерв истёк (`expire_reserve`) | Резерв закончился: {позиция}. Если ещё нужно — оформите заявку снова |
| Истекло время ответа клиента на другой срок / время (`expire_term`) | Вы не ответили на предложение поставщика — заявка отменена |
| Отмена администратором (`admin_cancel`) | Заявка отменена администратором клуба: {позиция} |
| Время записи прошло без отметки (`expire_visit`) | Время записи прошло: {услуга}. Если вы были у поставщика — сообщите нам |

Приложение: шторка M-PUSH-01 — заголовок «Уведомления о заявках» (kk «Өтінімдер туралы хабарламалар», en «Order notifications»), кнопки «Включить» / «Не сейчас»; M-PRO-04 — «Уведомления», «Включены», «Выключены — статус заявок смотрите в приложении», «Открыть настройки»; M-ORD-03 с push — «Готовит товар. Сообщим, когда можно забирать», «Сообщим, когда можно забирать» (kk и en — в словаре).

## Future Improvements
- «push: есть» у устройства во вкладке «Сессии» карточки пользователя в админке.
- Фоновый обработчик (`expo-task-manager`) для ack и обновления копии без открытия приложения.
- Канал уведомлений Android «Заявки» с локализованным названием.

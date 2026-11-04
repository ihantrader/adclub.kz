# TASK REPORT — TASK-052

## Status
COMPLETED — 9/9 AC (оговорки — в Known Issues: живой отправки в WhatsApp нет и быть не может, шаблоны U-* ждут утверждения Product Owner и Meta)

## Result
Критичное push-уведомление пользователю, которое приложение не подтвердило за `push_ack_timeout_minutes` (или которому некуда было уйти), теперь дублируется **одним** WhatsApp-сообщением через существующий шлюз сообщений — только по видам из `critical_notification_kinds`, только пока событие актуально, только если у человека есть WhatsApp:

- **Правило одно** — чистая функция `fallbackDecision` (`apps/api/src/modules/notifications/fallback-rule.ts`) с юнит-таблицей на все строки таблицы п. 1 задачи. Её спрашивают `Notifications.enqueue` (сразу: нет устройства, отказ всех устройств, сессия кончилась, «push ненадёжен») и свипер `notifications.fallback` раз в минуту (таймаут). Решение пишется на push (`fallback_decision`: `sent`, `acked`, `superseded`, `not_current`, `not_critical`, `stale`, `no_whatsapp`, `rate_limited`, `render_failed`).
- **Резерв** — строка `notification` с `channel = whatsapp` и `fallback_of_id` (уникально) плюс сообщение шлюза `Messaging.enqueue` в той же транзакции (`dedupeKey` от копии). Шлюз перед отправкой спрашивает субъект `notification` (`stillSend`): push вытеснен более поздним по той же заявке, подтверждён или номер оказался без WhatsApp — сообщение отменяется. Статусы сообщения (`sent`, `failed`, `unknown`, `cancelled`, а по вебхуку — `delivered`, `read`) отражаются на копии.
- **Шаблоны пользователю U-*** — 14 записей реестра шлюза на kk и ru (по одной на каждый push-текст SCREENS 8.4), содержимое — ровно подстановки push.
- **«Push ненадёжен»** — три критичных push подряд без подтверждения по таймауту → следующие копируются сразу при постановке; любой ack снимает; число — `push_unreliable_after`.
- **«Нет WhatsApp»** — последнее решающее слово о номере: код входа подтверждён по SMS или шлюз ответил `no_whatsapp` — нет; код через WhatsApp или доставленное сообщение — снова есть. Такому пользователю резерв не ставится, SMS не отправляется.
- **Видно:** приложению — `whatsappAvailable` в `GET /account/profile` и вторая строка M-PRO-04 / T-PRO-03; администратору — строки «WhatsApp» и «Push» в карточке пользователя и отбор «Нет WhatsApp»; оператору — `push:status`, `push:list`, `/dev/pushes`; метрики и сигнал «Push не доходит до пользователей».

## Changes
- **Правило и исполнение** — `notifications/fallback-rule.ts` (+`fallback-rule.test.ts`), `notifications/push-fallback.ts` (`PushFallbacks`, `PushFallbackSweep`, `PushFallbackShareWatch`, задачи `notifications.fallback` и `notifications.watch-fallback-share`, субъект шлюза `notification`), `notifications.service.ts` (вызов правила из `enqueue`, `fallbackVariables`, сброс счётчика в `ack`/`ackSubject`, счётчики резерва, `channel = 'push'` в прежних подсчётах), `notifications.module.ts`, `push-jobs.ts`, `notifications-admin.ts`, `dev-pushes.controller.ts`, `push-sender.ts` (тип), `schema.ts`, `index.ts`.
- **«Есть ли WhatsApp»** — `identity/account/whatsapp-reach.ts` (новый; экспорт из `identity/index.ts`), `account-profile.service.ts` (`whatsappAvailable`).
- **Шлюз** — `messaging/message-templates.ts` (14 шаблонов `user_*`), `message-subjects.ts` (необязательный `onDelivery`), `messaging.service.ts` (`applyDeliveryStatus` возвращает статус и субъект), `webhook-events.service.ts` (вызов `onDelivery`), `message-templates.test.ts`.
- **События** — `orders/order-pushes.ts` (`orderPushCurrent` — «верно ли ещё событие заявки», регистрация в `NotificationSubjects`; русские подстановки для получателя с английским), `billing/subscription-events.ts` (P-SUB-01 актуально, пока подписка в `grace`), `reviews/reviews.service.ts` (русская причина); `notifications/notification-subjects.ts` — реестр.
- **Миграция** `infra/migrations/1791800000000_push-fallback.sql` — `notification.fallback_decision`, `fallback_decided_at`, `outbound_message_id`, проверки связи копии и статусов, уникальный `fallback_of_id`, индекс ждущих решений, `outbound_message_phone_idx`, таблица `notification_recipient_state`; `testing/expected/migrations.ts`, `testing/expected/background-jobs.ts` (+2 задачи), `testing/database.ts` (TRUNCATE), `database/schema-drift.test.ts`, `database/database.integration.test.ts` (тест миграции; два прежних теста откатывают на шаг больше).
- **Настройки** — `settings/registry/registry.ts`: `push_fallback_max_age_hours`, `push_fallback_per_account_day`, `push_unreliable_after`, `push_fallback_signal_share`, `push_fallback_signal_min`.
- **Контракт (аддитивно)** — `packages/contracts/src/account.ts` (`whatsappAvailable`), `users.ts` (отбор `noWhatsapp`, `notifications` карточки), `signals.ts` (вид `push_fallback_high`, `PUSH_FALLBACK_SUBJECT_ID`, поля полезной нагрузки); `apps/api/openapi.json` перегенерирован.
- **Админка** — `users/Users.tsx` (флажок «Нет WhatsApp»), `users/UserCard.tsx` (строки «WhatsApp», «Push»), `users/user-words.ts` (+тесты), `signals/signal-words.ts` (вид сигнала).
- **Приложение** — `screens/tabs/ProfileScreen.tsx` (вторая строка «Уведомлений»), `packages/i18n/src/mobile/{ru,kk,en}.json` (+2 ключа).
- **Наблюдаемость** — `observability/metrics.service.ts`: `adclub_push_fallbacks`, `adclub_push_fallback_ratio`, `adclub_push_recipients`.
- **Тесты** — `notifications.integration.test.ts` (+6 сценариев TASK-052), `users/admin-users` (без изменений, прошёл), `account-profile.integration.test.ts` (новое поле профиля).
- **Документы** — `ARCHITECTURE.md` 0.88: раздел 4.80 (I867–I878), 5 (`notification`), 9.3, 14, I866; `CLAUDE.md` блок 0 — «Резерв WhatsApp для пользователя в dev».

## Technical Decisions
Все внесены в ARCHITECTURE 4.80:
- **Решение принимается один раз и пишется на push** (I867); «ждать» не пишет ничего, свипер просматривает ждущие строки один раз за проход (I868).
- **Отдельного статуса `fallback_sent` нет** (раздел 5 задумывал): связка `fallback_of_id` + статус копии + `fallback_decision` у push (I870). `delivered`/`read` разрешены только копии.
- **Гонки I865 нет:** `messaging.send` — не singleton, задача ставится в транзакции и видна только после коммита — постановка в транзакции оставлена (I869); три одновременных прохода и откат проверены тестом.
- **«Актуально» = нет более позднего push того же субъекта тому же получателю** (I867, I871); тот же критерий — в `stillSend`.
- **«Нет WhatsApp» не хранится** — читается из уже записанных `phone_verification.channel` и исходов `outbound_message` (I874): ставится и снимается самими фактами, второго пути нет. Код — в модуле identity (его факт — канал кода входа), чтобы и профиль, и уведомления брали одну SQL-функцию без циклических импортов.
- **«Push ненадёжен» — счётчик подряд в `notification_recipient_state`, порог — при чтении** (I873): изменение `push_unreliable_after` действует сразу.
- **Английских шаблонов WhatsApp нет:** получатель с `en` получает русский шаблон с русскими подстановками (`payload.fallbackVariables`, I872).
- **Лимит суток** — 30 резервных сообщений на учётную запись (I876); сверх — решение `rate_limited` и предупреждение в журнале процесса, событие не ошибается.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS (1 предупреждение — `isNotNull` в `ratings/supplier-ratings.service.ts`, не из этой задачи)
- `pnpm typecheck` — PASS (20/20)
- `pnpm test` — PASS (19/19 задач Turborepo); в API — юнит-таблица правила (27 строк + 3 проверки), реестр шаблонов U-*, ключи настроек против раздела 14, ORM против схемы
- `pnpm build` — PASS (12/12)
- `pnpm --filter @adclub/api openapi:generate` — выполнен, изменение аддитивное
- Интеграционные (Testcontainers):
  - `notifications.integration.test.ts` — PASS (16/16; из них 6 сценариев TASK-052, после правок ревью)
  - `database.integration.test.ts` — PASS (вместе с предыдущим — 73/73)
  - `account-profile.integration.test.ts` — PASS
  - `admin-users.integration.test.ts` — PASS
  - `messaging.integration.test.ts`, `order-notices.integration.test.ts`, `login-code.integration.test.ts` — PASS (142/142)
- CI — запущен прогон 41876253314 (push `3d76727`), результат не ожидался (CLAUDE.md 11)

## UAT / E2E
Окружение: dev-база проекта (PostgreSQL :5433, MinIO :9002), API и worker — временная конфигурация `.claude/launch.json` (`api-test-ai`, `worker-test-ai` с `AI_PROVIDER=test` и портами 5433/9002; возвращена перед коммитом), кабинет `supplier-web`, приложение `mobile-web`; тестовый провайдер push и тестовый канал сообщений; только тестовые номера `+77010000521`, `+77010000522` (клубный доступ выдан `club-access:grant`), сотрудник «Автомаркета» `+77055550101`. `push_ack_timeout_minutes` = 1 на время проверки, после — `settings:reset`.

1. **Принятие без ack → резерв через минуту.** Номер `+77010000521` вошёл через WhatsApp, зарегистрировал устройство (`PUT /notifications/device-token`), оформил заявку **№ 1126**; сотрудник «Автомаркета» нажал **«Принять» в кабинете** (`/orders/c3306fbb-…`, «Принял Ерлан, 21:51»). Push P-ORD-01 `52f3f445-…` — `sent` в 16:51:36 UTC, ack не было. В 16:53:26 свипер записал решение `sent`, появилась копия `channel = whatsapp` с `fallbackOfId = 52f3f445-…`, на `/dev/messages` — сообщение `313aa7f0-…`: `template: user_order_accepted`, `screen: U-ORD-01`, `status: sent`, текст «Asia Drive Club: Автомаркет принял заявку: Колодки тормозные задние Chery Tiggo 7 Pro MAN90274. Подробнее — в приложении». То же раньше по заявке **№ 1124** (принята API кабинета в 16:45:51, push `2832313c-…` отправлен 16:45:52, копия `c93a2cd6-…` и сообщение `c6b88c3e-…` — в 16:47:27); на `/dev/pushes` копия стоит строкой рядом с исходной.
2. **M-PRO-04 с WhatsApp.** Вход `+77010000521` в приложении (код через WhatsApp) → «Профиль» → «Уведомления»: «Выключены — статус заявок смотрите в приложении» и второй строкой «Если push не дойдёт, важное продублируем в WhatsApp».
3. **Вход по SMS → T-PRO-03.** Выход, вход `+77010000522` через «У меня нет WhatsApp» (код по SMS, канал `sms` на `/dev/login-codes`), «Как вас зовут?» → «Профиль»: вторая строка «WhatsApp не подключён — важные события смотрите в приложении». Заявка **№ 1125** этого номера, принятая API кабинета в 16:50:54: push `sent`, через минуту решение `no_whatsapp`, копии и сообщения нет.
5. **Повтор на коде после правок ревью** (worker перезапущен, миграция перенакачена): заявка **№ 1127** принята в 17:08:33, push `sent` 17:08:33, решение `sent` в 17:10:28, сообщение `a7fed2ff-…` `user_order_accepted` (U-ORD-01) — `sent` тестовым каналом в 17:10:30.
4. **Оператор и метрики** на dev после сценария: `push:status` — `fallback.share {criticalPushes: 6, fallbacks: 2}`, `decisions {sent: 2, no_whatsapp: 1, acked: 3, not_critical: 3}`, `withoutWhatsapp: 1`; `/metrics` — `adclub_push_fallbacks{kind="order_accepted",status="sent"} 2`, `adclub_push_fallback_ratio 0.33…`, `adclub_push_recipients{state="no_whatsapp"} 1`.

Не проходилось в браузере: админка (отбор «Нет WhatsApp» и строки карточки) — проверены интеграционным тестом через API и юнит-тестами слов; push в браузерном порте не включался (разрешение `granted` не давалось, устройство регистрировалось запросом).

## Acceptance Criteria
- **AC-1 — PASS** — `fallback-rule.test.ts`: строка на каждый случай таблицы п. 1 (sent без ack до и после таймаута, ack, `no_device`, `failed`, `unknown` с временем и без, `queued` до и после таймаута, `cancelled`, ненадёжный, без WhatsApp, некритичный, вытесненный, старше окна, лимит). Интеграционный «copies an unconfirmed critical push once after the timeout…»: таймаут 1 мин, время — сдвигом `sent_at`; три одновременных прохода (оба worker'а и API) и ещё один — ровно одна копия и одно сообщение `user_order_accepted` с `fallback_of_id`; ack до таймаута — `acked`, копии нет; некритичный — `not_critical`; включённый в список вид — со следующего прохода. «copies only the latest event…»: принята → готова → закрыта — копия только `user_order_closed`, у принятой `superseded`; без устройства — копия в транзакции события; откат прохода — ни копии, ни сообщения, ни решения.
- **AC-2 — PASS** — «carries only what the push carries…»: у копии без клубного доступа `supplier: "Поставщик"`; в подстановках копий, тексте и подстановках сообщений `user_*` нет кодов, QR, телефонов (кроме номера, на который отправляет шлюз), адреса, района, названия компании, имени сотрудника; журнал процесса не содержит номера (плюс общий `captureOutput` файла по всем запомненным номерам и кодам). Реестр: юнит-тест разрешает U-* только подстановки push (`supplier, item, until, time, date, answerBy, reason`).
- **AC-3 — PASS** — «marks an unreliable push after three in a row…»: три таймаута → `unackedStreak 3`, `pushUnreliableSince`; четвёртое — копия сразу после «Принять», до таймаута; ack — `{unackedStreak: 0, pushUnreliableSince: null}`, пятое без копии; `push_unreliable_after = 1` — одно неподтверждённое и следующее сразу; `push:status.fallback.pushUnreliable = 1`.
- **AC-4 — PASS** — «knows a person without WhatsApp…»: вход по SMS → `whatsappAvailable: false`, в `/admin/users?noWhatsapp=true`, карточка `whatsapp {available: false, source: "login_code"}`, push `no_device` и решение `no_whatsapp` без копии; вход через WhatsApp снимает; отказ шлюза `no_whatsapp` → копия `failed`, профиль `false`, `source: "message"`, следующее — `no_whatsapp`; `GET /account/profile` сессией кабинета и админки — 403 `FORBIDDEN`. В браузере — пункт 3 UAT.
- **AC-5 — PASS** — «the gateway refuses a copy gone stale…»: шлюз недоступен, заявку закрыли — копия «принята» `cancelled` (и её сообщение), копия «закрыта» после восстановления `sent`, одно сообщение покупателю; `rejected` → копия `failed`; `outcome_unknown` → `unknown`, `MessagingAdmin.retry` (`messages:retry`) → `sent`; лимит суток → решение `rate_limited`, в журнале «Push fallback refused: the daily limit», принятие заявки прошло.
- **AC-6 — PASS** — UAT пункты 1–3 (идентификаторы и время выше).
- **AC-7 — PASS** — `/metrics`: `adclub_push_fallbacks`, `adclub_push_fallback_ratio`, `adclub_push_recipients` (интеграционный тест и dev); `push:status` — доля, решения, копии, `pushUnreliable`, `withoutWhatsapp`; сигнал `push_fallback_high` при доле выше порога — один открытый после двух проходов, при пороге 1 — закрыт сам.
- **AC-8 — PASS** — `ARCHITECTURE.md` 0.88: 4.80 (I867–I878), 5, 9.3, 14, I866; `CLAUDE.md` блок 0 — «Резерв WhatsApp для пользователя в dev».
- **AC-9 — PASS** — Verification выше; push в `main` без ожидания CI.

## Errors & Fixes
- **Независимое ревью диффа (агент без моих выводов) нашло три дефекта — исправлены:**
  1. *Некритичный push глушил критичный:* «готово к выдаче» (не в списке) через минуту после «принята» делало «принята» вытесненным, и человек не получал WhatsApp вовсе. Теперь вытесняет только более поздний push **критичного** вида (`push-fallback.ts`); тест «quick: принята → готова» — копия «принята» уходит.
  2. *«Актуально» не смотрело на саму заявку:* отмена пользователем или администратором, конец резерва, оплата в льготный период push не дают — и копия «принята» ушла бы к отменённой заявке. Добавлен реестр `NotificationSubjects` с ответом модуля-владельца (`orderPushCurrent` для заявок, `grace` для подписки) — и в правиле (`not_current`), и в `stillSend`; юнит-таблица и интеграционный «отменена пользователем — `not_current`».
  3. *Выкладка:* все push TASK-051 стали бы кандидатами на резерв за последние сутки. Миграция помечает их `stale`.
  Попутно: `notification.created_at` по умолчанию — `clock_timestamp()` (порядок внутри одной транзакции); доля резерва не считает отменённые шлюзом копии. Оставлено (низкий риск, записано ниже): лимит суток не атомарен между путём события и свипером; метрика-gauge не обнуляет исчезнувшие пары меток.
- **«Вытеснено» считало вытесняющей саму строку.** Сравнение `(created_at, id) > (дата из JS, id)`: у JS-даты нет микросекунд, и собственное `created_at` строки оказывалось «позже» — все push решались `superseded`. Теперь строка сравнивается со своим временем из базы подзапросом (`push-fallback.ts`). Поймал интеграционный тест.
- **DI worker'а:** `PushFallbackShareWatch` требует `AdminSignals`, модуль сигналов не глобальный — провайдеры `AdminSignals` и `AccountDirectory` добавлены в `NotificationJobsModule`, как в модуле заявок.
- **Тест миграций** откатывает по одной миграции на тест: добавлен тест новой миграции первым в цепочку, два теста с явными откатами после `up` получили по шагу больше.

## Deviations
- Раздел 5 задумывал статусы `fallback_sent`/`skipped` у `notification` и 9.3 — флаг `user_profile.whatsapp_available`; сделано иначе и записано (I870, I874): решение на push + статус копии; «нет WhatsApp» выводится из фактов.
- Сигнал — отдельная периодическая задача `notifications.watch-fallback-share` (кроме свипера `notifications.fallback`, названного в задаче).
- «Ограничение частоты — 429-подобный отказ в журнале»: журнал здесь — сама строка уведомления (`fallback_decision = rate_limited`, журнал уведомлений раздела 5) и журнал процесса; записи в `audit_log` нет — это не действие человека.

## Known Issues / Risks
- **Живой отправки нет.** Шаблоны U-* Meta не одобряла; проверено тестовым каналом.
- **Фонового ack нет (I862, TASK-056):** пока приложение не открыто, push «не подтверждён», и резерв уйдёт через таймаут даже по дошедшему push; у человека, который не открывает приложение, после трёх таких — «push ненадёжен», и критичное копируется сразу. Это стоит денег (по ориентиру — до `push_fallback_per_account_day` в сутки на человека); до TASK-056 стоит держать `push_ack_timeout_minutes` по умолчанию (10) и следить за `adclub_push_fallback_ratio`.
- Строка M-PRO-04 видна, когда профиль сессии прочитан; холодный запуск без сети до первого чтения профиля показывает только первую строку.
- `review_text_rejected` ставится с субъектом `order` (TASK-051): если администратор включит его в список критичных, отказ текста отзыва вытеснит ещё не решённый резерв «заявка закрыта» той же заявки. На практике между ними больше таймаута.
- Лимит `push_fallback_per_account_day` не атомарен: путь события и свипер одновременно могут превысить его на одно-два сообщения (ревью; при щедром умолчании безвредно). Gauge `adclub_push_fallbacks` не обнуляет пары меток, которых больше нет.

## Remaining Work
None.

## Future Improvements
- Экран A-USR-02 мог бы показывать историю резервных сообщений человека (сейчас — только оператору).
- Учитывать резерв в `adclub_push_unacked_ratio` раздельно по платформам, когда появится фоновый ack.

## Тексты на утверждение Product Owner
**Шаблоны WhatsApp пользователю (U-*, utility, без кнопок; ru — основной, kk — рабочий, на проверку носителем):**

| ID | Вид | ru | kk |
|---|---|---|---|
| U-ORD-01 | принята (P-ORD-01) | Asia Drive Club: {supplier} принял заявку: {item}. Подробнее — в приложении | Asia Drive Club: {supplier} өтінімді қабылдады: {item}. Толығырақ — қосымшада |
| U-ORD-02 | готова (P-ORD-02) | Asia Drive Club: можно забирать: {item}. Резерв до {until}. Подробнее — в приложении | Asia Drive Club: алып кетуге болады: {item}. Резерв {until} дейін. Толығырақ — қосымшада |
| U-ORD-02a | готова, доставка (P-ORD-02a) | Asia Drive Club: заказ готов: {item}. Подробнее — в приложении | Asia Drive Club: тапсырыс дайын: {item}. Толығырақ — қосымшада |
| U-ORD-03 | резерв заканчивается (P-ORD-03) | Asia Drive Club: резерв заканчивается в {time}: {item}. Подробнее — в приложении | Asia Drive Club: резерв сағат {time} аяқталады: {item}. Толығырақ — қосымшада |
| U-ORD-04 | отказ (P-ORD-04) | Asia Drive Club: поставщик отказал по заявке: {item}. Другие предложения — в приложении | Asia Drive Club: жеткізуші өтінім бойынша бас тартты: {item}. Басқа ұсыныстар — қосымшада |
| U-ORD-05 | другой срок (P-ORD-05) | Asia Drive Club: поставщик предлагает срок до {date}. Ответьте в приложении до {answerBy} | Asia Drive Club: жеткізуші {date} дейінгі мерзімді ұсынады. {answerBy} дейін қосымшада жауап беріңіз |
| U-ORD-05a | другое время (P-ORD-05) | Asia Drive Club: поставщик предлагает {date} в {time}. Ответьте в приложении до {answerBy} | Asia Drive Club: жеткізуші {date}, сағат {time} уақытын ұсынады. {answerBy} дейін қосымшада жауап беріңіз |
| U-ORD-06 | закрыта (P-ORD-06) | Asia Drive Club: заявка закрыта: {item}. Не получали? Сообщите нам в приложении | Asia Drive Club: өтінім жабылды: {item}. Алмадыңыз ба? Қосымшада бізге хабарлаңыз |
| U-ORD-07 | не ответил (P-ORD-07) | Asia Drive Club: поставщик не ответил вовремя — заявка отменена. Другие предложения — в приложении | Asia Drive Club: жеткізуші уақытында жауап бермеді — өтінім тоқтатылды. Басқа ұсыныстар — қосымшада |
| U-ORD-08 | срок подтверждён (P-ORD-08) | Asia Drive Club: поставщик подтвердил срок: до {date}. Подробнее — в приложении | Asia Drive Club: жеткізуші мерзімді растады: {date} дейін. Толығырақ — қосымшада |
| U-ORD-09 | время подтверждено (P-ORD-09) | Asia Drive Club: ждём вас {date} в {time}, {supplier}. Подробнее — в приложении | Asia Drive Club: сізді {date}, сағат {time} күтеміз, {supplier}. Толығырақ — қосымшада |
| U-ORD-10 | срок поставки прошёл (P-ORD-10) | Asia Drive Club: срок поставки прошёл: {item}. Свяжитесь с поставщиком из приложения | Asia Drive Club: жеткізу мерзімі өтті: {item}. Жеткізушімен қосымша арқылы байланысыңыз |
| U-REV-01 | отзыв не опубликован (P-REV-01) | Asia Drive Club: отзыв не опубликован: {reason}. Исправить можно в приложении | Asia Drive Club: пікір жарияланбады: {reason}. Қосымшада түзетуге болады |
| U-SUB-01 | проблема с оплатой (P-SUB-01) | Asia Drive Club: не удалось оплатить подписку. Обновите способ оплаты в магазине приложений, чтобы сохранить доступ | Asia Drive Club: жазылымды төлеу мүмкін болмады. Қолжетімділікті сақтау үшін қосымшалар дүкенінде төлем тәсілін жаңартыңыз |

Подпись «Asia Drive Club:» — по D-048; если Meta потребует, её можно вынести в заголовок шаблона.

**Строки приложения (M-PRO-04):** `profile.notificationsWhatsapp` — ru «Если push не дойдёт, важное продублируем в WhatsApp» (SCREENS дословно), kk «Push жетпесе, маңыздысын WhatsApp-қа қайталап жібереміз», en «If a push doesn't arrive, we'll send the important ones to WhatsApp»; `profile.notificationsNoWhatsapp` (T-PRO-03) — ru «WhatsApp не подключён — важные события смотрите в приложении» (дословно), kk «WhatsApp қосылмаған — маңызды оқиғаларды қосымшадан қараңыз», en «WhatsApp isn't connected — check important events in the app».

**Слова админки:** отбор «Нет WhatsApp»; карточка — «WhatsApp: есть — важное дублируется, если push не дошёл» / «нет с {дата} (вход по SMS | номер не в WhatsApp) — резерва нет, события только в приложении»; «Push: подтверждается» / «подтверждается; без подтверждения подряд: N» / «не подтверждается с {дата} — важное сразу уходит в WhatsApp»; сигнал «Push не доходит до пользователей» — «в WhatsApp ушло N из M важных push · P % · порог T % · за H часов · с {дата}», подсказка «Большая доля важных уведомлений пользователям уходит резервом в WhatsApp: приложение не подтверждает push. Проверьте провайдера push и последнюю версию приложения. Сигнал закроется сам, когда доля снизится.»

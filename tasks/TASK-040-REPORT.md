# TASK REPORT — TASK-040

## Status
COMPLETED — 13 из 13 AC (результат CI проверяет архитектор, номер прогона — в разделе Verification).

## Result
Сервер умеет главное правило PRODUCT 14: каталог, цены и характеристики свободны, а создание заявки, код и название поставщика доступны только с клубным доступом. Доступ теперь даёт ручная выдача **или** подписка; потребители этого не замечают.

- **Статус подписки и его автомат.** Одна таблица переходов в домене (`subscriptionTransition`) для событий провайдера (`started`, `renewed`, `grace_started`, `payment_failed`, `suspended`, `cancelled`, `cancel_withdrawn`, `expired`, `refunded`, `revoked`) и событий времени (`period_lapsed`, `grace_lapsed`, `tolerance_lapsed`).
  - Статусы пользователя: `active`, `grace`, `cancelled`, `expired_unconfirmed`, `suspended`, `expired`.
  - Статусы поставщика заложены (`active`, `past_due`, `cancelled`, `suspended`, `expired`), применит TASK-042.
- **Даёт ли статус доступ** — одна чистая функция `subscriptionAccess`. Таблица «статус → доступ» записана в ARCHITECTURE 4.72:
  - `active` — до конца срока + допуск;
  - `grace` — до конца льготного периода стора + допуск;
  - `cancelled` — до конца оплаченного срока;
  - `expired_unconfirmed` — 48 часов (`store_lag_tolerance_hours`) от момента, когда срок прошёл без слова стора (U-5);
  - `suspended`, `expired`, `past_due` — нет.
- **Клубный доступ из двух источников.** `ClubAccess.stateOf` / `has` / `statesOf` и SQL-двойник `clubAccessUntil` учитывают подписку.
  - Граница — дальняя из двух; источник — чья граница дальше, при равенстве `subscription`.
  - В контракте `source` аддитивно получил `subscription`.
  - Ничего не кэшируется: прекращение видно со следующего запроса.
- **События** идут через `billing_event`:
  - идемпотентно по id события у провайдера;
  - применяются фоновой задачей на покупку в порядке времени события;
  - событие старше последнего применённого — без эффекта (`stale`), продление без нового срока — без эффекта (`no_change`);
  - чужая покупка — `refused: linked_to_another_account`; вторая подписка при действующей — `refused: already_active`.
  - Свипер времени переводит срок без слова стора в `expired_unconfirmed`, после допуска — в `expired`. Позднее продление восстанавливает `active` задним числом.
  - Каждый ход записывается в журнал действий: `subscription.changed` с «кто» — `provider` / `operator` / `system`.
- **`GET /me/subscription`** (мобильная сессия): статус, «даёт ли доступ», «статус не подтверждён», срок, доступ до, льготный до, провайдер, тариф, объявленное изменение с текстом `price_increase_notice_text`, ручная выдача отдельным полем. Гость получает 401, кабинет и админка — 403.
- **Тарифы** хранятся записями `plan` с датами.
  - Две функции домена: `planInEffect` («действует на дату») и `announcedPlan` («объявлено»).
  - Команды оператора `billing:plan:add` и `billing:plan:list`, каждая запись — в журнал (`plan.added`).
  - Поставщику тариф и анонс отдаёт `GET /supplier/subscription`.
- **D-041 за переключателем** `supplier_card_required` (по умолчанию выключено):
  - новая причина витрины `card_not_linked` в `offerVisibility` и её SQL-двойник в `shownOffers()`;
  - признак «карта привязана» — `supplier.card_linked_at`, ставит только `dev:supplier:card` (development/test);
  - в кабинете — причина словами и баннер T-SUP-02, в админке — среди причин.
- **Тестовый провайдер:** порт `SubscriptionProvider` с реализацией `TestSubscriptionProvider` (без внешних вызовов) и команды `dev:subscription:event` (development/test) и `subscription:status`.
- **Админка:**
  - во вкладке «Клубный доступ» карточки пользователя — блок «Подписка» (статус словами, оплачено до, доступ до, провайдер, история событий с итогом) и рядом «Выдача вручную»;
  - отбор «клубный доступ есть / нет / истекает» учитывает подписку, в строке списка — «по подписке».
- **Попутно:** тест `jobs` «never runs a singleton job twice…» сам поднимает оба worker'а, если запущен один (`-t`).

## Changes
- **Домен** — `packages/domain/src/subscription/`:
  - `subscription-machine.ts` — автомат и `dueTimeEvent`;
  - `subscription-access.ts` — доступ и `combineClubAccess`;
  - `plans.ts` — тарифы;
  - `purchase-link.ts` — «чья покупка»;
  - юнит-тесты к каждому;
  - `offer/offer-visibility.ts` — факты `cardRequired` / `cardLinked` и причина `card_not_linked`.
- **Контракт** — `packages/contracts`:
  - `subscriptions.ts` — ответы `/me/subscription`, `/supplier/subscription`, `/admin/users/{id}/subscription`;
  - `club-access.ts` — `source: subscription`;
  - `offers.ts` — причина `card_not_linked`;
  - `error.ts` — `SUBSCRIPTION_LINKED_TO_ANOTHER_ACCOUNT`, `SUBSCRIPTION_ALREADY_ACTIVE` (их вернут маршруты покупки TASK-041);
  - `audit.ts` — `subscription.changed`, `plan.added`, `supplier.card_changed`, сущности `subscription`, `plan`;
  - три маршрута в `routes.ts`.
- **Миграция** `infra/migrations/1791500000000_subscriptions.sql`: `plan`, `subscription` (одна текущая подписка на учётную запись и на компанию — частичные уникальные индексы), `billing_event`, `supplier.card_linked_at`.
- **Сервер** — модуль `apps/api/src/modules/billing`:
  - `subscription-events.ts` — приём, применение, свипер;
  - `subscription-provider.ts` — порт и тестовый провайдер;
  - `subscription-views.ts`, `plans.service.ts`, `supplier-cards.ts`, `billing-operator.ts`, `billing-jobs.ts`, `billing.module.ts`.
  - Подключение: `app.module.ts`, `worker.module.ts`, `operator.ts`, `background-jobs.ts`, `orm-tables.ts`.
- **Доступ** — `club-access/club-access.ts` (два источника, `untilSql`); описание таблицы `subscription` — в `club-access/schema.ts`.
- **Витрина** — `offers/offer-showcase.ts`: переключатель читается самим SQL в `offerShowcase` и `shownOffers`; `supplierCardRequired` для сводки кабинета.
- **Настройка** `supplier_card_required` в группе «Подписки и оплата».
- **Админка:** `users/subscription-words.ts`, `users/UserCard.tsx`, `users/Users.tsx`, `audit/audit-words.ts`, `catalog/catalog-words.ts`.
- **Кабинет:** `offers/offer-rules.ts`, `offers/OffersList.tsx`, тексты kk/ru/en в `packages/i18n/src/supplier`.
- **Тесты и списки:**
  - `billing/billing.integration.test.ts`, `billing/subscription-provider.test.ts`;
  - миграция в `database.integration.test.ts`, таблицы в `schema-drift.test.ts`, `TRUNCATE_ALL`;
  - `testing/expected/*` (маршрут `/admin`, три задачи `billing.*`, миграция);
  - вес файла в `integration-weights.json`;
  - `jobs.integration.test.ts` — попутный тест.
- **Документы:** `ARCHITECTURE.md` 0.74, `CLAUDE.md` блок 0 — «Подписки в dev» и строка «Тесты».

## Technical Decisions
Все решения внесены в ARCHITECTURE.md 0.74, раздел 4.72 (таблица «статус → доступ», I773–I786).

- **`expired_unconfirmed` даёт доступ в пределах допуска, затем `expired`** (по TASK-040 и U-5). Прежний текст 9.4.1 п. 7 и 17.21 ставил этот статус после допуска с закрытием доступа — исправлено.
- **`cancelled`** — продление выключено, доступ до конца оплаченного срока, потом `expired` без ожидания стора.
- **`suspended`** нужен: стор может вернуть подписку из «on hold».
- **Правило доступа читает моменты, а не статус свипера.** Подписка, у которой срок прошёл минуту назад, даёт тот же ответ до прохода свипера и после — проверено юнит-тестом.
- **Источник при двух** — тот, чья граница дальше; при равенстве — подписка.
- **`validUntil` подписки** — момент, когда доступ кончится без нового слова стора. У `active` это конец срока + допуск, поэтому в списке админки «до 06.11» при подписке до 04.11.
- **Порядок событий** — по времени события, а не прихода. Событие старше последнего применённого — `stale`, без отката.
- **Признак карты** — колонка `supplier.card_linked_at`, а не таблица `payment_method`: процессора и токенов ещё нет. TASK-042 будет держать колонку вместе с картой.
- **Переключатель D-041 читает сам SQL-запрос** (`app_setting`, иначе умолчание) и в функции, и в двойнике. Поэтому они не расходятся, вызывающие не менялись, изменение действует сразу. Сводка кабинета читает его тем же выражением.
- **Описание Drizzle таблицы `subscription`** — в `club-access/schema.ts`: это второй источник, который читает `ClubAccess`, а `billing` сам зависит от `ClubAccess`. Иначе был бы цикл импортов или обход публичного входа модуля, который запрещает линтер.
- **Свипер делает один ход подписки за прогон.** Двойной ход (`expired_unconfirmed` → `expired`) происходит следующим прогоном через минуту; доступ при этом закрыт сразу по правилу.
- **Несостыковки документа закрыты:**
  - 5.10 — статус `expired_unconfirmed`, оборванная фраза, «как реализовано»;
  - 9.4.1 — п. 7 и «как реализовано без стора»;
  - 8.4 — `grace`, а не `past_due`, для пользователя;
  - 17.9d — настройки `billing_provider_outage_hours` нет;
  - 17.21, 13.2, 14.

## Verification
- `pnpm --filter @adclub/domain test` (подписки и витрина) — PASS — 194 теста, в том числе все пары «аудитория × статус × событие».
- `pnpm format:check` — PASS (после последней правки).
- `pnpm lint` — PASS: 0 ошибок, одно предупреждение в `ratings/supplier-ratings.service.ts` (неиспользуемый `isNotNull`, было до задачи).
- `pnpm typecheck` — PASS.
- `pnpm test` — PASS (итоговый прогон: 19/19 задач Turborepo). В промежуточном прогоне один раз упал по таймауту 5 с тест мобильного `no-catalog-without-car.test.ts` (сканирует файлы; машина была нагружена сборкой и чужими контейнерами); мобильный код не менялся, отдельно и в итоговом прогоне — PASS.
- `pnpm build` — PASS.
- `openapi:generate` + `openapi:check` — PASS; `openapi:compat --base HEAD` — PASS без трейлера.
- Все пять команд и openapi — повторены после последней правки кода, все PASS.
- Интеграционные (Testcontainers, по одному файлу):
  - `billing` — PASS 10/10 (≈108 с);
  - `database` — PASS 50/50 (после правки проверки `public.subscription`: у pg-boss есть своя таблица `pgboss.subscription`);
  - `schema-drift` — PASS 2/2;
  - `showcase` — PASS 28/28;
  - `offers` — PASS 37/37;
  - `admin-users` — PASS 12/12;
  - `admin-panel` — PASS 13/13;
  - `catalog` — PASS 19/19;
  - `settings` — PASS 16/16;
  - `orders` — PASS 75/75;
  - `reviews` — PASS 15/15 (в первом прогоне 4 таймаута хука `beforeEach` при перегруженном Docker; повтор — зелёный);
  - `jobs` — PASS 22/22 (дважды: до и после правки singleton-теста);
  - `jobs -t "never runs a singleton job twice"` в одиночку — PASS три прогона подряд.
- CI: прогон `38770397647` (пуш `8e2264e` в `main`; результат не ждал, по правилам TASK-076 — проверяет архитектор).

## UAT / E2E
**Dev, запросами** (API и worker с тестовым ИИ, тестовый номер `+77010000365` без ручной выдачи, «Автомаркет», сотрудник `+77055550101`):
1. Без доступа поставщик в карточке позиции — `{"kind":"hidden","reason":"subscription_required"}`, `POST /orders` — 403 `SUBSCRIPTION_REQUIRED`.
2. `billing:plan:add --audience user --code user-month --price 490 --from 2026-10-01 --announce-days 7`, затем `dev:subscription:event +77010000365 started --until +30d`.
   - Следующий запрос: поставщик `{"kind":"visible","name":"Автомаркет",…}`.
   - `POST /orders` — 201, заявка № 1081 с кодом.
   - `GET /me/subscription` — `active`, `grantsAccess: true`, `statusConfirmed: true`, `accessUntil` = конец срока + 48 ч, `plan {user-month, 490, KZT, month}`, `access.source: subscription`.
3. Срок на час назад, `jobs:run billing.expire-subscriptions`:
   - `expired_unconfirmed`, `statusConfirmed: false`, `grantsAccess: true`, поставщик виден;
   - срок −49 ч и снова `jobs:run` → строка `expired`, `GET /me/subscription` — `subscription: null`, доступа нет;
   - новый `POST /orders` — 403 `SUBSCRIPTION_REQUIRED`;
   - уже оформленная заявка (`GET /orders/{id}`) — 200, поставщик «Автомаркет», код есть; поставщик в каталоге снова скрыт.
4. `billing:plan:add … user-month-2 --price 690 --from 2026-10-22 --announce-days 7` → `GET /me/subscription` → `announcedPlan {user-month-2, 690, validFrom 2026-10-21T19:00Z, notice "Стоимость подписки меняется. Новая цена начнёт действовать со следующего периода."}`.
5. D-041:
   - `settings:set supplier_card_required true` — гость больше не видит предложение «Автомаркета»;
   - в кабинете `GET /supplier/offers` — `showcase {visible:false, reasons:["card_not_linked"]}`;
   - `dev:supplier:card <id> --linked` — предложение снова видно гостю, в кабинете `visible: true`;
   - `settings:reset` и `--unlinked` — всё как было, предложение видно.
   - Найдено и исправлено: сводка `GET /supplier/subscription` сразу после включения говорила `cardRequired: false` (кэш настроек 30 с) — теперь читает переключатель тем же SQL, что и витрина.

**Админка в браузере** (`localhost:5174`, свой тестовый администратор `+77010000361`):
- Карточка пользователя `+77010000365` → «Клубный доступ»: блок «Подписка» — «Закончилась · доступа не даёт», «Оплачено до», «Тестовый провайдер» и история (оформлена оператором, «срок прошёл без подтверждения» и «подтверждение не пришло» системой, со статусами «было → стало» и итогом «применено»); «Выдача вручную — действующей выдачи нет».
- После `renewed --until +20d`:
  - отбор «Истекает в ближайшие 30 дней» показывает пользователя — «до 06.11.2026 по подписке»;
  - отбор «Нет» — «Всего: 0».
- С включённым D-041 «Предложения» карточки «Автомаркета» — «нет: карта не привязана (D-041)» у всех 19 предложений.

**Кабинет в браузере** (`localhost:5175`, `+77055550101`, «Автомаркет»): «Предложения» — баннер «Привяжите карту, чтобы предложения появились на витрине» и у каждого предложения «Не видно клиентам: карта не привязана — …».

После проверок `supplier_card_required` возвращён в умолчание («выключено»), карта «Автомаркета» снова не привязана; `login_code_resend_interval_seconds` = 5, `login_code_requests_per_phone` = 100 не менялись. Все запущенные мной dev-серверы остановлены.

## Acceptance Criteria
- **AC-1 — PASS.** `packages/domain/src/subscription/subscription-machine.test.ts` перебирает все пары «аудитория × статус × событие» явной таблицей ходов (в том числе время), `subscription-access.test.ts` — таблица случаев доступа и «до свипера = после».
- **AC-2 — PASS.**
  - `billing.integration.test.ts`, «gives in SQL what the function gives» — 17 случаев на одних данных: `stateOf` = `statesOf` = `clubAccessUntil`, в том числе «ручная до 31.12 и подписка до 15.11 → ручная».
  - «answers every consumer the same…» — при подписке без выдачи: каталог (поставщик), `POST /orders`, «Повторить», `/suppliers/{id}/reviews`, `/catalog/offers/{id}/supplier`, отборы админки `active` / `expiring` / `none`.
  - После окончания — 403 на новую заявку, а карточка заявки с кодом и `/active-orders` остаются.
- **AC-3 — PASS.** Интеграционные «applies a purchase once…» (повтор id, `no_change`, `stale`, возврат, журнал), «applies the pending events of one purchase in the order of their time», «refuses a purchase of another account…», «keeps access…» и «time (U-5)» (`expired_unconfirmed` с доступом, после допуска `expired`, позднее продление, события `system` и журнал).
- **AC-4 — PASS.** Интеграционный «tells the status, the access, the tariff and the announced change…»: тариф, анонс с казахским текстом, второе устройство, 401 гостю, 403 админке и кабинету; dev-сценарий, шаги 2 и 4.
- **AC-5 — PASS.** `plans.test.ts` («цена на завтра и `announce_before_days` 7 — объявлена сегодня, действует завтра» и др.); `Plans.add` с журналом `plan.added` и отказом в дубле — интеграционный тест и dev-шаг 2.
- **AC-6 — PASS.** Интеграционный «the showcase after a card is linked»: `offerShowcase` = `shownOffers` = каталог при выключенном / включённом переключателе, без карты и с картой; причина в «Моих предложениях» и в `/admin/suppliers/{id}/offers`; журнал карты. Домен — `offer-visibility.test.ts`. Браузер — кабинет и админка (UAT).
- **AC-7 — PASS.** Браузер: блок «Подписка» с историей и отбор «клубный доступ» с подпиской (UAT); интеграционный «the admin card».
- **AC-8 — PASS.** Сценарий «Что должно реально работать» пройден запросами, ответы — в UAT.
- **AC-9 — PASS.** Две причины:
  - тест брал воркеры, которые поднимает первый тест блока, — теперь при запуске с `-t` он поднимает их сам;
  - в одиночном прогоне свежий воркер начинал опрос позже фиксированных 1,5 с, и задачи забирал другой. Теперь в фазе «опрашивает только один» задачи предлагаются, пока этот воркер действительно не выполнит одну (до 30 с), — проверка не ослаблена.
  - Итог: в одиночку PASS три прогона подряд, весь файл — PASS 22/22.
- **AC-10 — PASS.** `openapi:compat --base HEAD` без трейлера, `openapi:check` PASS.
- **AC-11 — PASS.** ARCHITECTURE 0.74 (4.72, 5.10, 9.4.1, 8.4, 17.9d, 17.21, 13.2, 14), CLAUDE.md «Подписки в dev».
- **AC-12 — PASS.** Локальные проверки — Verification.
- **AC-13 — PASS.** Этот отчёт; прогон CI `38770397647` — в Verification.

## Errors & Fixes
- **Зависание `beforeEach` в интеграционном тесте подписок** в одном из прогонов. По `pg_stat_activity`: пять чужих свиперов воркера (цены, сообщения, фото) висели «idle in transaction» после минутной отметки, а в журнале были `Query read timeout` — Docker был нагружен чужими контейнерами (aqadyr-test, sezonpodarkov). TRUNCATE ждал их блокировок. Не воспроизвелось в следующих прогонах; логика задачи к этому не причастна, но риск записан ниже.
- **Тест свипера** ждал два хода за прогон — прогон делает один (партия меньше размера завершает прогон). Тест исправлен, ARCHITECTURE I780 уточнён.
- **Лишние параллельные запросы.** `ClubAccess.sourcesOf` и `statesOf` выполняли параллельно два запроса на одном исполнителе (это может быть транзакция вызывающего). Сделано последовательно.
- **Цикл импортов.** Линтер запретил `club-access` импортировать внутренности `billing`, а импорт через публичный вход дал бы цикл. Описание таблицы `subscription` перенесено в `club-access/schema.ts`.
- **Сводка кабинета** расходилась с витриной до 30 с после включения D-041 — исправлено (см. UAT).
- **Проверка отката миграции** находила `pgboss.subscription` вместо нашей таблицы — теперь проверяется `public.subscription`.
- **Singleton-тест в одиночку** однажды упал уже после первой правки (все задачи забрал первый воркер) — добавлено ожидание реального выполнения у единственного опрашивающего воркера (AC-9).
- **Дубль тарифа в тесте** создавался с другим моментом и не отказывал — тест исправлен (один момент на оба).

## Deviations
- **Статусы поставщика** (`past_due`, `suspended`) заложены в автомате и базе, но не применяются — их применит TASK-042, как и сказано в задаче.
- **В 5.10 вместо `subject_type/subject_id`** — `audience` и `account_id`/`supplier_id` с внешними ключами; вместо `cancel_at_period_end` — статус `cancelled`; `environment`, `suspended_at`, `last_provider_sync_at`, `store_product_ids` не созданы (только для TASK-041/042, «лишнего не создавать»).
- **Признак карты ставится только командой**, администратором — нет (так сказано в задаче).
- **Сигнал `store_sync_stale`, опрос API стора и push о проблеме оплаты** — TASK-041 (без настоящего провайдера их нечем проверить).

## Known Issues / Risks
- **Свиперы других модулей и загруженный Docker.** Если запросы упираются в `query_timeout` (2 с), их транзакции могут оставаться открытыми, и `TRUNCATE` в интеграционных тестах ждёт. Это не связано с подписками, но может давать редкие таймауты хуков на перегруженной машине.
- **`validUntil` подписки включает допуск.** В админке «до 06.11» при оплаченном сроке до 04.11 — так работает правило (доступ действительно до 06.11, если стор промолчит). Экраны TASK-041 / TASK-043 могут показывать и `periodEnd`.
- **Тарифы в базе по умолчанию отсутствуют** — их заводит оператор: цены — решение Product Owner.
- **В dev-базе после проверок остались тестовые данные:** тарифы `user-month` (490, с 01.10) и `user-month-2` (690, с 22.10, объявлен); у `+77010000365` подписка тестового провайдера до ~04.11 и две заявки «Автомаркета».

## Remaining Work
None.

## Future Improvements
- Убрать пред-существующее предупреждение линтера в `ratings/supplier-ratings.service.ts` (`isNotNull`).
- Сделать свиперы устойчивыми к `query_timeout` внутри транзакции (явный откат при ошибке клиента) — отдельная задача про надёжность фоновых задач.

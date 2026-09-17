# TASK REPORT — TASK-004

## Status
COMPLETED — 14/14 AC. CI на `main` зелёный (run 35184331403). Цикл «расхождение схемы → красный CI → откат → зелёный CI» воспроизведён на временном PR.

## Result
- **Запрос кода** — `POST /auth/login-code` `{ phone, channel? }`.
  - Номер приводится к виду E.164. `+7 701 …`, `8 (701) …`, `87011234567`, `7011234567` — один и тот же номер.
  - Принимаются только мобильные номера Казахстана. Российский, городской, иностранный номер или мусор — `VALIDATION_ERROR`, код не отправляется.
  - Ответ: `{ phone, channel, codeLength, expiresAt, resendAvailableAt }`. Он одинаков, есть аккаунт с этим номером или нет: таблица `account` при запросе кода не читается.
- **Проверка кода** — `POST /auth/login-code/verify` `{ phone, code }` → `{ status: "verified", phone }`.
  - Код одноразовый. Не принимаются: повторный ввод, истёкший код, код после исчерпания попыток, код другого номера, код, заменённый более новым.
  - Сессий пока нет. TASK-005 выдаст сессию в этом же запросе и добавит её поля в ответ (решение — ARCHITECTURE 4.5 I34).
- **Каналы и резерв.** Сначала WhatsApp. Если он вернул ошибку доставки — SMS. `channel: "sms"` — сразу SMS: это и явный выбор, и кнопка «не пришло».
  - Повторный код любым каналом — не раньше интервала (60 с). Раньше — ошибка с временем ожидания, новый код не создаётся.
  - Если ни один канал не доставил код — `LOGIN_CODE_DELIVERY_FAILED` (503, `retryable`). Человек может сразу повторить: интервал и счётчики запросов не расходуются.
  - Каналы пока тестовые, реальные провайдеры подключаются в TASK-026 без изменения логики.
- **Защита от перебора и накрутки.**
  - До 5 попыток на код. Первые 2 ошибки — без задержки, дальше ожидание 2, 4, 8… с.
  - Проверок на номер — 15 в час.
  - Выдач кода: 5 в час на номер, 30 в час на IP.
  - SMS: 5 в сутки на номер, 10 в сутки на IP.
  - Превышение — HTTP 429 `RATE_LIMITED`, `retryable: true`, `details { limit, retryAfterSeconds }` и заголовок `Retry-After`.
- **Redis недоступен** — выдача и проверка кода отвечают 503 `SERVICE_UNAVAILABLE` (`retryable: true`), без лимитов код не выдаётся. Сервер не падает. После возврата Redis запросы проходят без перезапуска.
- **Код в dev.** Отправленные коды видны в браузере: `http://localhost:3000/dev/login-codes` (последние 20). Этот адрес есть только в development/test. Production не стартует ни с тестовыми каналами, ни с этим адресом. Ошибку WhatsApp имитирует `LOGIN_CODE_TEST_FAILING_CHANNELS=whatsapp`.
- **Журнал** фиксирует: запрос, доставку и её ошибку с причиной, переход на SMS, успешную и неуспешную проверку, срабатывание лимита, отказ из-за Redis. Номер — только маской `+7***1234`, кода нет.
- **Канал подтверждения** последнего кода сохраняется по номеру в таблице `phone_verification`.
- **Пороги** — переменные `LOGIN_CODE_*` (проверяются при старте). Сервис читает их через `LoginCodeSettingsSource`; в TASK-007 этот провайдер заменит таблица настроек.
- **Долг T-5 закрыт.** `pnpm test:integration` (и CI) сравнивает Drizzle-описание таблиц с базой после всех миграций: лишние и отсутствующие таблицы и колонки, тип, обязательность.

## Changes
- **`packages/domain`:** `phone/kz-mobile-phone.ts` — `normalizeKzMobilePhone`, `maskPhone`, тесты.
- **`packages/contracts`:**
  - `login-code.ts` — схемы тел и ответов, `details` ошибок, имена лимитов;
  - `error.ts` — пять новых кодов;
  - `routes.ts` — `requestBody` в `ApiRouteDefinition`, маршруты `requestLoginCode`/`verifyLoginCode`, тип `ApiRouteRequestBody`;
  - `openapi.ts` — `requestBody` в документе, новые компоненты, тег `auth`.
- **`packages/api-client`:** маршрут с телом вызывается как `client.requestLoginCode(body, options?)`; тесты.
- **`apps/api`:**
  - `src/modules/identity/login-code/` — сервис, хранилище (транзакции, блокировки), контроллер, каналы (`LoginCodeChannels`, `TestLoginCodeChannels`, dev-ящик и его контроллер), источник порогов, HMAC и задержка (`login-code.crypto.ts`), ключ лимита по IP (IPv6 → /64), юнит- и интеграционные тесты;
  - `src/modules/identity/schema.ts` — таблицы `otp_challenge`, `phone_verification`, список `identityTables`; `identity.module.ts` — `IdentityModule.forRoot(config)`;
  - `src/redis/rate-limiter.service.ts` — счётчики фиксированного окна и замок на Redis, отказ при недоступности;
  - `src/common/errors/api.exception.ts` — `ApiException` (статус, код, `details`, заголовки); фильтр ошибок доработан;
  - `src/common/contract/api-route.decorator.ts` — код успешного ответа из контракта (200 вместо 201 для POST);
  - `src/config/env.schema.ts` — `TRUST_PROXY`, `LOGIN_CODE_*`, запреты для production; тесты;
  - `src/http-app.ts` — `trust proxy` и CORS (для `main.ts` и тестов);
  - `src/openapi/route-listing-config.ts` — конфигурация для сверки маршрутов; `check-served-routes.ts` исключает `/dev/login-codes`;
  - `src/database/schema-drift.ts`, `schema-drift.test.ts`, `schema-drift.integration.test.ts`, `src/orm-tables.ts` — сверка схемы;
  - `src/database/migrate-cli.ts` — запуск миграций из тестов; `database.integration.test.ts` учитывает две миграции;
  - `openapi.json` перегенерирован; dev-зависимость `@testcontainers/redis`.
- **`infra/migrations/1789620211794_create-login-code.sql`** — `otp_challenge` (статусы, ограничения, частичный уникальный индекс «один действующий код»), `phone_verification`; откат удаляет обе таблицы.
- **`.env.example`** — `TRUST_PROXY`, все `LOGIN_CODE_*` с пояснениями.
- **`ARCHITECTURE.md`** 0.8 — раздел 4.5 (I32–I43), уточнены 4.2 I11, 5.1, 8.1, 14. **`CLAUDE.md`**, блок 0 — как увидеть код в dev, новые переменные, состав `test:integration`, правило про `orm-tables.ts`.

## Technical Decisions
Все решения внесены в ARCHITECTURE.md, раздел 4.5.
- **Результат проверки для TASK-005 (I34).** Промежуточного «токена подтверждения» нет. `verifyCode()` возвращает `VerifiedPhone { phone, channel, challengeId }` ровно один раз — код гасится в той же транзакции. TASK-005 выдаёт сессию внутри этого же запроса. Лишний предъявительский секрет не нужен.
- **Хранение (I33).** В базе только HMAC кода с секретом `LOGIN_CODE_HASH_SECRET` и id вызова. Секрет обязателен вне development/test: простой хэш шестизначного кода перебирается мгновенно.
  - Единственность действующего кода гарантирует частичный уникальный индекс и блокировка по номеру при активации.
  - Однократность успеха — блокировка строки при проверке.
- **Интервал повторной отправки общий для всех каналов (I35).** Он же не даёт одновременным запросам одного номера создать два кода. Если код не доставлен, интервал и счётчики запросов возвращаются. Попытка SMS остаётся в дневном счётчике: деньги могли быть потрачены.
- **Лимиты при недоступном Redis — отказ (I36).** Команда при неготовом соединении или дольше 1 с даёт 503.
- **Значения лимитов по умолчанию выбраны мной (I36).** ARCHITECTURE 8.1 и 14 задавали только длину кода, срок жизни, число попыток и интервал 30–60 с (взято 60 с). Остальные значения внесены в раздел 14 как ключи будущих настроек.
- **Код в dev показывается отдельным адресом, а не полем ответа API (I38).** Так клиентский код не может случайно начать опираться на код из ответа. Фильтра по номеру нет: номер в URL попал бы в журнал доступа.
- **Production-конфигурация отклоняется в `loadConfig` (I39).** Проверка маршрутов для OpenAPI использует конфигурацию staging, выданную за production: набор маршрутов тот же.
- **Сверка схемы (I41)** — собственный код на `getTableConfig` и `pg_attribute`, а не `drizzle-kit`. Сравниваются ровно четыре требуемых свойства. Новая таблица должна быть добавлена в `apps/api/src/orm-tables.ts`, иначе проверка сообщит о лишней таблице.

## Verification
- `pnpm format:check` — PASS.
- `pnpm lint` — PASS (10/10 задач).
- `pnpm typecheck` — PASS (15/15).
- `pnpm test` — PASS: domain 51, contracts 47, i18n 8, api-client 17, mobile 19, api 128.
- `pnpm test:integration` — PASS, 53 теста:
  - `login-code.integration.test.ts` — 43;
  - `database.integration.test.ts` — 8;
  - `schema-drift.integration.test.ts` — 2.
- `pnpm build` — PASS (10/10, включая экспорт мобильного бандла).
- `pnpm --filter @adclub/api openapi:check` — PASS.
- `pnpm --filter @adclub/api openapi:compat --base HEAD` (локально, до коммита) — PASS: «No breaking changes».
- Миграции на dev-базе: `migrate` → `migrate:status` (2 применены) → `migrate:down` (удалены `phone_verification`, `otp_challenge`; 1 ожидает) → `migrate` — PASS.
- Старт в production:
  - `NODE_ENV=production node dist/main.js` → `LOGIN_CODE_CHANNELS: test channels are not allowed when NODE_ENV=production`, код выхода 1 — PASS;
  - с `LOGIN_CODE_DEV_OUTBOX=true` дополнительно сообщает о `LOGIN_CODE_DEV_OUTBOX` — PASS.
- **CI на GitHub Actions, `main`** — PASS: run 35184331403 (https://github.com/ihantrader/adclub.kz/actions/runs/35184331403), коммит `9653333`, статус и шаги получены через `gh run watch`/`gh run view`.
  - Все шаги зелёные, в том числе Integration test (43 + 8 + 2 теста на Linux), OpenAPI check, «Contract is backward compatible with c56db71».
- **CI, воспроизведение расхождения схемы** (PR #2, ветка `ci/schema-drift-demo`, в ORM добавлена колонка `phone_verification.note` без миграции):
  - run 35184368428 — FAIL на шаге Integration test с сообщением `ORM schema and migrations disagree: column phone_verification.note: described in the ORM but missing in the database`;
  - после отката — run 35184535655, PASS (https://github.com/ihantrader/adclub.kz/actions/runs/35184535655);
  - PR закрыт без слияния, ветка удалена.

## UAT / E2E
Окружение — Windows, dev-стек из `infra/docker/compose.dev.yml`. API запускался через `pnpm --filter api dev` (tsx), для сценариев «Накрутка» и «Redis упал» — через собранный `node dist/main.js`. Запросы — `curl`.
- **«Обычный вход» — OK.**
  - Запрос для `8 701 555 12 34` → `200`, `phone: +77015551234`, `channel: whatsapp`.
  - Код взят из `GET /dev/login-codes`.
  - Проверка для `+7701 5551234` → `{"status":"verified"}`.
  - Повтор того же кода → `400 LOGIN_CODE_EXPIRED`.
  - В базе: `consumed | whatsapp`, в `phone_verification` — `whatsapp`.
  - В журнале — `phone=+7***1234`; поиск кода и полного номера по файлу журнала — 0 совпадений.
- **«Не пришло» — OK.**
  - API с `LOGIN_CODE_TEST_FAILING_CHANNELS=whatsapp`: запрос для `+7 (747) 111-22-33` → `channel: sms`.
  - В журнале: `Login code delivery failed phone=+7***2233 channel=whatsapp reason=test_channel_configured_to_fail`, `Login code falling back to sms phone=+7***2233`, `Login code delivered … channel=sms`.
  - Кода и полного номера в журнале нет.
- **«Перебор» — OK.**
  - Ответы на неверный код: остаток попыток 4, 3, 2.
  - Затем три немедленных ввода → `RATE_LIMITED login_code_verify_delay`, попытки не расходуются.
  - После пауз: остаток 1, затем 0.
  - Дальше и неверный, и верный код → `LOGIN_CODE_EXPIRED`; в базе `exhausted | sms | 5`.
  - Новый код: до конца интервала — `login_code_resend_interval` (осталось 20 с, затем 10 с), потом `200`, проверка → `verified`.
- **«Накрутка» — OK.** API запущен с `LOGIN_CODE_REQUESTS_PER_PHONE=3` (окно 20 с) и `LOGIN_CODE_REQUESTS_PER_IP=5` (окно 30 с), что заодно подтверждает чтение порогов из окружения.
  - Четвёртый запрос для одного номера → `429`, `Retry-After: 16`, `login_code_requests_per_phone`.
  - Шестой запрос с одного IP → `429`, `Retry-After: 25`, `login_code_requests_per_ip`.
  - После окна запрос снова `200`.
- **«Redis упал» — OK.**
  - После `docker stop` контейнера Redis: запрос и проверка кода → `503 SERVICE_UNAVAILABLE`, `retryable: true`; `/health` → 200; `/ready` → 503 с `redis: error`.
  - После `docker start` запрос прошёл через ~3 с без перезапуска API.
- **«Расхождение схемы» — OK**, в CI (см. Verification).
- Интеграционный тест дополнительно проверяет:
  - одновременный ввод верного кода — 8 запросов, ровно один успех;
  - одновременные запросы кода — действующий код один, счётчик учёл оба;
  - одновременную активацию 6 доставок — один `active`, 5 `superseded`;
  - истечение срока;
  - оба канала недоступны;
  - дневные лимиты SMS, в том числе на резервной отправке;
  - сеть IPv6 /64;
  - 426 для устаревшего клиента;
  - битый JSON — 400, а не 500;
  - сценарий обычного человека при лимитах по умолчанию;
  - отсутствие кодов (все коды за прогон, больше 20) и полных номеров во всём журнале.
- Экранов входа нет (по задаче); в браузере проверен только JSON-ответ `/dev/login-codes`.

## Acceptance Criteria
- **AC-1 — PASS.** Сценарий «Обычный вход» выше. Тест `sends a code for one spelling of a number and accepts it for another, once`. `it.each` в `validation`: российский, городской, иностранный номер, буквы, пустая строка, 10 000 символов, число, без номера → 400 `VALIDATION_ERROR`, `channels.sent` пуст. Юнит-тесты `normalizeKzMobilePhone` — 11 вариантов записи, 14 отказов.
- **AC-2 — PASS.** Тесты `…accepts it for another, once` (повтор), `does not accept an expired code, even the right one`, `invalidates a code after the last allowed wrong entry; a new code works`, `accepts the right code exactly once when it's entered concurrently` (8 одновременных запросов → один 200). Все зелёные локально и в CI run 35184331403.
- **AC-3 — PASS.** Тест `accepts only the latest code once a new one is sent` (статусы `superseded`, `active`; старый код отклонён). Тест `leaves one code for simultaneous requests and counts both` (статусы `["active"]`, счётчик номера `2`). Тест `keeps exactly one active code when deliveries finish concurrently`. Частичный уникальный индекс `otp_challenge_one_active_key` в миграции.
- **AC-4 — PASS.** Тесты `falls back to SMS when WhatsApp can't deliver…`, `refuses an SMS resend before the interval and allows it after` (429 `login_code_resend_interval`, `sent` не вырос, после 2 с → 200 `sms`), `sends by SMS right away when the person chooses SMS`. Сценарии «Не пришло» и «Перебор» на dev.
- **AC-5 — PASS.** Тесты `rate limits` (по номеру с истечением окна, по IP, IPv6 /64, SMS на номер, SMS на резервной отправке, SMS на IP, проверки на номер). Каждый проверяет 429, `RATE_LIMITED`, `retryable: true`, `details.limit`, `retryAfterSeconds > 0` и `Retry-After`. Обычный человек: тесты `does not block the usual flow with the default limits` и `lets a person through who mistypes twice and asks for a resend`. Сценарий «Накрутка» на dev.
- **AC-6 — PASS.** Тест `refuses codes while Redis is down and recovers without a restart` (TCP-прокси перед реальным Redis: 503 `SERVICE_UNAVAILABLE` `retryable`, `/health` 200, `/ready` 503, после восстановления 200). Сценарий «Redis упал» на dev со `docker stop`/`docker start`.
- **AC-7 — PASS.** Тест `answers the same way whether or not an account exists for the number`: одинаковые тело (кроме номера и времени) и набор заголовков. Код отсутствует в ответе (проверка в первом тесте). В API код не возвращается ни в каком окружении, в dev он виден только через `/dev/login-codes`. Тесты журнала `record every step with a masked number and never the code` и `never contained a code or a full phone number during this whole suite` перехватывают stdout/stderr процесса за весь интеграционный прогон. Ручная проверка файлов журнала на dev — 0 совпадений.
- **AC-8 — PASS.** Юнит-тесты `refuses to start production with the test channels` / `…with the dev code outbox`. Реальный запуск `NODE_ENV=production node dist/main.js` → сообщение об ошибке и код 1. e2e-тест контракта: production-набор маршрутов не содержит `/dev/login-codes` (ответ 404).
- **AC-9 — PASS.** Тесты `remembers the channel the confirmed code came through` (`sms`, затем `whatsapp`) и `falls back to SMS…` (`phone_verification.channel = sms`). На dev: `+77015551234 | whatsapp`, `+77471112233 | sms`.
- **AC-10 — PASS.** `LoginCodeSettingsSource` / `ConfigLoginCodeSettingsSource` (`login-code-settings.source.ts`), провайдер в `IdentityModule`. Тест `parses a fully valid environment…` фиксирует значения по умолчанию: 6 цифр, 300 с, 5 попыток, 60 с — как в ARCHITECTURE 8.1; остальные ключи добавлены в ARCHITECTURE 14. Тест `reads thresholds…`. Сценарий «Накрутка» с порогами из окружения.
- **AC-11 — PASS.** В `apps/api/openapi.json` есть `/auth/login-code`, `/auth/login-code/verify` и новые значения `ErrorCode`. Тесты `openapi.test.ts`. `openapi:check` и шаг «API contract is backward compatible» в CI run 35184331403 — PASS.
- **AC-12 — PASS.** Run 35184368428 — FAIL с перечнем расхождений. Run 35184535655 — PASS после отката. Юнит-тесты `compareSchemas` (таблица, колонка, тип, длина varchar, обязательность в обе стороны) и интеграционный тест с `ALTER TABLE` внутри транзакции.
- **AC-13 — PASS.** Run 35184331403 на `main`, conclusion `success` (получено через `gh run watch --exit-status` и `gh run view`).
- **AC-14 — PASS.** ARCHITECTURE.md 0.8, раздел 4.5 и уточнения 4.2, 5.1, 8.1, 14. CLAUDE.md, блок 0 — `/dev/login-codes`, `LOGIN_CODE_*`, `TRUST_PROXY`, состав `test:integration`, `orm-tables.ts`.

## Errors & Fixes
- **Сервис не поднимался:** Nest не мог внедрить `JsonLoggerService` в `LoginCodeService` — этот логгер не глобальный. Процесс аварийно завершался (код 134) в e2e-тесте. Исправлено: используется `new Logger("LoginCode")`, как в других сервисах.
- **Сообщения сервиса не попадали в перехват журнала в тесте.** В Nest 12 при `bufferLogs` буфер сбрасывается только в `app.listen()`, а тест вызывает `init()`. Исправлено вызовом `app.flushLogs()` в тесте (ARCHITECTURE I43); `main.ts` не затронут.
- **Канонизация типа `timestamp with time zone` в сверке схемы давала `without`.** Алиас затирал часовой пояс. Найдено юнит-тестом, функция переписана.
- **С двумя миграциями старый тест отката (`migrate:down` — только последняя) перестал проверять удаление `account`.** Тест переписан: откат по одной миграции с проверкой таблиц каждой.
- **Литеральный неразрывный пробел в регулярном выражении не прошёл линт** (`no-irregular-whitespace`). Он и не нужен: `\s` в JS его покрывает.
- **Ошибка процесса с моей стороны.** При создании демо-ветки `git commit -a` захватил незакоммиченные правки Product Owner в `PROJECT_PLAN.md` и `PROJECT_STATE.md`. Первая версия ветки с ними была отправлена в GitHub (ветка `ci/schema-drift-demo`, коммит `c1f48c1`); её CI-прогон 35184346223 отменён. После переключения на `main` эти правки пропали из рабочей копии.
  - Исправлено: файлы восстановлены из этого коммита, хэши содержимого совпадают с исходными (`feed5ad…`, `fbb2269…`).
  - Демо-коммит пересобран без них и отправлен с `--force-with-lease` в мою временную ветку. PR показывал только `schema.ts`. Ветка затем удалена.
  - В `main` эти файлы не попадали. Сейчас они снова только в рабочей копии как незакоммиченные изменения.

## Deviations
- **Production до TASK-026 не запускается совсем** — ни API, ни worker. Этого прямо требует п. 5 / AC-8, а других каналов нет. Worker тоже отказывает, потому что конфигурация общая, хотя сам коды не отправляет.
- **Значения лимитов частоты по умолчанию** (кроме длины, срока, попыток и интервала) в ARCHITECTURE 8.1 и 14 не были заданы. Их выбрал я и зафиксировал в 4.5 I36 и 14. Product Owner может скорректировать через `LOGIN_CODE_*`.
- **Отдельного кода ошибки для «слишком рано для повторной отправки» нет.** Используется `RATE_LIMITED` с `details.limit = login_code_resend_interval` и временем ожидания; так же — для задержки после неудачных попыток (`login_code_verify_delay`). Задача требует «ошибку с временем ожидания», это выполнено.
- **`LOGIN_CODE_EXPIRED` не различает причины** (истёк, использован, исчерпан, заменён, не запрашивался). Клиенту во всех случаях нужно одно действие — запросить новый код. Причина пишется в журнал.
- Файла `tasks/TASK-004.md` в репозитории нет — задача получена в сообщении. PROJECT_STATE.md указывает TASK-004 как IN PROGRESS; статусы ведёт Product Owner.

## Known Issues / Risks
- **`TRUST_PROXY` должен быть задан на staging/production за обратным прокси** (TASK-055). Иначе все клиенты будут выглядеть одним IP, и лимит по IP заблокирует всех.
- **CGNAT мобильных операторов РК:** много абонентов за одним IPv4. Лимиты по IP (30 в час, SMS — 10 в сутки) могут задеть добросовестных пользователей при росте аудитории. Это настройки, меняются без кода; стоит отслеживать срабатывания `login_code_requests_per_ip` и `login_code_sms_per_ip_daily` в журнале.
- **`LOGIN_CODE_HASH_SECRET`** нужно сгенерировать для staging/production и хранить как секрет. Смена секрета делает недействительными только коды, выданные в этот момент (живут 5 минут).
- **Dev-ящик кодов хранится в памяти одного процесса:** после перезапуска API он пуст, при нескольких процессах коды разделены.
- **Старые записи `otp_challenge` не удаляются** — очистка по `created_at` (индекс есть) ложится на фоновые задачи TASK-008.
- **Лимиты — фиксированное окно от первого обращения.** На границе окна возможен всплеск до двух лимитов подряд. Для этих величин это приемлемо.
- **Время сравнивается по часам приложения**, не базы. При нескольких экземплярах API расхождение часов в секунды влияет только на границы срока жизни и задержки.
- Ручное действие для Product Owner: в своём `.env` ничего добавлять не нужно — значения по умолчанию подходят для dev. Миграцию нужно применить: `pnpm --filter api migrate`.
- Dev-контейнеры (`infra/docker/compose.dev.yml`) после проверки оставлены запущенными.

## Remaining Work
None.

## Future Improvements
- Метрики и алерты по срабатываниям лимитов и доле ошибок доставки по каналам (вместе с `observability`, TASK-009).
- Отдельный лимит проверок кода по IP (сейчас перебор по многим номерам ограничен лимитом выдачи кодов по IP).
- Скользящее окно или token bucket вместо фиксированного окна, если всплески на границе окна станут заметны.
- В dev-ящике — кнопка «сделать канал недоступным» без перезапуска API (сейчас переменная окружения).
- После TASK-026 вернуть `openapi:generate`/`openapi:check` к настоящей production-конфигурации (ARCHITECTURE I39).

# TASK REPORT — TASK-009.A

## Status
COMPLETED

## Result

Все находки приёмки TASK-009 закрыты; продуктовое поведение не менялось, корректно реализованное в TASK-009 не переделывалось.

**Ничего из SQL-запроса наружу.** Санитайзер знает реальный формат ошибок: `DrizzleQueryError` (`drizzle-orm` 0.45) пишет `Failed query: <sql>\nparams: a,b,c` без скобок — теперь всё после `params:` до стека или конца текста заменяется `[redacted]`; стек ошибки очищается вместе с её сообщением (точный текст сообщения вырезается из стека). Из ошибок PostgreSQL удаляются значения: поля `detail`, `where`, `internalQuery`, в тексте — `Key (col)=(…)`, `Failing row contains (…)`, `invalid input syntax for type …: "…"`, `parameter $n = '…'`; имена столбцов и ограничений, SQLSTATE (`23505`) и коды Node (`ECONNREFUSED`) остаются. Очистка больше не зависит от того, почистил ли ошибку вызывающий код: одинаково для HTTP, упавшей задачи и необработанной ошибки. Событие мониторинга несёт очищенную цепочку причин. Текст отказа задачи в очереди (`jobs:dead`) и вывод серверной команды при сбое тоже очищаются.

**Номер в любом месте текста** маскируется — перед точкой, запятой, дефисом, скобкой, в конце строки, склеенный с буквами (`user_77011234567` → `user_+7***4567`); UUID, длинные числовые id, метки времени, даты и время не искажаются и не принимаются за номер или IP. Сжатый IPv6 (`2a02:2168:8a1f::1`, `::1`, `fe80::1%eth0`, `::ffff:192.0.2.1`) маскируется; ключи `set-cookie`, `x-api-key`, `proxy-authorization`, `x-forwarded-for`, `x-real-ip` и подобные удаляются; логин и пароль в URL удаляются.

**Журнал действий** листается без пропусков и повторов: курсор хранит время с точностью базы (микросекунды), сравнение идёт в PostgreSQL; записи одной транзакции упорядочены по `id`. Строка «Action recorded» пишется только после фиксации транзакции.

**Метрики.** Вне development/test `/metrics` включён только при `METRICS_TOKEN`; `METRICS_ENABLED=true` без токена — процесс не стартует. Токен сравнивается за постоянное время. Имена меток проверяются, значения очищаются; при сбое сбора метрики очереди отсутствуют в выдаче (не старые значения), `adclub_metrics_collector_up` = 0; датчики переименованы в `adclub_job_failed`, `adclub_job_dead`.

**Коды 4xx по смыслу.** 405 `METHOD_NOT_ALLOWED` (с `Allow`, если путь обслуживается другими методами), 406, 408, 410, 413 `PAYLOAD_TOO_LARGE`, 414, 415 `UNSUPPORTED_MEDIA_TYPE`, битое тело — `MALFORMED_REQUEST`, прочие 4xx — `REQUEST_REJECTED`; `VALIDATION_ERROR` — только 400/422 по схеме. Раньше слишком большое и битое JSON-тело отвечали **500** и уходили в мониторинг как сбой сервера — исправлено. Тело не JSON → 415.

**Логгер и процесс.** Объект первым аргументом пишется очищенным JSON; сбой преобразования сообщения не роняет вызов. Ошибки старта API и worker идут через санитайзер. После `uncaughtException` процесс пишет очищенную строку и событие, ждёт отправки до 5 с и завершается с кодом 1; `unhandledRejection` — пишется и отправляется, процесс продолжает работу (ARCHITECTURE 4.14 I139).

## Changes

| Файл | Суть |
|---|---|
| `apps/api/src/observability/sanitizer.ts` | Формат Drizzle `params:` без скобок, детали PostgreSQL, очистка стека вместе с сообщением (`sanitizeErrorText`), номер по границам цифр с «отложенными» UUID/датами/временем/hex, IPv6 со сжатием, ключи-заголовки, учётные данные в URL, `name=`/`address=` до конца фразы, обрезка после очистки, SQLSTATE сохраняется |
| `apps/api/src/observability/error-reporter.service.ts` | Цепочка причин в событии, `flush(timeoutMs)` для выхода процесса |
| `apps/api/src/common/logging/json-logger.service.ts` | Ошибка — через `sanitizeErrorText`; объект — JSON; всё под защитой |
| `apps/api/src/common/shutdown/unhandled-failures.ts`, `startup-failure.ts` | Выход после `uncaughtException`; ошибки старта через санитайзер (`main.ts`, `worker.ts`) |
| `apps/api/src/jobs/job-runner.service.ts`, `operator.ts` | Текст отказа задачи и сбой команды — через санитайзер |
| `apps/api/src/jobs/dev-jobs.ts`, `operator.ts` | `dev:jobs:fail --on-query` — падение на реальном SQL-запросе (dev/test) |
| `apps/api/src/modules/audit/audit-log.store.ts`, `audit-log.service.ts` | Курсор с микросекундами, сравнение в базе; `afterCommit` для строки журнала |
| `apps/api/src/config/env.schema.ts`, `.env.example` | Метрики вне dev/test только с токеном, отказ старта при явном включении без токена |
| `apps/api/src/observability/metrics.controller.ts`, `metrics-registry.ts`, `metrics.service.ts`, `jobs/job-metrics.ts` | Сравнение токена за постоянное время, проверка меток, коллектор с «своими» метриками и `adclub_metrics_collector_up`, имена датчиков |
| `packages/contracts/src/error.ts`, `apps/api/openapi.json` | 9 новых кодов ошибок (аддитивно) |
| `apps/api/src/common/errors/http-exception.filter.ts`, `body-parser-error.ts`, `not-found.controller.ts`, `common/http/json-body.middleware.ts`, `http-app.ts`, `app.module.ts` | Коды 4xx по смыслу, 405 с `Allow`, ошибки `body-parser` → коды, 415 для тела не JSON |
| `apps/api/src/testing/unhandled-failure.fixture.ts` | Отдельный процесс для теста необработанных ошибок |
| Тесты | `sanitizer.real-errors.test.ts` (фикстуры, снятые с реальных отказов PostgreSQL 16), дополнения `sanitizer.test.ts`, `json-logger.service.test.ts`, `unhandled-failures.test.ts`, `startup-failure.test.ts`, `metrics.test.ts`, `env.schema.test.ts`, `http-exception.filter.test.ts`, `observability.integration.test.ts`, `audit-log.integration.test.ts`; обновлены ожидания в `access`, `settings`, `login-code` integration (см. Deviations) |
| `ARCHITECTURE.md` 0.17 | Раздел 4.14 (I131–I140), история, уточнения I126, I129, 15.3 |
| `CLAUDE.md` | Метрики вне dev, `dev:jobs:fail --on-query`, версия 0.17 |
| `tasks/TASK-009-REPORT.md` | Исправлено утверждение о кодах 4xx (в «Result» и AC-9) |

### Коммиты (D-024, только явно перечисленные файлы)

1. `31266fc` Add TASK-009.A and update project plan and state (Product Owner edits) — `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-009.A.md`.
2. `ba2854c` Add error codes for requests refused for what they are — `packages/contracts/src/error.ts`, `apps/api/openapi.json`.
3. `49c80b1` Keep bound values and database details out of every log line and event — `apps/api/src/`: `observability/sanitizer.ts`, `observability/sanitizer.test.ts`, `observability/sanitizer.real-errors.test.ts`, `observability/index.ts`, `observability/error-reporter.service.ts`, `common/logging/json-logger.service.ts`, `common/logging/json-logger.service.test.ts`, `common/shutdown/index.ts`, `common/shutdown/unhandled-failures.ts`, `common/shutdown/unhandled-failures.test.ts`, `common/shutdown/startup-failure.ts`, `common/shutdown/startup-failure.test.ts`, `main.ts`, `worker.ts`, `jobs/job-runner.service.ts`, `jobs/dev-jobs.ts`, `operator.ts`, `testing/unhandled-failure.fixture.ts`.
4. `944bec8` Page the action journal at the database's precision and log entries after commit — `apps/api/src/modules/audit/audit-log.service.ts`, `audit-log.store.ts`, `audit-log.integration.test.ts`.
5. `8c372e0` Close /metrics outside development without a token and keep samples honest — `.env.example`, `apps/api/src/config/env.schema.ts`, `config/env.schema.test.ts`, `observability/metrics-registry.ts`, `observability/metrics.controller.ts`, `observability/metrics.service.ts`, `observability/metrics.test.ts`, `jobs/job-metrics.ts`.
6. `a66bf34` Answer 4xx refusals with codes that fit, and test what leaves the process — `apps/api/src/`: `common/errors/http-exception.filter.ts`, `common/errors/http-exception.filter.test.ts`, `common/errors/body-parser-error.ts`, `common/errors/index.ts`, `common/errors/not-found.controller.ts`, `common/http/json-body.middleware.ts`, `common/http/index.ts`, `app.module.ts`, `http-app.ts`, `modules/identity/access.integration.test.ts`, `modules/settings/settings.integration.test.ts`, `modules/identity/login-code/login-code.integration.test.ts`, `observability/observability.integration.test.ts`.
7. `f0d712d` Document TASK-009.A decisions in ARCHITECTURE 4.14 and correct the TASK-009 report on 4xx codes — `ARCHITECTURE.md`, `CLAUDE.md`, `tasks/TASK-009-REPORT.md`.
8. `65582d7` Add TASK-009.A report — `tasks/TASK-009.A-REPORT.md`.
9. `a135f18` Wait for the completed state in the job retry test instead of racing pg-boss — `apps/api/src/jobs/jobs.integration.test.ts`.
10. Коммит с обновлённым отчётом — `tasks/TASK-009.A-REPORT.md` (хэш — в ответе сессии; в самом файле его быть не может).

## Technical Decisions

Внесены в `ARCHITECTURE.md` 0.17, раздел 4.14:

- **I131** — очистка ошибки базы в самом санитайзере по реальному формату Drizzle/PostgreSQL; стек очищается вместе с сообщением; `withoutQueryParameters` оставлен для читаемости, но безопасность от него не зависит.
- **I132** — номер ищется по границам цифр (слева/справа не цифра), решение «номер или нет» — по форме (`+`, разделители, казахстанский вид); UUID, hex-id, даты и время временно убираются из текста до поиска номеров и IP.
- **I133** — курсор журнала: `created_at` до микросекунд строкой + `id`, сравнение `(created_at, id) < (…)` в PostgreSQL.
- **I134** — выбор по метрикам: без токена вне dev/test метрики **выключены**, а явное `METRICS_ENABLED=true` без токена — **отказ старта** (оператор узнаёт сразу).
- **I135** — реестр метрик: проверка меток, коллектор с «своими» метриками, `adclub_metrics_collector_up`.
- **I136** — коды 4xx; решение I129 «405 → `NOT_FOUND`, чтобы скрыть существование маршрута» отменено: маршруты публичны в OpenAPI. Ошибки `body-parser` перехватываются в `mapException` адаптера Express (в `configureHttpApp`) — там, где Nest принимает ошибки промежуточных обработчиков; обработчик ошибок Express, добавленный в `configureHttpApp`, не видит их, потому что Nest регистрирует парсеры позже, при `init` (проверено в dev).
- **I137–I140** — строка журнала после фиксации; логгер; выход после `uncaughtException` при продолжении после `unhandledRejection`; dev-задача с падением на SQL.

## Verification

- `pnpm format:check` — PASS — «All matched files use Prettier code style!»
- `pnpm lint` — PASS — 12/12 задач
- `pnpm typecheck` — PASS — 18/18 задач
- `pnpm test` — PASS — 15/15 задач; `@adclub/api` 31 файл, 363 теста; `@adclub/contracts` 72, остальные пакеты без изменений
- `pnpm --filter @adclub/api openapi:check` — PASS — «openapi.json matches the contract and the served routes»
- `pnpm --filter @adclub/api openapi:compat --base HEAD` (до коммитов, Docker) — PASS — «No breaking changes… Contract is backward compatible with HEAD» (добавлены только значения enum)
- `pnpm test:integration` локально (Windows, Docker Desktop) — 199/204 PASS в полном прогоне; 3 падения — старые ожидания поведения, которое задача меняет (исправлены, после исправления `access` + `settings` 47/47 PASS, `login-code` 42/44); 2 оставшихся падения (`login-code`: «refuses an SMS resend… allows it after», «limits code requests per number…») — **окружение**: часы Docker VM на этой машине идут на ~9% медленнее хоста (замер: 10,50 с хоста = 9,58 с в контейнере), TTL в Redis не успевает истечь за `sleep`; на исходном коде (`git stash`) «limits code requests per number» падает так же. Полный набор — в CI на Linux (ниже).
- `observability.integration.test.ts` — PASS — 12/12 (включая 5 новых сценариев TASK-009.A)
- `audit-log.integration.test.ts` — PASS — в полном прогоне, включая 3 новых теста
- CI на `main` — PASS — run 35313177600: юнит 363/363, интеграционные 204/204 на Linux, совместимость контракта (см. «CI»).

## UAT / E2E

Пройдено в dev (Windows, `pnpm --filter api dev`, worker `pnpm --filter api worker`, PostgreSQL/Redis из `infra/docker/compose.dev.yml`, тестовый приёмник мониторинга `node -e "…listen(9911)"`):

1. **Падение фоновой задачи на запросе с телефоном и именем.** Worker с `MONITORING_DSN=http://devkey@127.0.0.1:9911/1`; `pnpm --filter api operator dev:jobs:fail --on-query --note "Айгерим Касымова, позвонить +77011234567."`. Три попытки, затем мёртвая очередь; в приёмнике событие `"transaction":"dev.always-fails"`, `"value":"Failed query: SELECT $1::uuid AS id, $2 AS note\nparams=[redacted]"`. `grep -c "Айгерим\|77011234567\|7011234567"` по файлу приёмника и журналу worker — **0 и 0**. Строка журнала: `Job failed permanently … error=DatabaseQueryError: Database query failed: invalid input syntax for type uuid: "[redacted]"; query: SELECT $1::uuid AS id, $2 AS note`. `jobs:dead` показывает ту же очищенную ошибку, вхождений имени и номера — 0.
2. **Необработанные ошибки в отдельном процессе** (`src/testing/unhandled-failure.fixture.ts` против dev-базы и приёмника): код выхода 1; в приёмнике события `unhandledRejection` и `uncaughtException`; процесс после отказа промиса продолжил работу («Fixture still running…»); вхождений имени/номера в приёмнике и выводе — 0.
3. **Строка журнала с номером в конце предложения.** `JsonLoggerService.log("Позвонить клиенту +77011234567.")` → `"message":"Позвонить клиенту +7***4567."`; строка с `(user_77011234567)`, `8 (701) 123-45-67`, UUID и `2026-09-18 03:14:33` → номера маской, UUID и дата нетронуты.
4. **Много записей журнала одной операцией и постраничный просмотр.** Вход администратора в dev по-настоящему (код из `/dev/login-codes`, настройка TOTP, подтверждение кодом) → 10 записей одним SQL-оператором (одна транзакция, `distinctTimes: 1`) → `GET /admin/audit-log?entityType=setting&limit=3` по курсорам: 6 страниц, записи пачки распределились 3+3+3+1, итог `{"expected":10,"seen":18,"unique":18,"bulkSeen":10,"allPresent":true}` — все записи ровно по одному разу. (В dev-базе остался администратор `+77019990001` и эти 10 записей — dev-данные.)
5. **API с настройками вне dev без токена метрик.** Production на сегодня не стартует вовсе (есть только тестовые каналы кодов), поэтому проверено на `NODE_ENV=staging` (правило одно — «вне development и test»): без токена `GET /metrics` → **404** `NOT_FOUND`, `/health` работает; `METRICS_ENABLED=true` без токена → процесс не стартует: `Invalid configuration: - METRICS_TOKEN: required when METRICS_ENABLED=true and NODE_ENV=staging`; с `METRICS_TOKEN`: без заголовка → 401, неверный токен → 401, верный → 200.
6. **Коды 4xx.** `curl -X DELETE /health` → **405** `METHOD_NOT_ALLOWED`, `Allow: GET, HEAD`; `GET /auth/login-code` → 405, `Allow: POST`; тело 300 КБ → **413** `PAYLOAD_TOO_LARGE` (до исправления — 500 `INTERNAL_ERROR`); `Content-Type: application/xml` → **415** `UNSUPPORTED_MEDIA_TYPE`; `{bad` → **400** `MALFORMED_REQUEST` (до исправления — 500); `charset=koi8-r` → 415; `DELETE /nothing` → 404 `NOT_FOUND`.

## Acceptance Criteria

- **AC-1 — PASS** — `sanitizer.real-errors.test.ts`: четыре фикстуры с полями, снятыми с реальных отказов PostgreSQL 16 на dev-базе (уникальность по `display_name` и `phone` с `detail: Key (...)=(...)`, check-нарушение с `Failing row contains (...)`, `invalid input syntax for type uuid: "…"` с `where`), обёрнутые в настоящий `DrizzleQueryError` из `drizzle-orm` и `DatabaseError` из `pg` — ни имени, ни номера, ни адреса ни в объекте (мониторинг, `details` журнала), ни в тексте сообщения и стека (журнал). Интеграционно (`observability.integration.test.ts`, весь принятый поток): «an HTTP request: nothing of the statement…» (реальное нарушение уникальности), «a job that fails on a query…» (worker, `dev.always-fails` с `failOnQuery`, ещё и `pgboss.job.output`), «an unhandled rejection and an uncaught exception…» (отдельный процесс) — PASS.
- **AC-2 — PASS** — `sanitizer.test.ts` «TASK-009.A: a number in any position…»: перед точкой, запятой, дефисом, после дефиса, в скобках, в конце строки, склеенный с `_` и с буквами, с разделителями перед точкой; UUID рядом с номером, id из 18 цифр, метки времени 10 и 13 цифр не искажаются; 5 форм дат и времени не становятся ни номером, ни `[ip]`.
- **AC-3 — PASS** — там же: 6 форм IPv6 (включая `2a02:2168:8a1f::1`, `::1`, `fe80::1%eth0`, `::ffff:192.0.2.1`) → `[ip]`; `set-cookie`, `x-api-key`, `proxy-authorization`, `x-forwarded-for`, `x-real-ip` → `[redacted]`, `x-request-id` и `content-type` остаются.
- **AC-4 — PASS** — `audit-log.integration.test.ts`: «pages ten entries of one transaction, three at a time: every entry exactly once» (проверено, что у 10 записей одно время; страницы вместе = все строки таблицы, без повторов, число страниц = ⌈n/3⌉) и «keeps entries that differ by less than a millisecond on their pages» (6 записей в пределах одной миллисекунды, по 2 на страницу — все в порядке). Плюс dev-сценарий 4.
- **AC-5 — PASS** — выбран способ «без токена выключено, явное включение без токена — отказ старта» (ARCHITECTURE 4.14 I134). `env.schema.test.ts` «metrics outside development and test»: без токена выключены, с токеном включены, `METRICS_ENABLED=true` без токена → ошибка конфигурации; интеграционно — staging без токена → 404, неверный токен → 401; `metrics.test.ts` — без заголовка, неверный, длиннее, без `Bearer` → 401, и во всех случаях вызван `timingSafeEqual` ровно один раз (сравнение дайджестов одинаковой длины). Плюс dev-сценарий 5.
- **AC-6 — PASS** — `http-exception.filter.test.ts`: 405, 406, 408, 410, 413, 414, 415, 417, 431 — свои коды, 422 — `VALIDATION_ERROR`; перебор всех 400–499: `VALIDATION_ERROR` только у 400 и 422; ошибки `body-parser` (битый JSON, слишком большое тело, чужая кодировка, прерванный запрос) → свои коды, не 500, без текста тела, без журнала ошибок и мониторинга. Интеграционно на реальном приложении: 405 с `Allow`, 413, 415, 400 `MALFORMED_REQUEST`, 400 `VALIDATION_ERROR`, 404, ничего в приёмнике. Контракт: `openapi:compat --base HEAD` — «backward compatible», трейлер не нужен (добавление значений enum — `INFO` по `openapi-compat-levels.txt`).
- **AC-7 — PASS** — `audit-log.integration.test.ts` «leaves no entry when the transaction of the action rolls back»: после отката `output.text()` не содержит `Action recorded`; «writes no phone number…» — после фиксации строка есть.
- **AC-8 — PASS** — `json-logger.service.test.ts`: «writes an object given as the message as sanitized JSON» (`{"event":"sweep","phone":"+7***4567","rows":3}`), «still writes the line when the message can't be turned into text» (объект с бросающими `toString` и геттером — строка с `[sanitizer failed]`, вызов не падает), «writes a failed query without its bound values»; `startup-failure.test.ts` — ошибка старта строками JSON-журнала без номера, ошибка конфигурации читаемым списком без пароля из URL, не-ошибка не роняет вызов.
- **AC-9 — PASS** — `unhandled-failures.test.ts`: `uncaughtException` → очищенная строка, событие с `kind: uncaughtException`, ожидание `flush`, затем `exit(1)`; повторное исключение — выход сразу; `unhandledRejection` — событие и строка, выхода нет. Интеграционно — отдельный процесс: событие дошло до приёмника очищенным, строка «Uncaught exception: the process is exiting», ненулевой код выхода (в Linux — ровно 1, подтверждено CI run 35313177600; на Windows libuv может завершить процесс аварийно вместо кода 1 — известная проблема Node этой платформы, код всё равно ненулевой; см. Known Issues).
- **AC-10 — PASS** — `audit-log.integration.test.ts` «fails the action when its entry can't be written: nothing of it stays»: запись журнала отказывает → `SettingsChangeService.change` падает, в `audit_log`, `app_setting`, `app_setting_change` ничего, строки «Action recorded» нет.
- **AC-11 — PASS** — перехват вывода (`output-capture.ts`) подключён ко всем интеграционным файлам и в полном локальном прогоне не нашёл ни одного зарегистрированного токена, секрета или кода (ни один файл не упал на проверке `afterAll`); существующие тесты не ослаблены — изменены только три ожидания поведения, которое TASK-009.A меняет по требованию (см. Deviations). Два теста лимитов падают локально из-за часов Docker VM (не из-за изменений); в CI на Linux полный набор — 204/204 PASS (run 35313177600).
- **AC-12 — PASS** — коммиты по D-024 (только явно перечисленные файлы, состав выше, перед каждым — `git diff --cached --stat`); CI на `main`: run 35313177600 (`f0d712d`) — success; run 35313508881 (`65582d7`) — failure из-за гонки в тесте задач, исправлено в `a135f18`; прогон последнего коммита — в ответе сессии.
- **AC-13 — PASS** — `ARCHITECTURE.md` 0.17 (история, раздел 4.14 I131–I140, уточнения I126, I129, 15.3); в `tasks/TASK-009-REPORT.md` добавлено исправление утверждения о кодах 4xx в «Result» и в AC-9.

## CI

- Run **35313177600** (коммит `f0d712d`, последний кодовый коммит задачи) — **success**, 3 мин 58 с: format, lint, typecheck, build, `pnpm test` (`@adclub/api` 31 файл / 363 теста, остальные пакеты зелёные), **интеграционные 10 файлов / 204 теста — все PASS на Linux** (включая оба теста лимитов, падавшие локально из-за часов Docker VM, и выход процесса с кодом ровно 1 после `uncaughtException`), «API contract is backward compatible» против `b2eab62` без трейлера.
- Run **35313508881** (коммит `65582d7`, только `.md`) — **failure**: `jobs.integration.test.ts` «retries a failing job by its rules until it succeeds» — `expected 'active' to be 'completed'` (203/204). Код тот же, что в зелёном run 35313177600: это гонка в тесте TASK-008 — обработчик уже отметил завершение, а pg-boss ещё не перевёл задачу в `completed` (и строка «Job completed» пишется после). Исправлено в `a135f18`: тест ждёт состояния `completed`, как соседние тесты задач; локально весь файл `jobs.integration.test.ts` — 21/21 PASS.
- Прогон последнего коммита (с этим отчётом) — номер и статус в ответе сессии (в файле, который он проверяет, их быть не может).

## Errors & Fixes

- **CI run 35313508881 упал на гонке в тесте TASK-008** («retries a failing job…»: состояние `active` вместо `completed` сразу после того, как обработчик отметил завершение). Не связан с изменениями задачи (тот же код прошёл в run 35313177600); тест теперь ждёт `completed` (`a135f18`).
- **Правка файла через Python исказила регулярные выражения** (`\b` стал символом backspace, ` ` — литеральным NUL). Найдено по тому, что правило учётных данных URL не срабатывало; исправлено, все изменённые файлы проверены на управляющие символы; маркер удержания теперь строится в коде (`String.fromCharCode(0)`).
- **`${HEX4}?` в шаблоне IPv6** превращал `{1,4}` в ленивый квантификатор вместо «необязательной группы» — `::1` не маскировался. Исправлено `(?:${HEX4})?`; IPv6 теперь ищется до IPv4 (`::ffff:192.0.2.1`).
- **SQLSTATE `23505` вырезался как «код входа».** Правило ключа `code` не различало их; оставлено для ошибок с `severity` (PostgreSQL) и кодов Node вида `E…`.
- **Обработчик ошибок Express в `configureHttpApp` не видел ошибок разбора тела** — Nest регистрирует парсеры при `init`, позже; перенесено в `mapException` адаптера (проверено в dev: `{bad` → 400 `MALFORMED_REQUEST`).
- **Ленивый запрос Drizzle.** В фикстуре необработанного отказа `void db.execute(...)` не выполнял запрос (Drizzle запускает его только при `then`); исправлено.
- **Событие упавшей задачи не объясняло причину** (только верхняя ошибка Drizzle); добавлена очищенная цепочка причин в событие.

## Deviations

- **Изменены ожидания трёх существующих интеграционных тестов** — это не ослабление, а требование задачи: `access.integration.test.ts` и `settings.integration.test.ts` ждали 404 `NOT_FOUND` на запрос к существующему пути другим методом (теперь 405 `METHOD_NOT_ALLOWED` с проверкой `Allow`; путь без маршрута по-прежнему 404, тест это проверяет); `login-code.integration.test.ts` ждал `VALIDATION_ERROR` на битый JSON (теперь `MALFORMED_REQUEST`). Проверки «изменить нечего» и «записей не прибавилось» остались.
- **Отменено решение I129 (TASK-009) «405 → `NOT_FOUND`, чтобы не выдавать существование маршрута»** — TASK-009.A прямо требует свой код для 405; маршруты и так публичны в OpenAPI. Зафиксировано в I136.
- **Тело не JSON → 415 для всех маршрутов** (раньше такое тело молча отбрасывалось и запрос падал на схеме как 400). Ни один текущий маршрут не принимает другие типы; маршруты загрузки файлов в будущем нужно будет исключить.
- **Сценарий «API с настройками production» проверен на staging**: production сейчас не стартует вообще (единственный провайдер каналов кодов — `test`, запрещённый в production). Правило метрик одно для всех окружений вне development/test.

## Known Issues / Risks

- **Локальные интеграционные тесты лимитов** (`login-code`: resend interval, requests per phone) падают на этой машине: часы Docker VM идут на ~9% медленнее хоста (замер выше). На исходном коде падение воспроизводится. Лечится синхронизацией времени VM (перезапуск Docker Desktop/WSL) — не делал, это затронуло бы чужие контейнеры (`lead-search-postgres-1`). Итог — по CI.
- **Windows: аварийное завершение вместо кода 1 после `uncaughtException`** (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` в libuv при `process.exit`) — наблюдалось только под Windows; код выхода всё равно ненулевой, событие и строка журнала уходят до выхода. Серверы проекта — Linux.
- **Эвристика номера**: «голые» 10-значные числа на 7 и 11-значные на 7/8 маскируются как номер, даже если это числовой id такой длины (в проекте id — UUID); числа с `+` или разделителями из 10–15 цифр — тоже. Перекос в сторону маскирования сознательный.
- **Dev-данные**: в dev-базе остались администратор `+77019990001`, 10 записей журнала `bulk…` и мёртвые задачи `dev.always-fails` от проверок.

## Remaining Work
None

## Future Improvements

- Отдельный порт метрик worker'а (его счётчики сейчас наружу не отдаются, I126) — вместе с TASK-055.
- Исключение маршрутов загрузки файлов из `JsonBodyMiddleware` — когда появятся (импорт прайса, фото).
- Синхронизация времени в тестах с Redis/PostgreSQL через время контейнера, чтобы тесты лимитов не зависели от хода часов Docker VM.

# TASK REPORT — TASK-008

## Status

COMPLETED

## Result

В worker-процессе работает механизм фоновых задач на pg-boss, и на нём уже выполняются первые реальные задачи — очистка устаревших данных входа.

Что теперь умеет система:

- **Очередь на PostgreSQL.** Схема очереди (`pgboss`) создаётся и обновляется обычными миграциями проекта; приложение её никогда не ставит само (`migrate: false`) и отказывается стартовать с чужой версией. Обновление зависимости `pg-boss` без миграции ловится юнит-тестом и командой `jobs:schema-migration check`.
- **Объявление задач.** Модуль объявляет задачу константой (`defineJob` — по требованию с типизированной полезной нагрузкой, `definePeriodicJob` — по расписанию, `defineSweeperJob` — свипер дедлайнов) и регистрирует реализацию. Worker выполняет задачи, API и серверная команда только ставят их; worker падает при старте, если объявление осталось без реализации.
- **Транзакционная постановка.** `JobQueue.enqueue(job, payload, { tx })` пишет задачу в транзакции модуля: откат — задачи нет, фиксация — задача выполнится, даже если worker в этот момент выключен.
- **Повторы и мёртвая очередь.** Упавшая задача повторяется по своим правилам, исчерпавшая повторы — уходит в `<имя>.dead` и остаётся там, пока оператор не разберётся.
- **Свипер дедлайнов** — общий каркас: раз в минуту, один запуск за раз, пакеты ограниченного размера, `FOR UPDATE SKIP LOCKED`, падение одной строки не останавливает остальные, бюджет времени на запуск.
- **Периодические задачи** — cron во времени `Asia/Almaty`; выражение считается из настроек на ходу, изменение действует без перезапуска; пропущенные запуски догоняются один раз.
- **Устойчивость.** Остановка worker: задачи получают 7 секунд, остальные возвращаются в очередь; задача процесса, умершего без сигнала, возвращается по истечении её срока; недоступная база не мешает старту и не роняет worker.
- **Видимость для оператора:** `operator jobs:status | jobs:dead | jobs:retry | jobs:delete | jobs:run`, в dev и тестах — `dev:jobs:fail`. Данные задач оператору не показываются (только имена полей) и в журнал не пишутся.
- **Очистка данных входа (D-054):** использованные, заменённые и истёкшие коды входа — через 7 дней, шаги входа — через 1 день, завершённые и истёкшие сессии — через 30 дней; сроки — настройки группы «Очистка». Действующие коды, шаги и сессии не удаляются никогда, `phone_verification` не трогается.

## Changes

Коммиты (каждый — только явно перечисленные файлы, D-024):

1. `4c495db` **Update project plan and state, add TASK-008 (Product Owner edits)** — правки Product Owner, найденные в рабочем дереве: `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-008.md`.
2. `f3550aa` **Add pg-boss and keep its queue schema in the project migrations** — `apps/api/package.json`, `pnpm-lock.yaml`, `apps/api/scripts/job-queue-schema.ts`, `apps/api/src/jobs/job-queue-schema.ts`, `job-queue-migrations.ts`, `job-queue-migrations.test.ts`, `infra/migrations/1789660668561_create-job-queue.sql`.
3. `6d479ae` **Run background jobs in the worker: queue, sweepers, schedules, dead letters** — каркас `apps/api/src/jobs/*` (объявления, реестр реализаций, `JobQueue`, `JobRunner`, `SweepRunner`, `JobAdmin`, `periodic_job_state`, dev-задача), каталог `apps/api/src/background-jobs.ts`, подключение в `app.module.ts`, `worker.module.ts`, `worker.ts`, команды в `operator.ts`, `orm-tables.ts`, `testing/database.ts`, обновлённые `database/schema-drift.test.ts` и `database/database.integration.test.ts`, миграция `1789660680048_create-periodic-job-state.sql`, тесты `jobs/*.test.ts` и `jobs/jobs.integration.test.ts`.
4. `456ccfa` **Clean up stale login codes, sign-in steps and sessions (TASK-008, D-054)** — `apps/api/src/modules/identity/cleanup/sign-in-data-cleanup.ts` и его интеграционный тест, экспорт в `modules/identity/index.ts`, источник сроков в `modules/settings/identity-settings.sources.ts` и `settings.module.ts`, группа «Очистка» в `registry/registry.ts` и `registry.test.ts`, `settings.integration.test.ts` (список групп), `background-jobs.ts` и `worker.module.ts` (подключение задач identity), `database.integration.test.ts` (откат индексов), миграция `1789660681238_add-sign-in-data-cleanup-indexes.sql`, строка группы в `ARCHITECTURE.md` 14 (её требует тест реестра).
5. `352acc7` **Document TASK-008 decisions in ARCHITECTURE 4.12, 13, 14 and CLAUDE.md** — `ARCHITECTURE.md` (версия 0.15, новый раздел 4.12, правки 5.12, 13.1–13.3, 15.3), `CLAUDE.md` (блок 0).
6. `e05e847` **Format orm-tables.ts** — `apps/api/src/orm-tables.ts`: `pnpm format:check` на итоговом состоянии нашёл расхождение с Prettier в файле из коммита 3 (сам файл в CI без этого не прошёл бы).

Ключевые файлы:

- `apps/api/src/jobs/job-definition.ts` — объявления задач, имена, `dailyAt`, имена мёртвых очередей.
- `apps/api/src/jobs/job-queue.service.ts` — экземпляр pg-boss процесса, фоновый старт с повторами, создание очередей, постановка задач (в том числе в чужой транзакции).
- `apps/api/src/jobs/job-runner.service.ts` — выполнение задач в worker, журнал, запись запусков, синхронизация расписаний из настроек.
- `apps/api/src/jobs/sweeper.ts` — каркас свипера (пакеты, точки сохранения, бюджет).
- `apps/api/src/jobs/job-admin.service.ts` — состояние очереди и мёртвая очередь для оператора.
- `apps/api/src/modules/identity/cleanup/sign-in-data-cleanup.ts` — три свипера очистки.

## Technical Decisions

Все значимые решения внесены в `ARCHITECTURE.md`, раздел **4.12 (I112–I119)**; версия документа поднята до 0.15, уточнены 5.12, 13.1–13.3, 14, 15.3.

- **I112. Схема очереди — миграция проекта, не автоустановка.** pg-boss запускается с `migrate: false` и при несовпадении версии отказывается работать. Миграция — SQL самого pg-boss без его `BEGIN`/`COMMIT`, с маркером версии; генератор `pnpm --filter api jobs:schema-migration generate`. Таблицы pg-boss намеренно не входят в сверку ORM-схемы (она читает только `public` и описывает то, что ведёт приложение); целостность схемы очереди проверяется `detectSchemaDrift()` в интеграционном тесте — это обоснование, которого требует AC-11.
- **I113. Объявление задач и очереди.** singleton → политика pg-boss `stately`; мёртвая очередь только у задач по требованию (у периодической повтор пропущенного запуска бессмыслен, а ежеминутный свипер завалил бы мёртвую очередь).
- **I114. Постановка в транзакции и идемпотентность обработчиков** — правило для всех будущих задач.
- **I115. Свипер**: `claim` с `FOR UPDATE SKIP LOCKED`, построчные точки сохранения, быстрый путь `applyBatch` с откатом на построчный, бюджет времени, исключение упавших строк до конца запуска.
- **I116. Расписания в Алматы из настроек**, догон пропущенного один раз, дедупликация при нескольких worker'ах; задержка запуска до ~35 с.
- **I117. Остановка, брошенные задачи, недоступность базы** — включая ограничение 7 с внутри общего предела процесса 10 с (4.7 I62) и фоновый старт очереди с повторами.
- **I118. Очистка данных входа**: «момент, когда строка перестала быть годной» = `COALESCE(consumed_at, expires_at)` (коды, шаги) и `COALESCE(revoked_at, expires_at)` (сессии) — отсюда следует, что действующее не удаляется никогда; под каждое выражение добавлен индекс.
- **I119. Журнал и команда оператора** — что пишется, чего не пишется никогда, таблица `periodic_job_state`.

## Verification

- `pnpm format:check` (корень) — **PASS** — `All matched files use Prettier code style!` (первый прогон нашёл `orm-tables.ts`, исправлено коммитом `e05e847`).
- `pnpm lint` (корень) — **PASS** — 12 задач Turborepo без ошибок.
- `pnpm typecheck` (корень) — **PASS** — 18 задач без ошибок.
- `pnpm test` (корень) — **PASS** — 15 задач; `@adclub/api`: 25 файлов, 247 тестов; всего по репозиторию 530 тестов.
- `pnpm test:integration` (корень, Testcontainers) — **PASS** — 8 файлов, 178 тестов, в том числе новые `src/jobs/jobs.integration.test.ts` (20 тестов) и `src/modules/identity/cleanup/sign-in-data-cleanup.integration.test.ts` (5 тестов).
- `pnpm build` (корень) — **PASS** — 11 задач, включая `expo export` мобильного.
- `pnpm --filter @adclub/api openapi:check` — **PASS** — `openapi.json matches the contract and the served routes`.
- `pnpm --filter @adclub/api openapi:compat --base HEAD~5` — **PASS** — `No changes detected. Contract is backward compatible` (контракт не менялся).
- `pnpm --filter api migrate` в dev — **PASS** — три новые миграции применены; `migrate:status` показывает 9 применённых, 0 ожидающих.
- Собранный worker и серверная команда (`node dist/worker.js`, `node dist/operator.js jobs:status`) — **PASS** — очередь стартует, задачи выполняются (проверено на dev-базе).
- `pnpm --filter api run verify:graceful-shutdown` — **NOT RUN локально** (на Windows `SIGTERM` не доставляется — известное ограничение, ARCHITECTURE 4.3 I22); выполняется в CI, см. ниже.
- CI на `main` (GitHub Actions) — **PASS** — прогон **35269773406** (`Format orm-tables.ts`, последний коммит кода): все шаги зелёные, включая `Integration test` и `Verify API and worker shut down gracefully on SIGTERM (Linux)`; прогон **35270250780** (`Add TASK-008 report`) — **success**. Эта строка с числом тестов и номерами прогонов уточнена отдельным коммитом после них (правка только в отчёте, кода не касается).

## UAT / E2E

Окружение: dev на машине разработки (Windows), Docker Compose (PostgreSQL 16, Redis, MinIO, Meilisearch), API `pnpm dev` на `:3000`, worker'ы `pnpm --filter api worker` и `node dist/worker.js`, серверная команда `pnpm --filter api operator …`.

1. **Очистка.** Обычным входом по коду заведены сессии (`POST /auth/login-code` → код с `/dev/login-codes` → `/auth/login-code/verify`), одна сессия завершена `POST /auth/logout`. Часть строк состарена в базе (минимальный срок хранения — 1 день, поэтому без «машины времени» дождаться было бы невозможно): у 102 отработавших кодов и 30 завершённых сессий даты сдвинуты на 40 дней назад. Дальше — **без ручного запуска**, дождался очередного запуска по расписанию: в журнале `Stale sign-in data deleted table=otp_challenge rows=102` и `table=session rows=30` (номеров телефонов в этих строках нет), в базе осталось 4 кода (те, что истекли сегодня — внутри 7 дней) и 35 сессий, все завершённые удалены, `phone_verification` осталось 43 строки (не тронуто). После очистки действующая сессия работает (`GET /auth/me` → 200), новый код входа выдаётся (`POST /auth/login-code` → 200).
2. **Мёртвая очередь.** `operator dev:jobs:fail --note "smoke"` → в журнале три попытки (`attempt=1/3`, `2/3`, `3/3`) и `Job failed permanently, moved to the dead letter queue` → `operator jobs:dead` показывает задачу с `attempts: 3`, текстом ошибки и `dataFields: ["note"]` (значение `note` не показывается) → `operator jobs:retry <id>` вернул задачу в очередь (`newJobId`), повторный `jobs:retry` того же идентификатора отвечает `No dead job …` → после новых трёх попыток задача снова в мёртвой очереди → `operator jobs:delete <id>` → `{"deleted":true}`, `jobs:dead` пуст.
3. **Два worker'а.** Одновременно работали два процесса (`node dist/worker.js` и `pnpm --filter api worker`). За минуты 19:56, 19:57, 19:58 в очереди ровно по одной задаче `identity.cleanup-sessions` на минуту (запрос по `pgboss.job`) — периодическая задача выполняется один раз за запуск.
4. **База упала.** `docker stop adclub-dev-postgres-1` при работающем worker'е: процесс жив, в журнале ограниченные по частоте предупреждения `Job queue error …` (13 строк за 40 секунд вместо потока на каждый опрос). После `docker start` тот же процесс без перезапуска снова выполняет задачи: `Job completed job=identity.cleanup-login-codes …` через ~20 секунд после возвращения базы.
5. **Остановка worker во время задачи** — **в dev не проверялось**: на Windows `SIGTERM` процессу не доставляется (ARCHITECTURE 4.3 I22). Оба исхода проверены интеграционными тестами на реальном PostgreSQL (задача успевает завершиться в пределах ограничения; не успевшая — возвращается в очередь и выполняется другим worker'ом; брошенная умершим процессом — возвращается надзором по истечении срока), а сам факт грациозного завершения обоих процессов по SIGTERM — шагом CI `verify:graceful-shutdown`.

## Acceptance Criteria

- **AC-1 — PASS** — очередь работает в worker (dev: `Job queue started role=worker`, `Worker consumes 4 job queues`); схема создаётся миграцией `infra/migrations/1789660668561_create-job-queue.sql` и описана в ARCHITECTURE 4.12 I112; интеграционный тест «is created by the migrations, at the version the installed pg-boss needs, without drift» сверяет `pgboss.version` с версией пакета и `detectSchemaDrift().ok`, тест «is never installed by pg-boss itself» показывает, что без миграции старт отказывает; API ставит задачи — тест «the API process puts jobs on the queue in its transactions (the real AppModule)».
- **AC-2 — PASS** — тест «puts a job on the queue only if the transaction commits»: задача из откатившейся транзакции не появляется в `pgboss.job` и не выполняется (проверено через 1,5 с ожидания), из зафиксированной — выполняется один раз; тест «runs a job committed while no worker was up once a worker starts» — задача, зафиксированная при выключенных worker'ах, выполняется после запуска.
- **AC-3 — PASS** — тест «retries a failing job by its rules until it succeeds» (попытки 1, 2, 3 с паузой ≥ 1,5 с и строками журнала `Job failed, will retry … attempt=1/4`); тест «moves a job that keeps failing to the dead letter queue; the operator sees, retries and deletes it» (мёртвая очередь, `dataFields: ["secret"]` без значения, повтор, повторный отказ `No dead job`, удаление); тот же путь настоящей серверной командой — тест «shows the operator the queue, a dead job without its data, and lets them retry and delete it» и сценарий 2 в dev.
- **AC-4 — PASS** — тест «never runs a singleton job twice at a time, whichever worker takes it» (максимум одновременных выполнений = 1 при двух worker'ах, часть постановок отклонена, обе стороны выполняли задачи); тест «runs each scheduled occurrence once with two workers» (в каждой полной минуте ровно один запуск); в dev — сценарий 3 (по одной задаче на минуту при двух процессах).
- **AC-5 — PASS** — тест «sweeps due rows in bounded batches; a failing row doesn't stop the others»: 25 просроченных строк при пакете 10 → `{processed: 24, failed: 1, batches: 3, complete: true}`, «отравленная» строка осталась необработанной (`processed_count = 0`), в журнале `Sweep row failed job=test.sweep row=<id>`; построчный режим — 12 строк, 2 пакета; бюджет времени — `{processed: 10, complete: false}` и продолжение следующим запуском. Тест «never handles one row in two parallel sweeps»: два параллельных запуска на 60 строк — сумма 60, у каждой строки `processed_count = 1`.
- **AC-6 — PASS** — тест «makes up a periodic run missed while no worker was up once, at its Almaty time»: расписание на час назад по Алматы (в UTC этот час ещё не наступил) и разрыв в 2 часа → ровно один запуск ежедневной задачи и не больше двух (пропущенный + текущая минута) у ежеминутной, вместо 120; тест «reads the Almaty time from the setting at every sync, without a restart»: изменение настройки `billing_notify_hour` меняет `cron` расписания работающего worker'а, `timezone = Asia/Almaty`, `missed: once`, и `previewSchedule("0 10 * * *", {tz: Asia/Almaty})` даёт `05:00Z` (проверка tz-базы среды). Поведение при пропусках описано в ARCHITECTURE 4.12 I116.
- **AC-7 — PASS** — тест «lets a running job finish when the worker stops within the limit» (остановка уложилась в предел, задача `completed`, после запуска другого worker'а повторно не выполнялась); тест «gives a job that outlives the stop limit back to the queue; it runs again elsewhere» (остановка < 2,5 с, задача в состоянии `retry`, журнал `Job interrupted (timed out or worker stopping) …`, затем выполнение вторым worker'ом попыткой 2); тест «gives the job of a worker that died mid-run back to the queue after its time limit». Проверка остановки в CI (`verify:graceful-shutdown`) — шаг CI-прогона, см. AC-12.
- **AC-8 — PASS** — тест «keeps a worker alive while PostgreSQL is away and goes on once it is back» (через TCP-прокси: worker жив, после возвращения базы выполняет задачу, поставленную во время недоступности); тест «starts while PostgreSQL is away and begins working once it is back» (`Job queue could not start, retrying` → `Job queue started role=worker (after retries)`); в dev — сценарий 4.
- **AC-9 — PASS** — тест «deletes codes, steps and sessions past their retention and keeps everything still in use» (удалены отработавшие код/шаг/сессия старше срока; остались действующий код, код шестидневной давности, только что использованный код, действующий шаг, сессия, завершённая 20 дней назад, и живая сессия; `phone_verification` цела; после очистки `GET /auth/me` → 200 и новый вход проходит; в журнале `Stale sign-in data deleted table=… rows=…` и нет номеров телефонов); тест «follows the retention settings…» (3 дня: при сроке 7 — остаётся, при сроке 2 — удаляется); тест «deletes more rows than fit in one batch, in batches» (600 строк, `batches=2`); в dev — сценарий 1.
- **AC-10 — PASS** — данные всех тестовых задач регистрируются как секреты (`rememberSecret`), номера телефонов — как коды (`rememberCode`); общая проверка `output-capture` в конце каждого интеграционного файла падает, если что-то из этого попало в вывод, — оба новых файла её проходят. Дополнительно: `expect(JSON.stringify(await admin.deadJobs())).not.toContain(secret)` и проверка отсутствия номеров в журнале очистки.
- **AC-11 — PASS** — новые ключи `cleanup_login_code_retention_days`, `cleanup_sign_in_step_retention_days`, `cleanup_session_retention_days` в реестре и в ARCHITECTURE 14 (тест реестра сверяет списки, отдельный тест держит умолчания D-054 7/1/30). Миграции обратимы: интеграционный тест откатывает их по одной (индексы очистки → `periodic_job_state` → схема `pgboss`) и снова применяет. Новая таблица `periodic_job_state` добавлена в `orm-tables.ts` и в сверку схемы; таблицы pg-boss в сверку не входят — обоснование в ARCHITECTURE 4.12 I112 (сверка читает только `public`; схему очереди ведёт библиотека, её целостность проверяет `detectSchemaDrift`). Контракт API не менялся: `openapi:check` и `openapi:compat` — «No changes detected».
- **AC-12 — PASS** — существующие тесты проходят без ослабления; изменены только ожидания, которые обязаны были измениться: список миграций и шаги отката (добавлены три новых), список таблиц ORM (+`periodic_job_state`), список групп настроек (+`cleanup`). Коммиты — по D-024, состав каждого приведён в разделе «Changes». CI на `main`: прогон **35269773406** (`Format orm-tables.ts` — последний коммит кода) — **success**, все шаги зелёные, включая `Integration test` и `Verify API and worker shut down gracefully on SIGTERM (Linux)`; прогон коммита с отчётом — **35270250780** (`Add TASK-008 report`) — **success**.
- **AC-13 — PASS** — `ARCHITECTURE.md` 0.15: новый раздел 4.12 (I112–I119), уточнены 5.12 (`periodic_job_state`), 13.1 (механизм реализован), 13.2 (строки очистки), 13.3 (проверка часового пояса), 14 (группа «Очистка»), 15.3; история изменений и версия обновлены. `CLAUDE.md` блок 0: структура (`apps/api/src/jobs`, каталог задач, модуль очистки), запуск worker'ов, раздел «Фоновые задачи в dev» (очередь, мёртвая очередь, ручной запуск очистки, сроки хранения, `dev:jobs:fail`, генерация миграции схемы), тесты и миграции.

## Errors & Fixes

- **Цикл импортов между `jobs` и `settings`.** Реализации источников настроек модуля `settings` наследуют абстракции `identity`, а задачи объявляет `identity` — прямой импорт `AppSettings` из `jobs` замкнул бы цикл (`identity → jobs → settings → identity`), который в CommonJS ломает `class extends` на этапе загрузки. Решение: в `jobs` объявлена абстракция `JobSettingsReader` (тип настроек импортируется только как тип), а привязку к `AppSettings` даёт модуль настроек — тот же приём, что для источников порогов в TASK-007.
- **Тест «догон пропущенного запуска» сначала не работал.** pg-boss ограничивает догон не только временем последнего прохода планировщика, но и датой создания самой строки расписания (иначе новая задача «доначисляла» бы пропуски за всю историю). Тест исправлен: строка расписания состаривается вместе с отметкой прохода. Само поведение — правильное и описано в ARCHITECTURE 4.12 I116.
- **Тест паузы между повторами был чувствителен к часам контейнера.** Пауза 1 с измерялась по часам тестового процесса, а `start_after` считается часами PostgreSQL в контейнере: расхождение в полсекунды роняло проверку. Пауза увеличена до 2 с, проверка — «не меньше 1,5 с» (ослаблением не является: без паузы интервал был бы миллисекунды).
- **Тест бюджета времени свипера был недетерминирован** (три быстрых пакета укладывались в бюджет). Переписан на построчный режим с известной длительностью: ровно один пакет из 10 строк и `complete: false`.
- **Пустой текст ошибки соединения в журнале.** При недоступной базе pg-boss отдаёт копию `AggregateError` с пустым сообщением (тот же случай, что 4.3 I21) — в журнале получалась строка без причины. Теперь такой случай пишется как `connection failed (no message)` рядом с именем очереди.
- **Тест singleton'а иногда не укладывался в ожидание** при параллельном прогоне всего набора (машина занята несколькими контейнерами). Ожидание увеличено до 60 с и добавлена диагностика (сколько задач принято, сколько не выполнено, что осталось в очереди), чтобы возможное будущее падение было разбираемым, а не «Timed out».

## Deviations

- **Сценарий «Остановка» в dev не пройден на машине разработки**: Windows не доставляет `SIGTERM` дочернему процессу (известное ограничение, ARCHITECTURE 4.3 I22). Оба исхода («успела завершиться» и «вернулась в очередь и выполнилась повторно»), а также случай умершего процесса проверены интеграционными тестами на реальном PostgreSQL; грациозное завершение процессов по сигналу продолжает проверяться шагом CI.
- **Сроки хранения в dev пришлось имитировать сдвигом дат в базе**: минимальная граница настроек — 1 день (ниже ставить нельзя, иначе очистка начнёт задевать данные, которыми пользуются сами потоки входа), поэтому «дождаться» устаревания за один сеанс невозможно. Сценарий очистки от этого не пострадал: удаление выполнено штатной задачей по расписанию, а не руками.
- Противоречий между TASK-008, `PRODUCT.md`, `PROJECT_STATE.md` и кодом не обнаружено; ошибок в документах Product Owner не нашёл.

## Known Issues / Risks

- **Запуск по расписанию опаздывает до ~35 секунд** (проход планировщика pg-boss раз в 30 с плюс опрос очереди). Для минутных свиперов и «человеческих» задач это незаметно, но продуктовые таймеры заявок должны считать это нормой: дедлайн живёт в данных, очередь только ускоряет переход.
- **Журнал периодических задач шумный**: три свипера × 2 строки на запуск ≈ 8,6 тыс. строк в сутки даже когда чистить нечего. Требование TASK-008 («старт и успех пишутся в журнал») выполнено буквально; уменьшение шума — в Future Improvements.
- **`jobs:status` читает таблицу задач pg-boss напрямую** (имя таблицы берётся из `getQueue`), поэтому зависит от внутренней схемы библиотеки. Риск удерживается проверкой версии схемы (миграция + юнит-тест) и `detectSchemaDrift` в интеграционном тесте: обновление pg-boss без миграции не пройдёт CI.
- **Удаление данных входа необратимо** и пока не попадает в журнал действий: `audit_log` появится в TASK-009. В журнале приложения остаётся число удалённых строк без персональных данных.
- **Миграция схемы очереди откатывается через `DROP SCHEMA pgboss CASCADE`** — вместе со схемой исчезают задачи в очереди. Для dev это правильный откат; в production такой шаг подпадает под политику необратимых изменений (4.7 I61) и требует отдельного разрешения.
- **Ручных действий при выкатке не требуется**, кроме обычного `migrate`: worker сам создаёт очереди и расписания при старте.

## Remaining Work

None.

## Future Improvements

- Метрики очереди (глубина, мёртвая очередь, длительность запусков) и алерты — уже запланировано в TASK-009; `periodic_job_state` и `jobs:status` дают для них готовые данные.
- Экран очереди в админке поверх `JobAdmin` (сейчас только серверная команда).
- Понизить уровень записей `Job started`/`Job completed` до `debug` для периодических задач, которым нечего делать, оставив `log` для запусков с работой.
- `useListenNotify` pg-boss (мгновенное пробуждение worker'а вместо опроса) — когда появятся задачи, чувствительные к задержке в секунды (уведомления по заявкам).
- Массовые операции с мёртвой очередью (`jobs:retry --job <name>` для всех записей очереди) — сейчас только по одной задаче; для одной падающей интеграции это может оказаться удобнее.
- Коммит `e05e847` («Format orm-tables.ts») логически принадлежит коммиту каркаса; неинтерактивная среда не даёт `git rebase -i`, поэтому он оставлен отдельным.

# TASK REPORT — TASK-002

## Status
COMPLETED

## Result
`apps/api` теперь настоящий каркас сервера, а не только health-эндпоинт:

- Конфигурация читается из переменных окружения и валидируется zod-схемой один раз при старте (`main.ts`/`worker.ts`), до создания Nest-приложения; невалидная конфигурация — читаемое сообщение и `process.exit(1)`, без утечки значений.
- API- и worker-процессы подключаются к PostgreSQL (`pg.Pool` + Drizzle), Redis (`ioredis`) и S3-совместимому хранилищу (`@aws-sdk/client-s3`) при старте, корректно закрывают их при завершении; ни один из процессов не падает, если зависимость недоступна при старте.
- `GET /health` (живость) и `GET /ready` (готовность: PostgreSQL, Redis, S3 — отдельно по каждой, 200/503) — раздельные эндпоинты; готовность реально восстанавливается после падения Redis без перезапуска сервера (проверено вручную).
- Обратимые миграции (`node-pg-migrate`, SQL-файлы в `infra/migrations`): применить / откатить / статус — три отдельные команды, с блокировкой от одновременного запуска. Первая миграция создаёт таблицу `account` (ARCHITECTURE 5.1) без какой-либо бизнес-логики поверх неё.
- Каркас доменных модулей `apps/api/src/modules/<name>` с границей на линте: заведён `identity` (таблица `account`); правило и способ добавления следующих модулей описаны в ARCHITECTURE 4/4.2.
- Единый формат ошибки (`{ code, message, details?, retryable }`, `packages/contracts/src/error.ts`) для валидации, 404, конфликта и внутренней ошибки; стек наружу не уходит, 5xx логируется целиком на сервере.
- Структурированные JSON-логи с `requestId` на каждый запрос, настраиваемым уровнем, без тел запросов и секретов.

## Changes

**Конфигурация и подключения** (`apps/api/src/config`, `database`, `redis`, `storage`):
- `config/env.schema.ts`, `config/load-env-file.ts`, `config/config.module.ts` — zod-схема окружения, загрузка `.env`, DI-обёртка (`APP_CONFIG`).
- `database/database.service.ts` (+`.module.ts`) — `pg.Pool` + Drizzle, `checkHealth()`, `onApplicationShutdown`.
- `redis/redis.service.ts` (+`.module.ts`) — `ioredis`, авто-переподключение, `checkHealth()`.
- `storage/storage.service.ts` (+`.module.ts`) — `S3Client` (MinIO-совместимый, `forcePathStyle`), `checkHealth()` через `ListBuckets`.

**Health/readiness** (`apps/api/src/health`): `health.module.ts`, `readiness.controller.ts`, `readiness.service.ts`, `readiness.service.test.ts`.

**Ошибки и валидация** (`apps/api/src/common`):
- `errors/http-exception.filter.ts` (+test), `errors/not-found.controller.ts`/`.module.ts`, `errors/index.ts`.
- `validation/zod-validation.pipe.ts`, `validation/zod-validation.exception.ts`, `validation/zod-validation.e2e.test.ts`.
- `logging/json-logger.service.ts` (+test), `logging/request-context.ts`, `logging/request-id.middleware.ts`, `logging/logging.interceptor.ts`.
- `health/measure-check.ts`, `health/with-timeout.ts` — общий таймаут-обёрнутый пробник зависимости.

**Домен и миграции**:
- `apps/api/src/modules/identity/{schema.ts,identity.module.ts,index.ts,schema.test.ts}`.
- `infra/migrations/1789583044021_create-account.sql`.
- `apps/api/scripts/migrate-status.ts`; `apps/api/package.json` — скрипты `migrate`, `migrate:down`, `migrate:status`, `migrate:create`.

**Контракт** (`packages/contracts/src`): `error.ts`(+test), `readiness.ts`(+test), обновлён `index.ts`.

**Граница модулей**: `packages/config/eslint/rules/no-module-internals-import.js`, подключено в `apps/api/eslint.config.js`.

**Wiring**: `apps/api/src/app.module.ts`, `worker.module.ts`, `main.ts`, `worker.ts` переписаны под `forRoot(config)`.

**Тесты**: `apps/api/src/database/database.integration.test.ts` (Testcontainers PostgreSQL), `apps/api/vitest.integration.config.ts`, изменён `vitest.config.ts` (исключает `*.integration.test.ts`).

**Инфраструктура репозитория**: `.env.example` (`LOG_LEVEL`, `S3_REGION`), `.github/workflows/ci.yml` (+шаг `pnpm test:integration`), корневые `package.json`/`turbo.json` (+ таск `test:integration`).

**Документация**: `ARCHITECTURE.md` 0.4 → 0.5 (раздел 4 дополнен структурой `modules/<name>`, новый раздел 4.2 с решениями I10–I20, уточнён 15.3, подтверждён ORM в 3.4).

Новые прямые зависимости `apps/api`: `pg`, `drizzle-orm`, `ioredis`, `@aws-sdk/client-s3`, `zod`, `dotenv`; dev: `node-pg-migrate`, `@types/pg`, `@testcontainers/postgresql`, `supertest`, `@types/supertest`.

## Technical Decisions
Значимые решения зафиксированы в ARCHITECTURE.md 4 и 4.2 (I10–I20). Коротко, самое важное:

- **ORM подтверждён — Drizzle**; **инструмент миграций — `node-pg-migrate`**, не встроенный `drizzle-kit` (у того нет отслеживаемого отката, а AC-3 требует именно цикл применить/статус/откатить). Drizzle-схема синхронизируется с SQL-миграциями вручную — осознанный компромисс при одной таблице (I10, I11).
- **Граница доменных модулей** — собственное ESLint-правило без новой зависимости (I12); структура `apps/api/src/modules/<name>/index.ts` и правило добавления новых модулей описаны в ARCHITECTURE 4.
- **Формат ошибок** — в `packages/contracts`, единый глобальный `HttpExceptionFilter` (I13).
- **Конфигурация** — zod, парсится до старта Nest, не через `@nestjs/config` (I16).
- **Логирование** — собственный JSON-логгер + `AsyncLocalStorage` для request id, без новой зависимости вроде `nestjs-pino` (I18).
- **Три находки, обнаруженные только реальным запуском (не тестами)**, все исправлены и задокументированы как факты об инструментах/фреймворке, важные для следующих задач:
  - **I14**: собственные контроллеры корневого модуля Nest регистрирует раньше контроллеров из `imports` — catch-all 404 обязан жить в отдельном модуле, импортированном последним, иначе перехватывает все маршруты.
  - **I15**: `pg.Pool` и `ioredis`-клиент обязаны иметь обработчик `'error'`, иначе обрыв соединения роняет процесс необработанным исключением Node — без этого требование «сервер не падает при недоступности зависимости» невыполнимо.
  - **I19 (важно для всех следующих задач apps/api)**: конструкторная инъекция Nest-провайдера по типу класса **не работает надёжно под `pnpm dev`** (`tsx`/esbuild) без явного `@Inject(Класс)` — работает под `tsc`-сборкой, но `pnpm dev` отвечал 500 на любой запрос. Исправлено везде в этой задаче; правило зафиксировано в ARCHITECTURE 4.2 I19 для будущего кода.
  - **I20**: access-лог логировал неверный статус-код для ошибочных ответов (`tap` читал `response.statusCode` до того, как фильтр его выставил) — переписан на слушатель события `'finish'`.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` (весь repo, включая новое правило границы модулей) — PASS
- `pnpm typecheck` (весь repo) — PASS
- `pnpm test` (юнит, весь repo, 29 тестов в `apps/api` + остальные пакеты) — PASS
- `pnpm test:integration` (Testcontainers PostgreSQL, 8 тестов: миграции вверх/вниз/вверх, запрос к таблице, readiness при падении БД) — PASS, локально
- `pnpm build` (весь repo, включая `apps/api` → `dist/`) — PASS
- Ручной цикл миграций на локальном `postgres:16` (не Testcontainers, реальный dev-контейнер): `migrate` → `migrate:status` (1 applied) → `migrate:down` → `migrate:status` (0 applied, 1 pending) → `migrate` → `migrate:status` (1 applied) — PASS, вывод команд соответствует ожиданиям на каждом шаге
- Реальный запуск собранного сервера (`node dist/main.js`) и **отдельно** `pnpm dev` (`tsx watch`) — оба варианта проверены; `pnpm dev` проверен только после исправления I19 (до исправления был сломан — см. Errors & Fixes)
- `docker compose -f infra/docker/compose.dev.yml stop redis` → `curl /ready` (503, `redis: error`) → `curl /health` (200) → `start redis` → `curl /ready` (200, без перезапуска сервера) — PASS
- `DATABASE_URL="not-a-valid-url" S3_SECRET_KEY="" node dist/main.js` → понятное сообщение с именами переменных, без значений, `exit 1` — PASS
- Воспроизведение AC-6: временный файл с прямым импортом `modules/identity/schema` в другом месте `apps/api/src` → `eslint` падает с понятным сообщением; импорт через `modules/identity` (index.ts) — проходит; временный файл удалён — PASS
- CI (`.github/workflows/ci.yml`): шаг `pnpm test:integration` добавлен и использует ту же команду, которая пройдена локально; реальный прогон в GitHub Actions в рамках этой сессии не запускался и не наблюдался — NOT RUN (см. Known Issues)

## UAT / E2E
Пройдено вручную на машине разработки (Windows, Docker Desktop, реальные `postgres:16`/`redis:7`/MinIO из `infra/docker/compose.dev.yml`):

- «Чистая машина» (частично): `docker compose up -d` → `pnpm install` → `pnpm --filter api migrate` → `pnpm dev` → `curl :3000/ready` → все три зависимости `ok`. Полностью «с нуля» (пустой `.env`, ранее не установленный `node_modules`) не проверялось — проверено на уже настроенном дереве репозитория с ранее применённой миграцией; сама команда/поведение при первом применении миграции проверены отдельно (сброс таблицы → `migrate`).
- «Падение зависимости»: остановка/восстановление Redis через `docker compose stop/start redis` при работающем сервере (`pnpm dev`) — readiness корректно переходит `ok → degraded (redis: error) → ok`, `/health` остаётся 200 всё время, PID сервера не менялся.
- «Плохой запрос»: невалидное тело — только через тестовый fixture-контроллер (`zod-validation.e2e.test.ts`), не curl'ом к боевому маршруту — в TASK-002 нет ни одного боевого эндпоинта с телом (появятся в TASK-003+). 404 на несуществующий маршрут и его формат — реальным `curl` к работающему серверу.
- «Миграции туда-обратно»: реальные команды `pnpm --filter api migrate` / `migrate:status` / `migrate:down` на локальном dev-Postgres, вывод каждой команды сверен вручную (см. Verification).

## Acceptance Criteria
- `AC-1 — PASS` — `DATABASE_URL="not-a-valid-url" S3_SECRET_KEY="" node dist/main.js` → `Invalid configuration: DATABASE_URL: ..., S3_SECRET_KEY: ...`, `exit 1`, без значений; валидная конфигурация — `node dist/main.js` и `node dist/worker.js` стартуют (лог `API listening on port 3000` / `Worker process started`).
- `AC-2 — PASS` — `/health` и `/ready` разные контроллеры; `/ready` возвращает `{status, checks: {postgres, redis, s3}}`; остановка Redis → `/ready` 503 с `redis.status = "error"`, `/health` остаётся 200; восстановление Redis → `/ready` 200 без перезапуска процесса (тот же PID).
- `AC-3 — PASS` — локально: `migrate` → `migrate:status` (1 applied) → `migrate:down` → `migrate:status` (0 applied, 1 pending) → `migrate` → `migrate:status` (1 applied); в CI: тот же цикл входит в `database.integration.test.ts` (реальные вызовы `node-pg-migrate up`/`down` дочерним процессом) на чистой Testcontainers-базе — 8/8 тестов PASS локально; сам прогон в реальном GitHub Actions не наблюдался (см. Known Issues).
- `AC-4 — PASS` — `infra/migrations/1789583044021_create-account.sql` создаёт `account` (`id`, `phone`, `email`, `status`, `consent_phone_share_at`, `consent_version`, `created_at`, `updated_at`) точно по ARCHITECTURE 5.1; `apps/api/src/modules/identity` содержит только определение таблицы и пустой Nest-модуль, без логики.
- `AC-5 — PASS` — единый формат `{code, message, details?, retryable}` подтверждён: невалидное тело → 400 `VALIDATION_ERROR` (e2e-тест, реальный HTTP-запрос к тестовому fixture); неизвестный маршрут → 404 `NOT_FOUND` (реальный `curl`); внутренняя ошибка → 500 `INTERNAL_ERROR` без стека и деталей (юнит-тест filter'а); формат описан в `packages/contracts/src/error.ts`, используется сервером и тестовым клиентом (`zod-validation.e2e.test.ts` типизирует ответ через `ApiErrorResponse`).
- `AC-6 — PASS` — воспроизведено: временный прямой импорт `../modules/identity/schema` из `src/health` → `eslint` падает (`local/no-module-internals-import`) с понятным сообщением; импорт `../modules/identity` (через `index.ts`) — проходит; временный файл удалён, в диффе не остался.
- `AC-7 — PASS (локально)` — `pnpm test:integration` (Testcontainers PostgreSQL 16): миграции применяются, `INSERT`/`SELECT` к `account` проходит, `checkHealth()` отражает остановку контейнера как `error` без падения тестового процесса. В реальном CI (GitHub Actions) шаг добавлен, но не наблюдался — см. Known Issues.
- `AC-8 — PASS` — структурированный JSON на каждый запрос с `requestId` (`X-Request-Id`, тот же id в логе); access-лог `${method} ${url} ${status} ${duration}ms`, без тела и заголовков; секреты (пароли БД/S3, PAT) нигде не встречались в логах за время проверки.
- `AC-9 — PASS` — ARCHITECTURE.md дополнен (0.4 → 0.5): ORM, инструмент миграций, структура и правило добавления доменных модулей, формат ошибок — разделы 3.4, 4, 4.2.

## Errors & Fixes
- **`pnpm dev` (tsx) отвечал 500 на любой запрос** (`TypeError: Cannot read properties of undefined (reading 'error')` внутри собственного `HttpExceptionFilter`), хотя собранный сервер (`node dist/main.js`) и все тесты работали. Причина — esbuild (транспилятор `tsx`) не всегда сохраняет импорт класса, используемого в файле только как тип параметра конструктора, из-за чего Nest получал `undefined` вместо токена внедрения (`JsonLoggerService` в `HttpExceptionFilter`/`LoggingInterceptor`; `DatabaseService`/`RedisService`/`StorageService` в `ReadinessService`; `ReadinessService` в `ReadinessController`). Исправлено — везде добавлен явный `@Inject(Класс)`. Найдено и исправлено до завершения задачи; повторно проверено `pnpm dev` + `curl` на `/health`, `/ready`, неизвестный маршрут, сценарий с падением Redis.
- **Nest регистрировал catch-all 404-маршрут раньше `/health` и `/ready`**, когда `NotFoundController` был объявлен прямо в `controllers` корневого `AppModule` — маршрут `{/*, ALL}` перехватывал всё. Исправлено переносом в отдельный `NotFoundModule`, импортированный последним. Найдено реальным запуском и `curl`, не тестами (юнит/e2e-тесты собирают свои мини-модули и не воспроизводят порядок маршрутов полного `AppModule`).
- **Необработанный `'error'` на `pg.Pool` ронял процесс** при обрыве соединения (обнаружено интеграционным тестом: остановка Testcontainers-контейнера посреди теста роняла тестовый процесс необработанным исключением). Добавлен обработчик `pool.on('error', ...)` (по аналогии с уже имевшимся у `ioredis`).
- **Access-лог показывал `200` для ответов с ошибкой** (например, `GET /nope` реально отвечал 404, но лог показывал 200) — `LoggingInterceptor` читал `response.statusCode` в `rxjs`-`tap` до того, как `HttpExceptionFilter` успевал его выставить. Исправлено — слушатель `response.on('finish', ...)`, читающий финальный статус после того, как ответ действительно отправлен. Найдено чтением access-лога при ручной проверке AC-8/AC-5, не тестами.
- **`node-pg-migrate` генерировал имя файла со слэшем `create-account`** (дефис вместо подчёркивания из `create_account`) — не ошибка, просто поведение инструмента; принято как есть.
- **`dotenv@17` печатал рекламный баннер** («tip») при каждой загрузке `.env`, включая ссылку на сторонний сервис — не связано с задачей по сути, но нежелательный шум в логах (и потенциально в проде). Подавлено опцией `quiet: true`.
- Обнаружена и НЕ тронута системная особенность: `Stop-Process` в PowerShell не доставляет `SIGTERM`/`SIGINT` (Windows не поддерживает эти сигналы так же, как POSIX) — грациозное завершение по сигналу подтвердить на этой машине нельзя; код содержит стандартные `process.on('SIGINT'/'SIGTERM')` + `enableShutdownHooks()`/`onApplicationShutdown`, которые сработают на Linux (реальная среда деплоя, ARCHITECTURE 15.1) — см. Known Issues.

## Deviations
- CLAUDE.md, раздел «0. Проект» (не редактируется этой задачей — правило CLAUDE.md 1), предугадывал команды `pnpm --filter api migrate` / `migrate:generate`. Фактические команды — `migrate`, `migrate:down`, `migrate:status`, `migrate:create` (нет diff-генерации: миграции пишутся вручную в SQL, `migrate:create` только создаёт файл-заготовку). Расхождение стоит учесть при следующем обновлении блока «0. Проект».
- ARCHITECTURE 15.3 (черновик) относил Meilisearch к тройке проверок `/ready`. TASK-002 явно исключает Meilisearch (эта интеграция — EPIC-15), поэтому readiness проверяет только PostgreSQL/Redis/S3; ARCHITECTURE.md обновлён, чтобы не противоречить факту (раздел 15.3, решение 4.2 I17).
- Требование 5 (AC-5) «невалидное тело» продемонстрировано на тестовом fixture-контроллере, а не на боевом эндпоинте — в TASK-002 намеренно нет ни одной бизнес-ручки с телом запроса (это TASK-003+). Инфраструктура (pipe + фильтр) полностью реализована и покрыта тестом; подключение к первому боевому эндпоинту — когда он появится.

## Known Issues / Risks
- **CI не запускался фактически** в рамках этой сессии (нет доступа к GitHub Actions отсюда) — шаг `pnpm test:integration` добавлен в `.github/workflows/ci.yml` и выполняет ровно ту же команду, которая пройдена локально (8/8 PASS на Testcontainers), но реальный прогон на раннере GitHub не подтверждён. Testcontainers на `ubuntu-latest` обычно работает без дополнительной настройки (Docker предустановлен), но это не проверено напрямую.
- **Грациозное завершение по SIGTERM/SIGINT не подтверждено на этой машине** (Windows не доставляет POSIX-сигналы через `Stop-Process`) — код реализован стандартно и должен работать на Linux (реальный prod/staging), но локальная UAT-проверка именно этого пути невозможна на текущей машине разработки. Аналогичное ограничение уже зафиксировано в TASK-001-REPORT для другого сценария (T-2).
- **Drizzle-схема (`modules/identity/schema.ts`) синхронизируется с SQL-миграцией вручную** — при росте числа таблиц риск расхождения растёт; интеграционный тест ловит расхождение только для того, что реально тестируется (сейчас — `account`). См. Future Improvements.
- `.env` (не в git) дополнен переменными `apps/api` (`PORT`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, `S3_*`) со значениями по умолчанию из `.env.example` — раньше файл их не содержал. Секреты не добавлялись и не менялись.
- `docker compose -f infra/docker/compose.dev.yml` на машине уже был запущен в начале сессии (не мной) — состояние после задачи: все четыре сервиса здоровы, `account` — применённая миграция.

## Remaining Work
None.

## Future Improvements
- Рассмотреть `drizzle-kit` (только для чтения/сверки существующей схемы, не для генерации миграций) при заметном росте числа таблиц — снизит риск ручного рассинхрона между `schema.ts` и SQL-миграциями (см. 4.2 I11).
- Дешёвое улучшение (вне scope TASK-002): CI-проверка `pnpm test:integration` на реальном раннере GitHub Actions при следующем пуше подтвердит, что Testcontainers работает там без доп. настройки — сейчас это предположение, а не факт.
- Регулярный (не разовый) прогон регламента переезда (ARCHITECTURE 15.1) и резервного восстановления с этой БД появится ближе к этапу C/D — TASK-002 их не создавал и не должен был.

# TASK REPORT — TASK-005.A

## Status
COMPLETED

## Result
Девять дефектов и пропусков, найденных сквозной проверкой TASK-001…TASK-005, закрыты; продуктовое поведение не менялось.

- `/ready` больше не отдаёт текст ошибки драйвера, адреса, порты и имена пользователей — причина отказа только в логе.
- ARCHITECTURE.md содержит политику необратимых изменений схемы БД (удаление/переименование, смена типа, преобразование данных).
- CLAUDE.md явно называет шаг создания `.env` из `.env.example`; шаг проверен на чистой копии репозитория (API, worker, миграции поднялись).
- API и worker завершаются по сигналу через общий код с таймаутом и защитой от повторного сигнала; CI проверяет оба процесса, не только worker.
- `SESSION_ADMIN_WEB_TTL_SECONDS` > 12 часов не проходит валидацию конфигурации — процесс не стартует.
- Образ MinIO в dev закреплён на конкретном релизе, не `latest`.
- Второй слой линта ловит относительный импорт в чужой пакет; оба правила границ (пакетов и модулей `apps/api`) покрыты автотестами.
- Отказ по SMS-лимиту IP больше не расходует SMS-счётчик номера (порядок проверок изменён).

## Changes

| Коммит | Файлы | Суть |
|---|---|---|
| `5b7d790` | `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/*` | Правки Product Owner (см. AC-1) |
| `77659e9` | `apps/api/src/health/readiness.service.ts(.test.ts)`, `session.integration.test.ts` | Санитизация `/ready`: причина только в логе |
| `56568a6` | `login-code.service.ts`, `login-code.integration.test.ts` | Порядок проверки SMS-лимитов: IP до номера |
| `f0d0144` | `apps/api/src/common/shutdown/*`, `main.ts`, `worker.ts`, `scripts/verify-graceful-shutdown.ts`, `.github/workflows/ci.yml` | Общий грациозный shutdown с таймаутом и идемпотентностью; CI проверяет API и worker |
| `9562c42` | `apps/api/src/config/env.schema.ts(.test.ts)`, `.env.example` | Верхняя граница `SESSION_ADMIN_WEB_TTL_SECONDS` |
| `599a8b2` | `infra/docker/compose.dev.yml` | Образ MinIO закреплён на релиз |
| `9cd3904` | `packages/config/eslint/*`, `apps/api/eslint.config.js`, `pnpm-lock.yaml` | Правило `no-relative-package-import` + автотесты обоих правил границ |
| `900b1d7` | `CLAUDE.md` | Шаг `.env` в блоке 0 |
| `9da6ebc` | `ARCHITECTURE.md` | Версия 0.10, раздел 4.7, политика необратимых миграций |

## Technical Decisions

Все внесены в ARCHITECTURE.md 0.10, раздел 4.7 (I60–I66):

- **I60** — санитизация `/ready` на уровне `ReadinessService.check()`, а не в самих `checkHealth()` (у них причина нужна для лога при старте процесса). Изменение контракта не потребовалось: поле `error` было и осталось необязательным.
- **I61** — политика необратимых изменений схемы: расширяющая миграция (dual-write) → отдельная миграция переноса данных → удаление старого только после подтверждения в проде, с обязательным свежим восстановимым бэкапом и явным разрешением по CLAUDE.md 11.
- **I62** — общий `installGracefulShutdown` вместо `app.enableShutdownHooks()` (не завершает процесс сам) и раздельной ручной логики worker.
- **I63** — верхняя граница TTL админской сессии в zod-схеме, а не только в значении по умолчанию.
- **I64** — тег MinIO закреплён (`RELEASE.2025-04-08T15-41-24Z`, проверено — существует на `quay.io`), выбор `quay.io` не менялся.
- **I65** — `no-relative-package-import` как второй слой границы пакетов; оба правила границ покрыты тестами через `eslint.Linter.verify()`, `packages/config` получил `test`-скрипт (ранее не было).
- **I66** — порядок проверки SMS-лимитов: IP до номера, без необходимости в `refund`.

## Verification

- `pnpm format:check` — PASS
- `pnpm lint` (полный прогон без кэша `--force`) — PASS, все 11 пакетов, включая новый `packages/config`
- `pnpm typecheck` — PASS
- `pnpm test` — PASS, 368 тестов (было 353): i18n 8, contracts 61, domain 51, api-client 23, mobile 19, api 197 (включая 4 новых теста `graceful-shutdown.test.ts`, 44 в `env.schema.test.ts`, обновлённый `readiness.service.test.ts`), config 9 (новый пакет с тестами)
- `pnpm test:integration` (реальные PostgreSQL и Redis, Testcontainers) — PASS, 100 тестов (было 99): +1 (SMS IP/phone ordering), плюс обновлённые ассерты санитизации `/ready` в существующих сценариях отказа Redis и S3
- `pnpm --filter @adclub/api openapi:check` — PASS
- `pnpm --filter @adclub/api openapi:compat --base 6dc8518` (последний коммит main до этой задачи) — PASS, «No changes detected», без трейлера
- `pnpm --filter api run verify:graceful-shutdown` локально (Windows) — BLOCKED: `Stop-Process`/`child.kill("SIGTERM")` на Windows не доставляет POSIX-сигнал (тот же документированный технический факт, что и в TASK-002/TASK-002.A) — worker/API не получают SIGTERM, скрипт таймаутится на ожидании выхода. Достоверно проверено только в CI (Linux)
- CI на `main`: коммит `9da6ebc` — run 35205570193 — success; коммит с отчётом `0501a78` — **run 35205888828 — success** (`gh run watch`), оба включают шаг «Verify API and worker shut down gracefully on SIGTERM (Linux)» для обоих процессов

## UAT / E2E

- **Чистая копия репозитория (AC-4):** `git clone` в отдельную директорию → `cp .env.example .env` → `docker compose -f infra/docker/compose.dev.yml up -d` (пересоздал только контейнер `minio` из-за смены тега — вытянул новый образ, стартовал) → `pnpm install` → `pnpm build` → `pnpm --filter api migrate` («No migrations to run!», база уже была на актуальной версии — использовалась постоянная dev-БД, не пустая; сам факт применения проверен интеграционным тестом `database.integration.test.ts`) → `node apps/api/dist/main.js`: `GET /health` → `{"status":"ok",...}`, `GET /ready` → `{"status":"ok","checks":{"postgres":"ok","redis":"ok","s3":"ok"}}` → `node apps/api/dist/worker.js`: лог `Worker process started`. Оба процесса остановлены (`Stop-Process -Force`), директория удалена.
- **`/ready` при отказе зависимости, реальный HTTP-запрос:** пройдено интеграционными тестами (`login-code.integration.test.ts` — отключение Redis через `TcpProxy`, `session.integration.test.ts` — недостижимый S3): тело ответа без адреса/порта/текста драйвера, причина — в перехваченном выводе процесса (`logs`/`allLogs`).
- Ручная проверка «остановить PostgreSQL → `/ready` → поднять → снова ok» — не выполнялась отдельно в этой задаче: то же поведение (без содержания в ответе) уже покрыто существующим сценарием TASK-002/TASK-002.A (`database.integration.test.ts`, `readiness reports PostgreSQL as unavailable once it stops`) плюс новым юнит-тестом на санитизацию (`readiness.service.test.ts`).

## Acceptance Criteria

- **AC-1** — PASS — коммит `5b7d790` содержит только `PROJECT_PLAN.md`, `PROJECT_STATE.md` и новые файлы `tasks/*`; состав каждого последующего коммита — таблица в разделе Changes, проверен `git status`/`git diff --cached --stat` перед каждым коммитом.
- **AC-2** — PASS — `readiness.service.test.ts` (новый тест: реалистичная строка ошибки Postgres с адресом/логином не попадает в ответ), интеграционные тесты Redis/S3-outage через реальный HTTP `GET /ready` (тело без деталей, причина в логе); `openapi:check` и `openapi:compat --base 6dc8518` — PASS.
- **AC-3** — PASS — ARCHITECTURE.md 4.7 I61.
- **AC-4** — PASS — см. UAT/E2E: чистая копия репозитория, API/worker/миграции подняты по инструкции CLAUDE.md, команды и результат приведены выше.
- **AC-5** — PASS — CI run 35205888828, шаг «Verify API and worker shut down gracefully on SIGTERM (Linux)» зелёный для обоих процессов; ограничение по времени и повторный сигнал — `graceful-shutdown.test.ts` (4 теста: успешный выход, игнор второго сигнала, принудительный выход по таймауту, выход с кодом 1 при ошибке `close()`).
- **AC-6** — PASS — `env.schema.test.ts`, тест «never lets an admin session live longer than 12 hours, whatever the setting».
- **AC-7** — PASS — `infra/docker/compose.dev.yml`, тег проверен на существование запросом к `quay.io`.
- **AC-8** — PASS — `no-relative-package-import.test.js` (4 теста) и новый `no-module-internals-import.test.js` (5 тестов, ранее тестов не было).
- **AC-9** — PASS — `login-code.integration.test.ts`, тест «does not spend a phone's SMS limit when the IP limit is what refused the request».
- **AC-10** — PASS — все существующие тесты проходят без ослабления (см. Verification); CI на `main`, коммит `9da6ebc` — run **35205888828 — success** (report commit `0501a78`).
- **AC-11** — PASS — ARCHITECTURE.md версия 0.10 и история изменений обновлены; CLAUDE.md блок 0 дополнен шагом `.env`.

## Errors & Fixes

- Первая версия `no-relative-package-import` и вынесенный в `apps/api/eslint.config.js` `no-module-internals-import` регистрировали один и тот же ключ плагина `local` в двух пересекающихся flat-config объектах ESLint — `pnpm lint` падал с `ConfigError: Cannot redefine plugin "local"`. Исправлено: оба правила зарегистрированы один раз в `packages/config/eslint/base.js`, `apps/api/eslint.config.js` только включает вторую.
- Тесты `eslint.Linter.verify()` с абсолютным путём (`/repo/...`) не находили конфигурацию (`No matching configuration found`) — flat-config `files`-паттерны сопоставляются с путём относительно `cwd`, не с абсолютным. Исправлено на относительные пути в фикстурах тестов.
- Первая версия теста `no-module-internals-import` ошибочно считала `session`/`account` отдельными модулями (а не подпапками одного модуля `identity`) — два теста falsely failed, вскрыв неверное предположение в самом тесте, не в правиле. Тесты переписаны по факту реальной структуры `apps/api/src/modules/identity/{session,account,login-code}` и реального кода (`account.service.ts`/`sign-in.service.ts`, которые уже импортируют друг у друга через `../session/...`).
- `pnpm format:check` изначально падал на `readiness.service.test.ts` (форматирование новых строк) — исправлено `prettier --write`.

## Deviations

- AC-4 проверялся на общей для машины разработки постоянной dev-базе (`docker compose` поднимает контейнеры с именованными томами, общими для любой копии репозитория на этой машине), а не на полностью пустой БД: `pnpm --filter api migrate` вернул «No migrations to run!» вместо применения миграций с нуля. Само применение миграций с нуля на реальном PostgreSQL уже покрыто интеграционным тестом (`database.integration.test.ts`, полный цикл up/down/up), поэтому это не открытый риск, но формально «поднялись миграции» проверено идемпотентностью команды, а не первым применением.
- `docker compose up -d` в чистой копии пересоздал контейнер `minio` (из-за смены тега) в общем для машины docker-контексте (тот же `name: adclub-dev`, что и в основной рабочей копии) — том `minio-data` сохранён, данные не потеряны, но это разделяемый побочный эффект проверки AC-4, о котором стоит знать.

## Known Issues / Risks

- `verify:graceful-shutdown` не может быть проверен локально на Windows (документированное ограничение ещё с TASK-002/TASK-002.A) — единственное достоверное подтверждение факта грациозного завершения обоих процессов сейчас — CI (Linux), что и есть требование AC-5.
- Политика необратимых изменений схемы (4.7 I61) впервые понадобится в реальной задаче, когда в модели данных появится первое удаление/переименование колонки — тогда её и стоит перепроверить на практике.

## Remaining Work
None.

## Future Improvements

- Продуктовый вопрос «возврат SMS-попытки в счётчик номера при недоставке ни одним каналом» (упомянут в TASK-005.A как открытый) остаётся вне этой задачи.
- Список сессий и метрики observability из ARCHITECTURE 15.3 могли бы получить отдельную метрику «readiness degraded по <зависимости>» вместо только структурированного лога — не требовалось AC этой задачи.

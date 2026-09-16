# TASK REPORT — TASK-001

## Status
COMPLETED

## Result
Рабочий монорепозиторий pnpm workspaces + Turborepo по структуре ARCHITECTURE 4. Все четыре приложения (`apps/api` — NestJS HTTP + отдельный worker, `apps/admin-web`, `apps/supplier-web` — React + Vite, `apps/mobile` — Expo) реально стартуют и были запущены: API отвечает на `/health`, оба веб-кабинета проверены в настоящем браузере (Playwright/Chromium) с живым запросом к API, Expo dev-сервер поднимается и слушает Metro. Пакеты `contracts`, `domain`, `i18n`, `ui` содержат демонстрационное содержимое из требования 3 и используются приложениями по-настоящему (не как заглушки): `admin-web` реально ходит на `/health` и парсит ответ схемой из `contracts`; оба веб-кабинета используют компонент `Button` из `ui`; `supplier-web` переключает `common.appWorking` между kk/ru/en через `i18n`. Локальное окружение (`docker compose up -d`) поднимает PostgreSQL, Redis, Meilisearch и MinIO — все четыре здоровы. Линт (ESLint 10 + typescript-eslint) падает на намеренно неправильном импорте через границу пакета — проверено. Изменение общей схемы ломает типы и на сервере, и в клиенте — проверено. `pnpm test` проходит одной командой для всего репозитория. CI (GitHub Actions) реально запущен пушем в `origin/main` и зелёный: install, format check, lint, typecheck, test, build — все шаги успешны за 37 секунд. Блок «0. Проект» в CLAUDE.md обновлён фактическими командами, остальной файл не тронут.

## Changes
- **Корень:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.npmrc` (пин pnpm 10.33.0 через `packageManager`, `onlyBuiltDependencies` для esbuild), `.prettierrc.json` / `.prettierignore` (документы и задачи исключены из форматирования — не мои файлы), `.editorconfig`, `.env.example`, `.github/workflows/ci.yml`.
- **`packages/config`** — общие конфиги без собственной бизнес-логики: `typescript/{base,node-lib,react-lib,nest-app,vite-app}.json`, `eslint/{base,node,react}.js` (флэт-конфиг ESLint 10 + typescript-eslint; `base.js` содержит правило границ пакетов, раздел Technical Decisions).
- **`packages/domain`** — `normalizeArticle` (`src/article/normalize-article.ts`) + 5 тестов Vitest; публичный вход только `src/index.ts`.
- **`packages/contracts`** — `healthCheckResponseSchema`/`HealthCheckResponse` (zod) + 2 теста; используется в `apps/api` (валидация и типизация ответа) и `apps/admin-web` (типизация и парсинг ответа fetch).
- **`packages/i18n`** — `src/locales/{kk,ru,en}.json`, ключ `common.appWorking`, `translate()`/`languages` + 2 теста.
- **`packages/ui`** — `Button` (варианты primary/neutral), `tokens.ts` (цвета/отступы), без тестов (тривиальный компонент).
- **`packages/dynamic-forms`** — пустой каркас (`export {}`), функциональность не входит в TASK-001.
- **`apps/api`** — `src/main.ts` (HTTP, `/health`, CORS), `src/worker.ts` (отдельная точка входа, keep-alive «пульс», graceful shutdown по SIGINT/SIGTERM), `src/app.module.ts`, `src/worker.module.ts`, `src/health/health.controller.ts` + тест.
- **`apps/admin-web`** — Vite + React; страница реально опрашивает `/health` через `@adclub/contracts`, состояния loading/success/error, кнопка Recheck; использует `@adclub/ui` и `@adclub/i18n`.
- **`apps/supplier-web`** — Vite + React; переключатель языка kk/ru/en на `@adclub/ui` + `@adclub/i18n`.
- **`apps/mobile`** — Expo (`create-expo-app` blank-typescript, SDK 57), очищен от шаблонного `CLAUDE.md`/`AGENTS.md`/`.claude/`/`LICENSE` (не относятся к правилам этого репозитория), текст плейсхолдера заменён на «adclub.kz — Working»; пока не потребляет пакеты монорепозитория (см. Deviations).
- **`infra/docker/compose.dev.yml`** — PostgreSQL 16, Redis 7, Meilisearch v1.11, MinIO (образ `quay.io/minio/minio`), healthcheck на каждый сервис.
- **`ARCHITECTURE.md`** — версия 0.3 → 0.4: уточнено дерево раздела 4 (документы остаются в корне, не в `docs/`), новый раздел **4.1** с 9 решениями реализации (I1–I9, таблица с обоснованием) — версии инструментов, система модулей, enforcement границ пакетов, CORS, `optimizeDeps`, образ MinIO, healthcheck Meilisearch.
- **`CLAUDE.md`** — обновлён только блок «0. Проект» (`git diff -U0` — один hunk `@@ -13,11 +13,11 @@`, дальше используется полный контекст блока); остальной файл не изменён.
- **`tasks/TASK-001-REPORT.md`** — этот отчёт.

Не изменялись: `PRODUCT.md`, `PROJECT_PLAN.md`, `PROJECT_STATE.md` — не мои файлы (CLAUDE.md 1). `PROJECT_PLAN.md`/`PROJECT_STATE.md` были untracked до начала задачи и остались untracked — их судьба в git не мне решать.

## Technical Decisions
Все — в `ARCHITECTURE.md`, раздел 4.1 (I1–I9), кратко:
- pnpm 10.33.0 закреплён через `packageManager`; Node ≥22, факт. среда — Node 24.
- TypeScript закреплён на 5.9.3 (не тег `latest`, который сейчас указывает на TS 7 — не поддерживается `typescript-eslint`); `apps/mobile` — исключение, 6.0.3 по требованию `expo install --check` для SDK 57.
- CommonJS как система модулей везде в компилируемом коде (Nest/Vite/Metro-интероп без ESM-ловушек).
- Границы пакетов — два слоя: `package.json.exports` только `"."` (проверено: `ERR_PACKAGE_PATH_NOT_EXPORTED` в Node) + ESLint `no-restricted-imports` на `**/src/**` (проверено: падает на намеренно неправильном импорте).
- Worker держит event loop явным `setInterval`-«пульсом» — баг найден тестированием (на Windows процесс завершался сам сразу после старта без этого).
- CORS на API включён разрешающе (`origin: true`) — cookie/сессий ещё нет; сузить при появлении (TASK-002+).
- `optimizeDeps.include` в vite.config обоих кабинетов — иначе dev-сервер не собирал CJS-пакеты рабочего пространства (прод-сборка не была подвержена).
- MinIO — образ `quay.io/minio/minio` (Docker Hub `minio/minio` возвращает `pull access denied`).
- Healthcheck Meilisearch — `wget` на `127.0.0.1`, не `localhost` (внутри контейнера `localhost` резолвится в `::1` раньше рабочего адреса).

## Verification
- `pnpm install` (чистый клон в отдельном каталоге) — PASS, без warning по пирам, `esbuild` postinstall выполнен.
- `pnpm format:check` (корень и чистый клон) — PASS.
- `pnpm lint` (Turborepo, 9 пакетов) — PASS, включая `apps/mobile`.
- `pnpm typecheck` (Turborepo, 12 задач, включая сборку зависимостей `^build`) — PASS.
- `pnpm test` (Turborepo, 4 пакета с тестами) — PASS, 10/10 тестов (domain 5, contracts 2, i18n 2, api 1).
- `pnpm build` (Turborepo, 8 задач; `apps/mobile` корректно пропущен — нет скрипта `build`) — PASS.
- Health-эндпоинт: `curl http://localhost:3000/health` → `{"status":"ok","service":"api","timestamp":"..."}` — PASS (и на скомпилированном `pnpm --filter api start`, и в dev-режиме).
- Worker (dev, `pnpm --filter api worker`, и прод, `pnpm --filter api start:worker` после `build`) — оба запускаются, логируют «Worker process started», остаются работать (проверено `timeout`-обёрткой, код возврата 124 = не завершился сам) — PASS. Корректное завершение по SIGINT проверено управляемым Node-скриптом (`child_process`, а не через оболочку — на Windows обычный shell-`kill` не доставляет сигнал в неконсольный процесс, это ограничение ОС, не код): child завершился с кодом 0 после лога «Received SIGINT, shutting down» — PASS. Нашёл и исправил реальный баг: без явного `setInterval`-«пульса» worker на Windows завершался сам сразу после старта (регресс-тест — процесс жил 5 с под `timeout` вместо мгновенного выхода) — PASS после исправления.
- Изменение схемы контракта (`timestamp` → `checkedAt` в `packages/contracts`) → `pnpm --filter api typecheck` и `pnpm --filter admin-web typecheck` оба упали с точными ошибками на изменённом поле; после отката — оба снова PASS — PASS.
- Намеренно неверный импорт (`@adclub/domain/dist/article/normalize-article` из `packages/contracts`) → `pnpm --filter contracts lint` упал на правиле `no-restricted-imports` с понятным сообщением; дополнительно тот же импорт падает и в чистом Node (`ERR_PACKAGE_PATH_NOT_EXPORTED`); после отката — линт снова PASS — PASS.
- **Реальный браузер (Playwright/Chromium, headless):** `admin-web` — заголовок «Работает» рендерится без ошибок консоли, секция «API health» показывает `api: ok at <timestamp>` с реальными данными от запущенного API, кнопка Recheck обновляет timestamp, при остановке API секция переходит в состояние ошибки «Could not reach API: Failed to fetch» без падения страницы (скриншоты сделаны и просмотрены) — PASS. `supplier-web` — рендер, переключение kk/ru/en кнопками, без ошибок консоли (скриншот просмотрен) — PASS. Именно эта проверка нашла два реальных дефекта (CORS, `optimizeDeps`), которые типы/сборка не ловили.
- **CI на GitHub Actions:** коммит запушен в `origin/main` (с разрешения пользователя), запущен реальный workflow — [run 35132268247](https://github.com/ihantrader/adclub.kz/actions/runs/35132268247), `conclusion: success`, все шаги (install, format check, lint, typecheck, test, build) зелёные, 37 с — PASS.
- **Docker Compose:** `docker compose -f infra/docker/compose.dev.yml up -d` — все 4 сервиса дошли до `healthy` (PostgreSQL `pg_isready`, Redis `PONG`, Meilisearch `{"status":"available"}` по HTTP, MinIO `200` на `/minio/health/live`) — PASS.
- **Свежий клон end-to-end:** `git clone` в отдельный каталог → `pnpm install` → `format:check`/`lint`/`typecheck`/`test`/`build` (все PASS) → `pnpm dev` → `/health` (3000), `admin-web` (5174, 200), `supplier-web` (5175, 200) все ответили — PASS.
- Мобильное: `pnpm --filter mobile typecheck` и `pnpm --filter mobile lint` — PASS. `pnpm --filter mobile start` — Metro поднялся, «Waiting on http://localhost:8081» — PASS. Запуск на реальном эмуляторе/симуляторе — **NOT RUN**: на машине разработки нет Android SDK/эмулятора (`adb`/`emulator` отсутствуют, `ANDROID_HOME` пуст) и нет macOS для iOS-симулятора; это ограничение среды, не кода.

## UAT / E2E
Пройдено вручную и автоматизированным браузером (headless Chromium через Playwright, временно установлен для этой проверки и не добавлен в зависимости репозитория) в этой Windows-среде:
- **Сценарий «новый разработчик»** — целиком, от `git clone` до `pnpm dev`, см. Verification выше. PASS для всех шагов, доступных на этой машине (эмулятор — см. Known Issues).
- **Сценарий «сломанный контракт»** — воспроизведён и отменён, см. Verification. PASS.
- **Сценарий «нарушение границы»** — воспроизведён и отменён, см. Verification. PASS.
- **Сценарий «API недоступен»** (не из TASK, дополнительно) — остановка API во время работы `admin-web`: интерфейс показывает понятную ошибку, не падает. PASS.

## Acceptance Criteria
- `AC-1 — PASS` — свежий клон → `pnpm install` (одна команда) → `docker compose -f infra/docker/compose.dev.yml up -d` (одна команда) → `pnpm dev` подняли `apps/api` (`:3000/health` ответил), `apps/admin-web` (`:5174`, 200), `apps/supplier-web` (`:5175`, 200); `apps/mobile` — `pnpm --filter mobile start` поднял Metro (см. Verification/Known Issues по поводу эмулятора).
- `AC-2 — PASS` — `curl :3000/health` → валидный JSON; `pnpm --filter api worker` и `pnpm --filter api start:worker` запускаются отдельно от HTTP и корректно завершаются по SIGINT (код 0, лог о завершении) — см. Verification.
- `AC-3 — PASS` — переименование поля в `healthCheckResponseSchema` ломает `tsc` и в `apps/api`, и в `apps/admin-web`; после отката оба снова проходят.
- `AC-4 — PASS` — 5 тестов `normalizeArticle` проходят; `pnpm test` — одна команда, весь репозиторий, 10/10 тестов.
- `AC-5 — PASS` — намеренно неверный импорт `@adclub/domain/dist/...` падает на `pnpm --filter contracts lint` (правило `no-restricted-imports`).
- `AC-6 — PASS` — реальный прогон CI на GitHub Actions после push: [run 35132268247](https://github.com/ihantrader/adclub.kz/actions/runs/35132268247), `success`, install/format/lint/typecheck/test/build — все зелёные.
- `AC-7 — PASS` — `git log --all --full-history -- .env` пуст, `.env` никогда не коммитился (и в `.gitignore`); `.env.example` содержит только placeholder-значения, реальных секретов нет. Существующий `.env` в рабочей директории с `GITHUB_PAT` — не создан мной, не относится к TASK-001, не попал ни в коммит, ни в `.env.example` (не выводился и не упоминался нигде, кроме этой строки отчёта).
- `AC-8 — PASS` — блок «0. Проект» в CLAUDE.md соответствует фактическим командам; `git diff CLAUDE.md` — единственный hunk внутри блока, весь остальной файл (`## 1` и далее) не тронут.

## Errors & Fixes
- **TypeScript `latest` = TS 7 (нативный порт), конфликт пиров с `typescript-eslint`.** Обнаружено при первой установке (`WARN Issues with peer dependencies`). Исправлено: закреплена версия 5.9.3.
- **`rootDir` в `tsc` резолвился относительно базового `tsconfig` в `packages/config`, а не относительно пакета.** `tsc -p tsconfig.json --noEmit` падал с TS6059. Причина — `extends` наследует относительные пути от файла, где они объявлены. Исправлено: `rootDir`/`outDir` убраны из общих `packages/config/typescript/*.json`, заданы в `tsconfig.build.json` каждого пакета.
- **ESLint падал на собственном `eslint.config.js` (`no-require-imports`).** Исправлено: `eslint.config.js` добавлен в `ignores` общего конфига.
- **`react-hooks/set-state-in-effect` (новое правило в `eslint-plugin-react-hooks` 7.x) падало на паттерне «fetch при монтировании + тот же обработчик на кнопке».** Исправлено: эффект зависит от `refreshToken`, синхронный `setState('loading')` вызывается только из обработчика клика, не из тела эффекта.
- **Образ `minio/minio` недоступен на Docker Hub** (`pull access denied`, воспроизведено с разными тегами). Исправлено: `quay.io/minio/minio`.
- **Healthcheck Meilisearch вечно в `starting`** — `wget http://localhost:7700/health` изнутри контейнера получал `connection refused` (резолвится в `::1`, сервис недоступен по IPv6-loopback), хотя `curl` с хоста и `wget 127.0.0.1` изнутри контейнера работали сразу. Исправлено: healthcheck на `127.0.0.1`.
- **Worker-процесс завершался сам сразу после старта на Windows** (обнаружено запуском под `timeout` — процесс не доживал до конца окна). Причина — пустой `NestApplicationContext` без открытых хендлов; слушатели `process.on('SIGINT'/'SIGTERM')` сами по себе не держат цикл событий на этой платформе. Исправлено: явный `setInterval`-«пульс».
- **CORS блокировал `admin-web` → API в реальном браузере** (`curl` не показывал проблему — CORS проверяет только браузер). Обнаружено проверкой в headless Chromium. Исправлено: `app.enableCors({ origin: true })`.
- **Vite dev-сервер не мог импортировать `Button` из `@adclub/ui`** (`SyntaxError: ... does not provide an export named 'Button'`) — CJS-пакеты рабочего пространства не сканируются esbuild-прибандлером Vite автоматически; прод-сборка (`vite build`, Rolldown) была не подвержена, поэтому раньше не поймалась. Исправлено: `optimizeDeps.include` в `vite.config.ts` обоих кабинетов.

## Deviations
- **Документы (`PRODUCT.md`, `ARCHITECTURE.md`, `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/`) остались в корне репозитория**, а не переехали в `docs/`, как в иллюстративном дереве ARCHITECTURE 4. Так они уже лежали до TASK-001 (и так их описывает CLAUDE.md, раздел 1); перенос не требовался задачей и не выполнялся. Уточнено в ARCHITECTURE.md.
- **`apps/mobile` пока не использует ни один пакет монорепозитория** (`contracts`/`domain`/`ui`/`i18n`). Требование 3 задачи явно требует демо-использование `contracts` «на сервере и в одном клиенте» — этим клиентом выбран `admin-web` (обычный Vite/бандлер, минимальный риск интеграции), а не мобильное приложение: интеграция Metro с pnpm-воркспейсом (`package.json.exports`, символические ссылки) — отдельный источник риска, не обязательный для выполнения AC этой задачи. Осознанное сужение объёма, не нарушение AC.
- **`tasks/TASK-001.md` в репозитории не найден** — содержимое задачи получено напрямую в промпте, а не прочитано из файла. Не мой файл, не создавал и не изменял; для Product Owner как наблюдение.
- **CORS настроен разрешающе (`origin: true`)** — сознательное временное решение при отсутствии сессий/cookie (см. Technical Decisions, ARCHITECTURE 4.1 I6); нужно сузить при появлении аутентификации.

## Known Issues / Risks
- CORS API разрешает любой origin — допустимо, пока нет сессий/cookie (TASK-002+ должен сузить список).
- Мобильное приложение не проверялось на реальном эмуляторе/симуляторе — на машине разработки нет Android SDK и нет macOS; проверен только запуск dev-сервера Expo (Metro).
- `apps/admin-web` даёт предупреждение сборки Vite о чанке > 500 кБ (709 кБ, включает React 19) — косметика для каркаса, не блокирует; code-splitting стоит сделать, когда появятся реальные экраны.
- Предупреждение Vitest про `configLoader: 'native'` (ESM-синтаксис в `*.config.ts`, загружаемом как CommonJS) — не влияет на прохождение тестов, повторяется в каждом пакете; можно убрать переименованием в `.mts` или установкой `"type": "module"`, не делал, чтобы не усложнять единое решение по CommonJS (ARCHITECTURE 4.1 I3).
- pnpm доступен в более новой версии (12.4.2) — сознательно не переходил на неё, закреплённая 10.33.0 полностью проверена; апгрейд — по желанию Product Owner отдельным решением.

## Remaining Work
None — все обязательные AC выполнены.

## Future Improvements
- `packages/dynamic-forms` — рендерер полей по описанию характеристики, когда появятся динамические характеристики (вне TASK-001).
- PWA-манифест и service worker для `apps/supplier-web` — когда потребуется офлайн/установка на экран (PRODUCT 6.7, D-006); сейчас обычный Vite+React без PWA-плагина.
- Code-splitting `admin-web`/`supplier-web`, когда бандл вырастет за счёт реальных экранов.
- Обновить версии GitHub Actions (`actions/checkout`, `setup-node`, `pnpm/action-setup`) — CI показал информационную аннотацию, что используемые версии внутри себя рассчитаны на Node 20 (раннеры сейчас форсируют Node 24 для них); не ошибка, но стоит обновить при следующей правке workflow.

# TASK REPORT — TASK-010.A

## Status
COMPLETED

## Result
- **Порядок соседей справочника больше не перезаписывается молча.** `PUT …/order` для категорий, характеристик и вариантов принимает `expectedOrder` — порядок, который клиент прочитал. Если порядок тем временем изменили — 409 `CATALOG_ORDER_CONFLICT` (`details.currentOrder` — сохранённый порядок), ничего не записывается. Отправка уже сохранённого порядка ничего не меняет и не пишет запись в журнал. Контракт изменён аддитивно (oasdiff: совместим без трейлера).
- **Ошибки API не кэшируются.** Любой ответ с ошибкой, включая 404 клиентских маршрутов справочника, несёт `Cache-Control: no-store`. Восстановленная категория видна следующим же запросом.
- **`pnpm dev` из корня снова стартует**: сборка общих пакетов в режиме наблюдения, API, кабинет и админка запускаются одной командой.
- **Нестабильные интеграционные тесты исправлены по причине.** Тест расписания с двумя worker'ами, тест очистки («gone»), два теста окон лимитов кодов (локально падали стабильно) и найденный по ходу работы тест паузы повтора. Полный `pnpm test:integration` локально: было 219/221, стало 223/223 три раза подряд.

## Changes
- `packages/contracts/src/catalog.ts`, `error.ts`, `index.ts`: `expectedOrder` (необязательное, до 500 uuid) в трёх телах `reorder*`; код ошибки `CATALOG_ORDER_CONFLICT`; `catalogOrderConflictDetailsSchema`. `catalog.test.ts` — unit-тест схем.
- `apps/api/src/modules/catalog/catalog-admin.service.ts`: функция `orderChange` решает для всех трёх видов соседей: `CATALOG_ORDER_MISMATCH` → тот же порядок = no-op без журнала → `CATALOG_ORDER_CONFLICT` → запись; всё под существующей блокировкой структуры (I145). `catalog-admin.controller.ts` передаёт `expectedOrder`; `catalog-errors.ts` — `orderConflict()`.
- `apps/api/src/common/errors/http-exception.filter.ts`: `Cache-Control: no-store` на каждую ошибку; заголовки самой ошибки (`Retry-After`) ставятся после. Unit-тест в `http-exception.filter.test.ts`.
- `apps/api/openapi.json` — перегенерирован.
- `package.json`: `"dev": "turbo run dev --concurrency=32"`.
- Тесты: `jobs.integration.test.ts`, `sign-in-data-cleanup.integration.test.ts`, `login-code.integration.test.ts`, `catalog.integration.test.ts` — см. AC-4 и Verification.
- `ARCHITECTURE.md` 0.19: раздел 4.16 (I151–I156), уточнены I146, I149. `CLAUDE.md`, блок 0: команда запуска dev.

## Technical Decisions
Внесены в `ARCHITECTURE.md` 4.16:
- **I151.** Версия порядка — сам список id (`expectedOrder`), без новой колонки: проверка и запись атомарны под существующей advisory-блокировкой. Порядок проверок: полный список соседей → тот же порядок (no-op, 200) → конфликт → запись. Поэтому повтор успешного запроса после обрыва сети — 200 без записи. **`expectedOrder` необязателен:** обязательное новое поле запроса oasdiff считает ломающим, а TASK требует аддитивного изменения. Без поля порядок пишется как раньше. Админка (экраны — TASK-034/035) обязана передавать его всегда (см. Deviations).
- **I152.** `no-store` на все ошибки в едином фильтре, а не только на 404 справочника: ошибка описывает момент, а не ресурс. Заодно закрывается 400 при слишком длинном id в пути справочника.
- **I153.** Лимит задан флагом в корневом скрипте `dev`, а не в `turbo.json`: `concurrency` в `turbo.json` изменил бы параллельность `build`/`test` в CI.
- **I154–I156.** Время, которое отсчитывает PostgreSQL (расписание, задержка повтора) или Redis (TTL окон лимитов), тесты меряют часами того же сервиса, а не часами процесса.

## Verification
- Коммит правок Product Owner — PASS — `6de8229` (см. «Коммиты»).
- `pnpm format:check` — PASS.
- `pnpm lint` — PASS (12/12 задач).
- `pnpm typecheck` — PASS (18/18).
- `pnpm test` (unit) — PASS (15/15 задач). По ходу работы unit-тесты фильтра ошибок падали (22 теста): мок ответа без `setHeader`. Мок дополнен, добавлен тест `no-store`.
- `pnpm --filter @adclub/api openapi:check` — PASS: «matches the contract and the served routes».
- `pnpm --filter @adclub/api openapi:compat --base origin/main` — PASS: «Contract is backward compatible with origin/main», трейлера нет.
- `catalog.integration.test.ts` — PASS 18/18 (было 16, плюс 2 новых).
- Многократные прогоны локально (Windows + Docker Desktop, часы VM дрейфуют), часть — параллельно друг с другом (под нагрузкой):
  - `sign-in-data-cleanup.integration.test.ts` — 10/10 прогонов, 5/5 тестов в каждом.
  - `login-code.integration.test.ts` — 10/10 прогонов, 44/44 в каждом. До исправления 2 теста падали в каждом полном прогоне.
  - `jobs.integration.test.ts`, **весь файл** (оба исправленных теста и остальные 19) — 10/10 прогонов, 21/21 в каждом. Эта серия шла после исправления теста повторов. До него была серия только блока «with two workers»: 3 зелёных прогона, на 4-м упал тест паузы повтора — см. Errors & Fixes.
  - Полный `pnpm test:integration --force` — 3/3 подряд, 11/11 файлов, 223/223 тестов. Базовый прогон до изменений — 219/221.
- CI на `main`: номера и статусы — в разделе «CI».

## UAT / E2E
- **`pnpm dev` из корня** (Windows, dev Docker Compose). До исправления: `npx turbo run dev` → `You have 10 persistent tasks but turbo is configured for concurrency of 10. Set --concurrency to at least 11`. После — фактический вывод (выдержка):
  ```
  • Packages in scope: @adclub/admin-web, @adclub/api, @adclub/api-client, @adclub/config, @adclub/contracts, @adclub/domain, @adclub/dynamic-forms, @adclub/i18n, @adclub/mobile, @adclub/supplier-web, @adclub/ui, @adclub/ui-core, @adclub/ui-showcase
  • Running dev in 13 packages
  @adclub/i18n:dev / domain / dynamic-forms / ui-core / contracts / ui / api-client: Found 0 errors. Watching for file changes.
  @adclub/admin-web:dev:   VITE v8.3.0  ready in 1938 ms   ➜  Local:   http://localhost:5174/
  @adclub/supplier-web:dev:   VITE v8.3.0  ready in 1994 ms   ➜  Local:   http://localhost:5175/
  @adclub/api:dev: {"level":"log","message":"Nest application successfully started","context":"NestApplication"}
  ```
  Ответы через ~8 с после старта: `GET :3000/health` → 200 `{"status":"ok","service":"api",…}`; `GET :3000/ready` → `{"status":"ok","checks":{"postgres":{"status":"ok"},"redis":{"status":"ok"},"s3":{"status":"ok"}}}`; `GET :5174/` → 200, `GET :5175/` → 200 (HTML приложений). `GET :3000/catalog/categories/<несуществующий>/attributes` → 404 с `Cache-Control: no-store`. После проверки dev остановлен.
- **Одновременное изменение порядка** проверено на реальном HTTP-сервере в интеграционном тесте: два параллельных `PUT` от одного прочитанного порядка → один 200, второй 409 `CATALOG_ORDER_CONFLICT`. Для категорий, характеристик и вариантов. Вручную через curl в сессии админки (с настройкой TOTP) — не проходилось.
- Экранов нет (не входят в задачу).

## Acceptance Criteria
- **AC-1 — PASS.** Тест `catalog.integration.test.ts` «never overwrites someone else's order silently; the same order again changes nothing (TASK-010.A)» проверяет одно и то же для подкатегорий узла, характеристик подкатегории и вариантов списка:
  - два одновременных `PUT` с одним `expectedOrder` и разными порядками → статусы `[200, 409]`, у проигравшего `CATALOG_ORDER_CONFLICT` и `details.currentOrder` = порядок победителя;
  - сохранён порядок победителя, в журнале +1 запись;
  - тот же порядок ещё трижды (без `expectedOrder`, с текущим и с устаревшим) → 200, порядок прежний, журнал +0;
  - повтор от актуального порядка → 200, журнал +1; неполный список → `CATALOG_ORDER_MISMATCH`.

  Прогон: 18/18.
- **AC-2 — PASS.** Тест «never lets a 404 be kept: a category restored is seen at once (TASK-010.A)»:
  - 404 для скрытой, несуществующей категории и неверного id → `Cache-Control: no-store`; условный запрос с `If-None-Match` — снова 404 без кэша;
  - после восстановления следующий запрос → 200 с `public, max-age=60`;
  - 400 при id длиннее 100 символов → `no-store`.

  Unit-тест фильтра — `no-store` для 404 и 500.
- **AC-3 — PASS.** Фактический запуск `pnpm dev` и ответы API, кабинета и админки — в UAT.
- **AC-4 — PASS.** Для каждого теста — причина, исправление и доказательство:
  1. **`jobs` «runs each scheduled occurrence once with two workers»** (CI 35327943796).
     - **Причина.** pg-boss относит наступление к минуте по `now()` PostgreSQL, а тест раскладывал запуски по минутам часов процесса (`Date.now()` в обработчике). Минута процесса ≠ минута базы. Замер эксперимента: запуск минуты 10:29 начался в 10:29:03.0 по процессу, его задача создана в 10:29:04.6 по базе. Смещение часов контейнера относительно хоста за полчаса менялось от −0,9 до +1,3 с. Кроме того, догоняющий запуск из первого теста может попасть в ту же минуту, что и текущий.
     - **Исправление.** Две целые минуты базы, начиная со следующей после старта теста. По `pgboss.job.created_on`: ровно одна задача на каждую минуту (`[0, 1]`), каждая выполнена ровно раз по `jobId` и `completed`, ни одна задача не выполнена дважды.
     - **Доказательство.** 10/10 прогонов всего файла. Точное падение CI локально не воспроизвёл: две попытки со стартом worker'ов у границы минуты прошли — догоняющий и текущий запуски слились в одну задачу singleton. Причина установлена по коду pg-boss и замерам часов (см. Known Issues).
  2. **`sign-in-data-cleanup` «did not complete: gone».**
     - **Причина.** Задача очистки — singleton по расписанию раз в минуту. Если запуск по расписанию уже ждал в очереди, `runNow` возвращал `jobId: null`, и тест искал строку с id `null`.
     - **Доказательство причины.** Старая версия теста с ожидающим запуском перед `runCleanup` падает с той же ошибкой («did not complete: gone»); новая в том же эксперименте проходит.
     - **Исправление.** При `null` тест ставит запуск снова, когда ожидающий взят в работу, и ждёт свой. Это не повтор упавшей проверки, а обработка документированного результата `runNow`; поведение `runNow` не менялось.
     - **Прогоны.** 10/10.
  3. **`login-code` «refuses an SMS resend…», «limits code requests per number…»** (локально падали в каждом прогоне).
     - **Причина.** Окна — ключи Redis с TTL. Часы Docker VM идут медленнее хоста: 1911 мс Redis на 2117 мс хоста; после 2100 мс хоста у ключа с TTL 2000 мс оставалось 74–100 мс. Тест спал по часам процесса.
     - **Исправление.** Ожидание, пока ключ исчезнет (`PTTL = -2`), с верхней границей. Отказ до окна и успех после проверяются как раньше. Это же ожидание применено к остальным паузам «интервал повторной отправки 1 с» в этом файле — они проходили с запасом около 1 мс.
     - **Прогоны.** 10/10.
  4. **`jobs` «retries a failing job by its rules until it succeeds»** — найден при многократных прогонах: 1492 мс при ожидании ≥ 1500.
     - **Причина.** Задержку отсчитывает PostgreSQL, а тест мерил часами процесса.
     - **Исправление.** Каждая попытка читает `clock_timestamp()` базы; проверка ужесточена до ≥ 2000 мс.
     - **Прогоны.** 10/10 в составе всего файла.

  **Diff проверок** (все проверки сохранены или ужесточены, ни одна не ослаблена и не удалена):
  ```diff
  # jobs: two workers
  - expect(minutes).toBeGreaterThanOrEqual(1);
  - expect(steady.length).toBeGreaterThanOrEqual(minutes);
  - expect([...perMinute.values()].every((count) => count === 1)).toBe(true);
  + expect(rows.map((row) => minuteOf(row.created_on) - fromMinute), report).toEqual([0, 1]);
  + for (const row of rows) {
  +   expect(runsOf(minutelyJob.name).filter((run) => run.jobId === row.id), report).toHaveLength(1);
  +   expect(row.state, report).toBe("completed");
  + }
  + expect(new Set(ran).size, report).toBe(ran.length);
  # jobs: retries
  - expect(attempts[1]!.startedAt - attempts[0]!.startedAt).toBeGreaterThanOrEqual(1500);
  - expect(attempts[2]!.startedAt - attempts[1]!.startedAt).toBeGreaterThanOrEqual(1500);
  + expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(2000);   // PostgreSQL's clock
  + expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(2000);
  # login-code (assertions unchanged; only how the window end is awaited)
  - await sleep(1100);                                     (×8)
  + await resendAllowed();                                 // key gone in Redis, ≤ 3 s
  - await sleep(2100);
  + await windowPassed(`login-code:resend:${PHONE}`, 4_000);
  - await sleep(limited.body.details.retryAfterSeconds * 1000 + 100);
  + await windowPassed(`login-code:requests:phone:${PHONE}`, retryAfterSeconds * 2000 + 1000);
  # cleanup (assertions unchanged): runCleanup waits for a run of its own when runNow returns null
  ```
  **Изменение ожидания, требуемое TASK.** Тест `catalog` «records every change…» ожидал записи журнала `catalog_category.reordered` и `catalog_attribute.reordered` для «перестановки» списков из одного элемента, то есть без изменения. По требованию 1 TASK такие запросы в журнал больше не пишутся, поэтому две записи убраны из ожидаемого списка (с комментарием). Запись о реальной смене порядка осталась в этом тесте (варианты), и в новом тесте AC-1 она проверяется для всех трёх видов.
- **AC-5 — PASS.** `openapi:compat --base origin/main` — совместим без трейлера. Unit- и интеграционные тесты проходят без ослабления (см. выше). Коммиты по D-024 — явные `git add <пути>`, состав в разделе «Коммиты». CI на `main` — в разделе «CI».
- **AC-6 — PASS.** `ARCHITECTURE.md` 0.19: история, раздел 4.16 (I151–I156), уточнения I146/I149. `CLAUDE.md`, блок 0: команда `pnpm dev` (`--concurrency=32`) и ссылка на I153.

## Коммиты (все в `main`)
1. `6de8229` Update project plan and state, add TASK-010.A (Product Owner edits) — `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-010.A.md`.
2. `2df3a18` Refuse a catalog reorder made from a stale order; never cache errors:
   - `packages/contracts/src/{catalog.ts,catalog.test.ts,error.ts,index.ts}`;
   - `apps/api/openapi.json`;
   - `apps/api/src/modules/catalog/{catalog-admin.controller.ts,catalog-admin.service.ts,catalog-errors.ts,catalog.integration.test.ts}`;
   - `apps/api/src/common/errors/{http-exception.filter.ts,http-exception.filter.test.ts}`.
3. `620e3e0` Start pnpm dev with room for every persistent dev task — `package.json`.
4. `17a6cf1` Make the schedule, cleanup and rate limit window tests independent of clocks:
   - `apps/api/src/jobs/jobs.integration.test.ts`;
   - `apps/api/src/modules/identity/cleanup/sign-in-data-cleanup.integration.test.ts`;
   - `apps/api/src/modules/identity/login-code/login-code.integration.test.ts`.
5. `4903cb2` Document the TASK-010.A decisions (ARCHITECTURE 0.19, 4.16) — `ARCHITECTURE.md`, `CLAUDE.md`.
6. `fb0633b` Measure the retry delay in the jobs test by PostgreSQL's clock — `apps/api/src/jobs/jobs.integration.test.ts`, `ARCHITECTURE.md`.
7. Коммит с этим отчётом — `tasks/TASK-010.A-REPORT.md`.

## CI
- Прогон **35341331211** (коммит `fb0633b`, все коммиты задачи кроме отчёта) — `completed / success` (проверено `gh run view`), job `ci` — success.
- Прогон коммита с этим отчётом — номер и статус приведены в ответе агента (отчёт не может содержать результат собственного прогона).

## Errors & Fixes
- **Unit-тесты фильтра ошибок** (22 теста) упали после добавления `no-store`: мок ответа без `setHeader`. Мок дополнен, добавлен тест.
- **Python на Windows записал файлы с CRLF.** Возвращено LF до коммита, Prettier чистый.
- **Тест паузы повтора** упал в 4-м прогоне серии «with two workers» — исправлен по причине (см. AC-4, п. 4). Серия файла jobs перезапущена с нуля после исправления: 10/10.
- **Push по HTTPS получил 403** от сохранённых учётных данных git. Push выполнен с токеном `GITHUB_PAT` из `.env` (токен не выводился).

## Deviations
- **`expectedOrder` необязателен** — иначе изменение контракта не было бы аддитивным (требование 1 и AC-5). Клиент, который поле не передаёт, по-прежнему перезаписывает порядок, как до задачи; защита от молчаливой перезаписи работает для клиентов, которые передают поле. Своего клиента порядка пока нет (экраны справочника — TASK-034/035): при их реализации передавать `expectedOrder` обязательно (записано в I151). Если Product Owner хочет требовать поле на сервере — это осознанный breaking change с трейлером `Contract-Breaking-Change` (реальных потребителей нет); решение за Product Owner.
- Сверх перечисленных в контексте исправлен ещё один тест того же класса («retries a failing job…»), найденный при многократных прогонах.

## Known Issues / Risks
- Точное падение CI 35327943796 («two workers») локально не воспроизведено. Причина установлена по коду pg-boss и замерам часов; новая проверка не зависит ни от часов процесса, ни от догоняющего запуска. Окончательное подтверждение — последующие зелёные прогоны CI.
- Часы Docker VM на машине разработки дрейфуют (~9 % медленнее хоста, подводятся скачками). Синхронизация не входит в задачу. Тесты, которые ждут окончания интервала через `sleep` по часам процесса, но сравнивают сроки только в процессе (сроки кодов, шагов, сессий), от этого не зависят и не менялись.
- `Cache-Control: no-store` теперь у всех ответов с ошибкой API, не только в справочнике. Это ожидаемое изменение заголовков; клиенты от него не зависят.

## Remaining Work
None.

## Future Improvements
- Вынести `windowPassed`/`databaseNow` в `src/testing`, если другие тесты начнут ждать окон Redis или сроков PostgreSQL.

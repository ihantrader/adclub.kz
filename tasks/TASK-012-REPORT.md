# TASK REPORT — TASK-012

## Status

COMPLETED — 14/14 AC. Одна проверка не выполнялась и названа отдельно: **настоящий вызов Claude не делался — ключа Anthropic у проекта нет** (AC-1 требует такую реализацию написать и не вызывать; она проверена только на подменённом HTTP-уровне).

## Result

- **Внутренний интерфейс ИИ (`AiGateway`)** и первый его пользователь — перевод справочника. Интерфейс описан как образец для будущих применений (сверка прайсов, помощник, распознавание): порт провайдера (`AiGateway`), фасад `AiService` (единственный вход для модулей), запись операции `AiOperation` (вид, модель, схема ответа) — новое применение добавляет метод порта и операцию, `AiService` не трогает (ARCHITECTURE 4.19 I173).
- **Две реализации:** `TestAiGateway` (dev, тесты, CI: без внешних вызовов, детерминирована, умеет отвечать, отказывать, отвечать медленно и отвечать текстом, который отвергают проверки) и `ClaudeAiGateway` (официальный `@anthropic-ai/sdk`, `claude-sonnet-5`, структурированный вывод по zod-схеме; подключается ключом; без ключа — тестовая; production с тестовой не стартует).
- **Учёт вызовов:** таблица `ai_job` (вид, провайдер, модель, инициатор, статус, токены, стоимость, безопасный текст ошибки; без содержимого). **Дневной предел** `ai_daily_budget_usd` по суткам Алматы: исчерпан — новые пакеты не уходят, задачи ждут, событие видно оператору (лог, `ai:status`, метрики).
- **Автоперевод kk/en:** любая запись текстов справочника (категории, характеристики, единицы, варианты, позиции) идёт через `TranslationQueue`; изменение русского текста и задача перевода — одна транзакция. Worker берёт задачи пакетами, переводит через `AiService`, сохраняет результат как рабочий (`origin = ai`, модель, ссылка на вызов).
- **Ручная правка не затирается никогда** (ни при изменении исходника, ни при правке, пока задача в очереди/в работе); ручной текст при изменении русского помечается «исходник изменился». Автоперевод при изменении исходника заменяется.
- **Проверки перевода** — те же, что у ручного ввода (одна и та же схема, одна и та же функция уникальности среди соседей под той же блокировкой) + язык. Не прошедший не сохраняется, задача `failed` с причиной, автоматически не повторяется.
- **Сбои:** временная недоступность → повторы (настройки) → мёртвая очередь, после восстановления `jobs:retry`/любое изменение/`translations:run`; окончательный отказ провайдера — сразу в мёртвую очередь; исчерпанный предел — остановка без сбоев.
- **API администратора** (`/admin/translations…`): просмотр по полям и языкам, ручная правка, снятие ручной правки, «Перевести заново» (не для ручного — 409), список ждущего/устаревшего с объёмом по состояниям. Журнал действий — в транзакции.
- **Оператор:** `ai:status`, `translations:status`, `translations:queue-missing`, `translations:run`, `translations:retry-failed`; метрики расхода и очереди.

## Changes

Ключевые файлы (полный состав коммитов — ниже):

- `apps/api/src/modules/ai/` — `ai-gateway.ts` (порт, операции, ошибки), `ai.service.ts` (предел, учёт, время, проверка ответа), `test-ai-gateway.ts`, `claude-ai-gateway.ts`, `ai-pricing.ts`, `ai.module.ts` (выбор реализации, метрики), `schema.ts`.
- `infra/migrations/1789900000000_create-ai-jobs-and-translation-tasks.sql` — `ai_job`, `translation_task`, `translation.ai_model`/`ai_job_id`; обратима.
- `apps/api/src/modules/catalog/translation-queue.service.ts` (постановка в транзакции), `translation-runner.ts` (запуск, страховочная задача, метрики), `translation-checks.ts`, `catalog-names.ts` (уникальность названий — одна функция для администратора и автоперевода), `translation-admin.service.ts`/`.controller.ts`, `translation-jobs.ts`.
- `packages/contracts/src/translations.ts` + маршруты, коды `TRANSLATION_MANUALLY_EDITED`/`TRANSLATION_NOT_MANUAL`, действия журнала; `apps/api/openapi.json`.
- `apps/api/src/jobs/job-queue.service.ts` — `EnqueueOptions.retry` (число повторов и пауза берутся из настроек при постановке).
- Настройки: группа «Переводы справочника» (`translation_batch_size`, `translation_retry_limit`, `translation_retry_delay_seconds`); `ai_daily_budget_usd` уже был.
- Окружение: `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `AI_TEST_MODE` (`.env.example`).
- `dev:catalog:seed` оставляет часть названий только по-русски и ставит перевод (`translationsQueued`).
- Зависимость: `@anthropic-ai/sdk` 0.127.0 (`apps/api`).

## Technical Decisions

Внесены в **ARCHITECTURE.md 0.22, раздел 4.19 (I173–I184)**, уточнены 5.4, 9.6, 13.2, 14. Существенное:

- **Постановка — по запуску на каждое изменение, а не одним общим (singleton).** Общий ожидающий запуск мог бы забрать очередь до фиксации новой задачи, и она осталась бы без запуска (гонка проверена рассуждением по индексу pg-boss). Оставшиеся «сироты» (бюджет исчерпан и настали новые сутки) подбирает страховочная периодическая `catalog.translation-wake` раз в 5 минут; задачи с временной ошибкой она не трогает, иначе при недоступном провайдере каждые 5 минут в мёртвую очередь падал бы новый запуск.
- **Очередь — данные (`translation_task`), а не только задачи pg-boss:** одна строка на сущность × поле × язык (два быстрых изменения → одна задача, переводится последнее), видна администратору, переживает мёртвую очередь; свежесть — по хэшу русского текста, читаемого в момент запуска и проверяемого при сохранении.
- **Сохранение — отдельной транзакцией под исключительной блокировкой структуры справочника** (та же, что у администратора): перечитывает задачу, исходник (хэш), отсутствие ручного текста, проверки, уникальность; так правка администратора, второй worker и второй запуск могут сделать сохранение только пустым.
- **Реализация Claude — на официальном SDK**, а не на сыром HTTP; классификация отказов (`unavailable`/`rejected`/`invalid_output`) решает, повторять ли работу.
- **Тестовая реализация в production отвергается при старте** (как тестовые каналы кодов входа): её выдуманные тексты не должны попасть в публичный каталог.

## Verification

- `pnpm format:check` — PASS.
- `pnpm lint` — PASS (0 предупреждений).
- `pnpm typecheck` — PASS (18 задач).
- `pnpm test` — PASS: api 392 теста (35 файлов), contracts 79, api-client 25, mobile 68, ui-core 47, domain 69, ui 28, i18n 8, config 9.
- `pnpm test:integration` (Testcontainers, PostgreSQL 16 + Redis 7) — PASS: 13 файлов, 270 тестов, 244 с — на состоянии коммита `2041bb6`. Новый файл `translation.integration.test.ts` — 24 теста.
- `pnpm build` — PASS (11 задач, включая JS-бандл мобильного).
- `pnpm --filter @adclub/api openapi:check` — PASS (`openapi.json` совпадает с контрактом и маршрутами сервера).
- `pnpm --filter @adclub/api openapi:compat --base HEAD` (относительно состояния до задачи; oasdiff в Docker) — PASS: «No breaking changes», трейлер не нужен.
- `pnpm --filter api run verify:graceful-shutdown` — локально **NOT RUN осмысленно** (скрипт сам объясняет, что проверка работает только на Linux: Windows не доставляет SIGTERM, локальный запуск падает на «worker process to exit after SIGTERM»); **в CI на Linux — PASS** (run 35489729701).
- Реальный вызов Claude — **NOT RUN** (нет ключа).
- Миграция обратима — PASS: `database.integration.test.ts` (откат `…create-ai-jobs-and-translation-tasks` с данными, накат, откат) и вся цепочка откатов.
- Сверка схемы ORM с базой — PASS (`ormTables` дополнены `ai_job` и `translation_task`).
- Перехват вывода интеграционных тестов — PASS (маркер русского названия зарегистрирован как секрет: ни лог, ни `ai_job` его не содержат).
- CI на `main`: `2041bb6` (код и документация) — run 35489729701: **success с первой попытки (attempt 1)**, все шаги (форматирование, lint, typecheck, unit, integration, build, `openapi:check`, `openapi:compat`, `verify:graceful-shutdown` на Linux) зелёные. CI коммита с отчётом — в ответе сессии: коммит не может ссылаться на собственный прогон.

## UAT / E2E

Пройдены в dev (отдельная база `adclub_t012` в dev-PostgreSQL, которая удалена после прогона; API на `:3010`, worker, серверная команда, сессия админки с TOTP; окружение — Windows 11, тестовая реализация ИИ):

1. **Заполнить → worker → переводы.** `dev:catalog:seed` вывела `translationsQueued` (12 задач: «Чехлы», «Аксессуары», четыре масла × kk/en). До worker'а гость по `Accept-Language: kk` видел «Чехлы» с `isFallback: true`. После запуска worker'а: `Translation run finished batches=1 saved=12`, `Чехлы [kk]` (`isFallback: false`), `Chekhly [en]`; в админке `origin: ai`, `aiModel: claude-sonnet-5`.
2. **Ручная правка → изменение русского.** PUT казахского «Орындық қаптары» → PATCH русского «Чехлы на сиденья»: сразу английский `isSourceChanged: true` + задача `queued`, казахский `manual` и `isSourceChanged: true`, без задачи. После worker'а: английский `Chekhly na sidenya [en]` (заменён), казахский — прежний ручной, помечен «исходник изменился». Гость: kk — ручной текст, en — автоперевод.
3. **«Перевести заново».** Для английского — 200, новый автоперевод; для казахского с ручной правкой — 409 `TRANSLATION_MANUALLY_EDITED`.
4. **Снять ручную правку.** `release` казахского: 200, текст остаётся видимым (`origin: ai`, без модели), задача `queued`; после worker'а — `Чехлы на сиденья [kk]`, `origin: ai`, `aiModel: claude-sonnet-5`.
5. **Провайдер недоступен** (`AI_TEST_MODE=unavailable`, `translation_retry_limit=1`, пауза 2 с): новая категория сохранена (русский виден), задачи `pending` с `pendingWithTemporaryFailure: 2`; `ai:status` — 2 неудачных вызова `unavailable`; через ~5 с задача в мёртвой очереди (`jobs:dead`, attempts 2, «The test AI provider is unavailable»). После восстановления (`ok`, перезапуск worker'а) `jobs:retry` → переводы выполнены, мёртвая очередь пуста.
6. **Дневной предел.** `settings:set ai_daily_budget_usd 0` → новая категория сохранена, переводы не идут; в логе worker'а `AI daily budget exhausted, the call is not sent … budgetUsd=0`, `ai:status` — `exhausted: true`, `translations:status` — 2 ждут, мёртвых нет, `/metrics` — `adclub_ai_daily_budget_usd 0`, `adclub_translation_tasks{state="pending"} 2`. `settings:reset` и `translations:run` → переводы выполнены.
7. **`dev.daily-at-setting`:** `jobs:status` — `0 10 * * *`; `settings:set billing_notify_hour 7` → через ≤ 50 с `0 7 * * *`; возвращено `settings:reset`.
8. Итог `ai_job` сценариев: 8 успешных вызовов (701 токен на вход, 215 на выход, $0.003552), 2 неудачных.

Замечание о прогоне: при первом ручном PUT/PATCH русский текст был испорчен самим шеллом Windows (аргументы с кириллицей в `curl` пришли как U+FFFD); сервер принял их как обычный текст. Сценарии повторены запросами из Python (UTF-8) — результаты выше получены ими. Продукт не изменён.

## Acceptance Criteria

- **AC-1 — PASS.** Интерфейс с двумя реализациями: `ai-gateway.ts`, `test-ai-gateway.ts`, `claude-ai-gateway.ts`. `ai-gateways.test.ts`: тестовая возвращает перевод (детерминированно), отказ (`unavailable`, `rejected`), медленный ответ (и обрыв по сигналу), негодные тексты (`empty`, `too_long`, `control_characters`, `wrong_language`); Claude — запрос (URL, ключ в заголовке, `model: claude-sonnet-5`, `output_config.format: json_schema`), расход и цена, классификация 429/500/529/408 → `unavailable`, 400/401/403/404 → `rejected`, сетевой сбой, `refusal`, `max_tokens`. `env.schema.test.ts`: без ключа — `test`, с ключом — `claude`, `claude` без ключа и production с `test` — отказ старта. Интеграционные тесты идут на тестовой. **Настоящий вызов Claude не выполнялся — ключа нет.**
- **AC-2 — PASS.** `translation.integration.test.ts` «translates what has no translation, records every call…»: запись `kind=translate, provider=test, model=claude-sonnet-5, initiator_type=system, status=succeeded`, токены, стоимость > 0, `latency_ms`, `input_ref` без текстов, `output=null`; маркер названия не найден ни в записи, ни в логе. «records a call whose answer does not match its schema…»: `failed/invalid_output` с расходом, в бюджете учтён. Недоступность/отказ/обрыв — записи `failed` с видом ошибки (тесты AC-7).
- **AC-3 — PASS.** «puts the change of a Russian text and its task in one transaction»: откатанная транзакция — 0 текстов, 0 задач, 0 запусков в `pgboss.job`; закоммиченная через API — 2 задачи и 1 запуск; отказ по имени соседа — без следов.
- **AC-4 — PASS.** «keeps a manual text when the Russian one changes…»: ручной текст не тронут, `isSourceChanged: true`, задачи нет; «never overwrites a text written by hand while its translation is being made»: ручной PUT во время вызова → после завершения текст ручной; «asks for no translation of a language written by hand…».
- **AC-5 — PASS.** «replaces an automatic translation when the source changes…» (замена англ., ручной казахский остаётся), «Перевести заново» для `ai` → новый вызов, для ручного → 409 `TRANSLATION_MANUALLY_EDITED`, `release` → перевод заново; «releases a manual edit and asks again only for automatic texts».
- **AC-6 — PASS.** «does not save a translation that fails the checks…»: пустой, длинный, с управляющим символом, не на том языке → задача `failed` с причиной, перевода нет (клиент получает русский с `isFallback`), лог `Translation refused, not saved`, `translations:status`; после возврата режима `ok` и `wake` число вызовов не выросло (не повторяется); повтор — по запросу админа/`retryFailed`. «…as its name»: совпадение с названием соседа (без учёта регистра) → `name_taken`, не сохранено. Юнит `translation-checks.test.ts` сверяет проверки автоперевода с ручной схемой на образцах.
- **AC-7 — PASS.** «keeps the change and the task when the provider is unavailable…» (изменение сохранено, 2 неудачных вызова, мёртвая очередь, задачи ждут, после восстановления `retryDead` → переводы), «sends a refusal for good straight to the dead letter queue, and a slow provider counts as unavailable», «stops sending when the day's budget is spent, between batches…» (бюджет 0: ни вызова, ни записи, ни мёртвых, изменения целы; бюджет, исчерпанный первым пакетом: второй не ушёл; страховочная не будит исчерпанный бюджет).
- **AC-8 — PASS.** «translates each task once with two workers at once…»: 16 задач двумя worker'ами — 16 разных пар (название, язык), 16 переводов, повторный запуск ничего не вызывает; «drops the task of a text that is gone, and never translates a task twice» (5 лишних запусков).
- **AC-9 — PASS.** Просмотр, ручная правка (проверки, 409 `CATALOG_NAME_TAKEN`, 400 для длины/управляющих/поля/`ru`, 404), снятие, «Перевести заново», список ждущего с состояниями `missing/queued/failed/outdated`, `counts`, фильтрами и страницами по курсору — «lists what waits or is outdated…», «writes a translation by hand…», «releases a manual text…»; «is for the admin context only»: мобильная сессия и сессия кабинета — 403 `FORBIDDEN`, без сессии — 401; журнал: `catalog_translation.edited`, `released` и `requeued` (по две записи «requeued» после двух запросов) — тесты «writes a translation by hand…», «releases a manual text…», «releases a manual edit and asks again…».
- **AC-10 — PASS.** «translates what has no translation…»: гость по `Accept-Language: kk` сразу после worker'а получает `text: Chekhly…/…[kk]`, `isFallback: false`, а для языка без перевода — русский с `isFallback: true` (тесты AC-6). Кэш — прежний (`max-age=60`, сервер читает базу на каждый запрос, 4.15 I149) — изменение видно не позже 60 с; в тесте ответ получен сразу.
- **AC-11 — PASS.** UAT 1 выше: `translationsQueued: 12` → worker → kk/en у чехлов, аксессуаров и четырёх масел, источник «ИИ». Тест `queues what was never translated on the operator's request only` проверяет `queue-missing`.
- **AC-12 — PASS.** Контракт аддитивный: `openapi:compat` — «No breaking changes», трейлера нет; клиент `@adclub/api-client` тип-безопасен по `apiRoutes` (тесты 25 зелёных); миграция обратима (`database.integration.test.ts`); `ai_job` и `translation_task` в `ormTables` и в проверке схемы; существующие тесты не ослаблены — там, где перечни точные (маршруты админки, группы настроек, задачи и расписания, миграции, таблицы ORM, конфигурация), они только дополнены новым; перехват вывода — чист (`expectNoSecretsWritten` после каждого файла).
- **AC-13 — PASS для кода и документации; прогон коммита с отчётом — в ответе сессии.** Коммиты по D-024 — только явно названные файлы (состав ниже). CI `2041bb6` — run 35489729701: **success с первой попытки (attempt 1)**, все шаги (форматирование, lint, typecheck, unit, integration, build, `openapi:check`, `openapi:compat`, `verify:graceful-shutdown` на Linux) зелёные. Прогон коммита с отчётом — в ответе сессии.
- **AC-14 — PASS.** ARCHITECTURE.md 0.22: 4.19 (I173–I184), 5.4, 9.6, 13.2, 14, версия и история; CLAUDE.md, блок 0: структура (`modules/ai`, `translation-*.ts`), как в dev увидеть автоперевод, очередь и записи учёта, правка/повтор/снятие, недоступный провайдер, предел, настройки, метрики, юнит- и интеграционные тесты; **добавлено пропущенное из TASK-011.A**: `sameProduct=matching`, `sameProductItems`, `dev.daily-at-setting`.

### Состав коммитов (D-024)

| Коммит | Файлы |
|---|---|
| `cc89491` Update project plan and state, add TASK-012 (Product Owner edits) | `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-012.md` (правки Product Owner, отдельно, как требует D-024) |
| `2fcc8be` Add the AI gateway, call accounting and the translation data model | `infra/migrations/1789900000000_create-ai-jobs-and-translation-tasks.sql`; `apps/api/src/modules/ai/` (`ai-gateway.ts`, `ai-gateways.test.ts`, `ai-pricing.ts`, `ai.module.ts`, `ai.service.ts`, `claude-ai-gateway.ts`, `index.ts`, `schema.ts`, `test-ai-gateway.ts`); `apps/api/src/config/` (`env.schema.ts`, `env.schema.test.ts`, `index.ts`); `.env.example`; `apps/api/src/observability/metrics.service.ts`; `apps/api/src/modules/catalog/schema.ts`, `catalog-texts.test.ts`; `apps/api/src/orm-tables.ts`; `apps/api/src/database/` (`schema-drift.test.ts`, `database.integration.test.ts`); `apps/api/src/testing/database.ts`; `apps/api/package.json`, `pnpm-lock.yaml` |
| `6ee128a` Translate catalog names automatically and let administrators keep their own | `apps/api/src/modules/catalog/` (`translation-queue.service.ts`, `translation-runner.ts`, `translation-checks.ts` + `.test.ts`, `translation-jobs.ts`, `translation-admin.service.ts`, `translation-admin.controller.ts`, `translation.integration.test.ts`, `catalog-names.ts`, изменены `catalog-texts.ts`, `catalog-admin.service.ts`, `catalog-items.service.ts`, `catalog.module.ts`, `dev-catalog-seed.ts`, `index.ts`); `apps/api/src/jobs/job-queue.service.ts`; `apps/api/src/modules/settings/registry/` (`registry.ts`, `registry.test.ts`); `apps/api/src/modules/settings/settings.integration.test.ts`; `apps/api/src/modules/identity/access.integration.test.ts`, `…/cleanup/sign-in-data-cleanup.integration.test.ts`; `apps/api/src/app.module.ts`, `worker.module.ts`, `operator.ts`, `background-jobs.ts`; `packages/contracts/src/` (`translations.ts`, `routes.ts`, `error.ts`, `audit.ts`, `catalog.ts`, `index.ts`, `openapi.ts`, `openapi.test.ts`); `apps/api/openapi.json` |
| `2041bb6` Document the AI interface and automatic translation | `ARCHITECTURE.md`, `CLAUDE.md` |
| `c50022c` Assert the requeued journal entry in the translation tests | `apps/api/src/modules/catalog/translation.integration.test.ts` (одна проверка записи журнала `requeued`) |
| коммит отчёта | `tasks/TASK-012-REPORT.md` |

## Errors & Fixes

- **Первый полный `test:integration`: 23 падения.** Причины: (1) точные перечни, которые задача обязана была расширить (миграции и откаты, группы настроек, маршруты админки, задачи и расписания) — тесты дополнены; (2) **пять тестов `observability` дали 503 при входе** в том прогоне, где параллельно шли мои юнит-тесты и форматирование; не воспроизвелось ни отдельно, ни в двух следующих полных прогонах — причина не установлена (см. Known Issues); (3) **гонка в моём тесте «…neighbour already has as its name»**: ждал, пока останется одна задача, а она ещё была `pending` — теперь ждёт, пока она `failed`. Финальный полный прогон — 270/270.
- **Сырой управляющий байт в исходнике теста** (инструмент записи файлов превратил `\u0007` в сам символ): найден сканом, заменён `String.fromCharCode(7)` (ARCHITECTURE 4.18 I172).
- **`OpenApiController` падал при старте API** («schema missing from componentSchemas»): схемы ответов новых маршрутов не были добавлены в `componentSchemas`; добавлены.
- **Испорченный кириллицей шелл** при ручных сценариях — см. UAT.

## Deviations

- **Бренды не переводятся** (TASK, «Что и когда переводится», называет бренды): бренд — не в `translation`, а в `brand`/`brand_spelling`, это имена собственные, и одно написание принадлежит одному бренду (перевод разрушил бы сопоставление прайсов). Решение — I182; если Product Owner хочет переводить и марки, нужна отдельная модель.
- **Группа настроек «Переводы справочника»** добавлена в реестр и в ARCHITECTURE 14; в SCREENS A-SET-01 такой группы нет — SCREENS.md не менял (ведёт Product Owner), нужна правка.
- **«Не прошедший проверку … не повторяется бесконечно»** реализован как состояние задачи `failed` (видно оператору и админу), а не как запись в мёртвой очереди pg-boss: запуск в целом успешен, отказан один текст; мёртвая очередь — для отказов и недоступности провайдера (требование 3). Различие принято ради того, чтобы негодный текст не блокировал остальные задачи пакета.
- **Пакетность:** один запрос на пакет названий (`translation_batch_size`); асинхронный Batch API (ARCHITECTURE 9.6, 13.2 — «ночью −50 %») не используется: перевод должен появиться сразу как рабочий, объём справочника мал (I184).
- **Seed изменён:** часть названий (подкатегории «Чехлы», «Аксессуары», четыре масла) оставлена только по-русски — иначе сценарий «после seed и worker'а появляются переводы» не на чем показать. Счётчики и структура seed прежние, тесты TASK-010/011 не менялись.

## Known Issues / Risks

- **Реализация Claude не проверена настоящим вызовом.** Форма запроса, структурированный вывод, разбор ответа и классификация ошибок проверены на подменённом HTTP; поведение реальной модели (качество казахского, длина, соблюдение `maxLength`), точность прайса (таблица 9.6 — предположение) и лимиты провайдера — не проверены. Первый настоящий прогон — под контролем расхода (`ai:status`).
- **Проверка языка — эвристика:** английский не должен содержать кириллицу, казахский для русского текста с кириллицей — тоже с кириллицей. Английское название с кириллической маркой («Масло Лада») будет отвергнуто как `wrong_language`; администратор пишет такой текст вручную.
- **После мёртвой очереди перевод сам не возобновляется** (задачи с временной ошибкой ждут следующего изменения, `jobs:retry` или `translations:run`) — намеренно, чтобы не сыпать мёртвыми запусками при долгом сбое провайдера.
- **Расход может превысить предел** не больше чем на число одновременных вызовов (проверка — перед вызовом). Строка `ai_job` со статусом `running` от умершего процесса остаётся (уборка — TASK-055).
- **Запуск на каждое изменение:** при массовом изменении будет много запусков, большинство находит пустую очередь — дёшево, но шумно в `jobs:status`.
- **Ручная правка через `PUT` версию сущности не увеличивает** (одновременные правки переводов — «последний побеждает»; правка самой сущности использует версию, как раньше).
- **Снятая ручная правка** остаётся видимой, помечена `ai` без модели, пока автоперевод не заменит её; если провайдер недоступен долго, чужой текст числится «ИИ».
- **Список ждущего** — запрос по всем русским текстам × 2 языка без индекса; для десятков тысяч записей достаточно, для сотен тысяч понадобится индекс/материализация.
- **Не воспроизведённый сбой:** в первом полном прогоне `observability.integration.test.ts` дал 503 на входе по коду (5 тестов), затем не повторился; вероятная причина — нагрузка машины при параллельных Docker-контейнерах и моих командах, но не подтверждено. Если появится в CI — смотреть Redis/PostgreSQL контейнеров и порядок тестов внутри файла.
- **`verify:graceful-shutdown`** не проверяется на Windows (проверка — в CI на Linux, прошла).

## Remaining Work

None.

## Future Improvements

- Первый настоящий вызов Claude под контролем расхода; глоссарий терминов и марок в системном промпте (кэшируемый префикс), проверка казахского носителем.
- Асинхронный Batch API для больших массовых переводов (после импорта каталога, EPIC-16).
- Автоматическое возобновление после восстановления провайдера (проба здоровья вместо ручного `jobs:retry`).
- Уборка старых `ai_job` и строк `running`; отчёт о расходе по видам за период (экран админки).
- `translations:queue-missing` по расписанию как опция настройки (по умолчанию выключена).
- Отбор «без перевода» в списке позиций (SCREENS A-CAT-04) — уже можно строить на `GET /admin/translations`.

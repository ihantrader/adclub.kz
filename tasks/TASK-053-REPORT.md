# TASK REPORT — TASK-053

## Status

PARTIAL — 9 из 11 обязательных AC выполнены. AC-7 и AC-8 (проверка на настоящих вызовах и реальная проверка дневного предела) — **BLOCKED**: ключа `OPENROUTER_API_KEY` в `.env` репозитория нет.

## Result

Все обращения к ИИ идут через OpenRouter — единственного провайдера проекта (D-055). Прямой канал к Anthropic и SDK `@anthropic-ai/sdk` удалены; реализация — один файл на стандартном `fetch` (API OpenRouter совместим с OpenAI).

Что теперь умеет система:

- **Модель под операцию — настройка, основная и запасная** (D-056). `ai_model_translate_primary` (по умолчанию `google/gemini-3.8-flash`) и `ai_model_translate_fallback` (`openai/gpt-5.4-mini`) меняются без релиза и применяются не позже чем через 30 с. При отказе вида «недоступно» или «нет такой модели» вызывается запасная, и в записи вызова это видно (`ai_job.is_fallback`). Значение не в форме `author/slug` настройка не принимает.
- **Приватность в каждом запросе** (D-057): `provider: { zdr: true, data_collection: "deny", require_parameters: true }`. Если у модели нет точки, которая не хранит запрос, OpenRouter отвечает 404, **запрос не уходит никуда**, и это отдельный вид отказа `no_private_provider` — операция не выполняется, отказ виден оператору, запасная модель не пробуется.
- **Расход — по данным провайдера**: `usage.cost` из ответа пишется в `ai_job.cost_usd`. Таблица цен в коде удалена. Неизвестная (или ровно нулевая) стоимость не считается нулём: за вызовом остаётся его резерв, строка помечается `cost_is_estimate`, оператор видит `estimatedCostCalls`.
- **Дневной предел не обходится одновременными вызовами**: проверка и резервирование — одна транзакция под `pg_advisory_xact_lock('ai_budget')`, сумма суток считается вместе с резервами выполняющихся вызовов. Предел действует на все операции ИИ, потому что резерв берёт `AiService`.
- **Неполный ответ — временная ошибка**: недостающие тексты остаются ожидающими с причиной `incomplete_answer` и переспрашиваются по правилам повторов задачи (а не помечаются «пустой перевод» навсегда). Запуск на таком пакете заканчивается, чтобы не крутить платные вызовы подряд.
- **Инициатор вызова настоящий**: `translation_task.requested_by` помнит администратора, нажавшего «перевести заново» или снявшего ручную правку; запуск делит пакет по инициаторам и на каждого делает свой вызов.
- **Перевод больше не сериализует справочник**: сохранение берёт блокировку структуры разделяемо плюс блокировку множества имён соседей вместо исключительной блокировки структуры.
- **`ai:status` — за сутки**: провайдер, предел, расход (и сколько держат выполняющиеся вызовы), вызовы по видам и статусам, вызовы с оценочной стоимостью и **отказы за эти же сутки** (раньше окно не ограничивалось).

## Changes

Коммиты (состав каждого — ниже, раздел «Commits»).

**Провайдер и шлюз**

- `apps/api/src/modules/ai/openrouter-ai-gateway.ts` (новый) — вызов `POST {base}/chat/completions` на `fetch`, строгая JSON-схема ответа (`response_format: json_schema`, `strictJsonSchema` закрывает все объекты), требование маршрутизации D-057, разбор отказов: 404 про data policy → `no_private_provider`, прочий 404 → `model_unavailable`, 408/409/429/5xx → `unavailable`, прочие 4xx → `rejected`, ошибка внутри 200 — тоже отказ. Ключ только в заголовке `Authorization`.
- Удалены `apps/api/src/modules/ai/claude-ai-gateway.ts` и `ai-pricing.ts`; из `apps/api/package.json` — `@anthropic-ai/sdk`.
- `apps/api/src/modules/ai/ai-gateway.ts` — `AiGateway.translate(input, model, signal)`; `AiOperation` называет не модель, а два ключа настроек; новые виды отказа `model_unavailable`, `no_private_provider` и список `FALLBACK_WORTHY`.
- `apps/api/src/modules/ai/ai.service.ts` — выбор модели из настроек и запасная, резервирование бюджета в транзакции под блокировкой, стоимость от провайдера с осторожным учётом неизвестной, `is_fallback`, окно отказов `ai:status` — сутки, попытка со своим ограничением по времени.
- `apps/api/src/modules/ai/test-ai-gateway.ts` — принимает и возвращает модель, режимы `no_private_provider`, `incomplete`, `no_cost`, префикс `missing/` как несуществующая модель (чтобы видеть запасную в dev без ключа), правдоподобная выдуманная стоимость.
- `apps/api/src/config/env.schema.ts` — `AI_PROVIDER` `test`/`openrouter`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (только dev); `ANTHROPIC_API_KEY` переведён в «переменные, которые больше ничего не делают» (предупреждение при старте).

**Настройки и контракт**

- `apps/api/src/modules/settings/registry/registry.ts` — группа «ИИ» (`ai`): `ai_model_translate_primary`, `ai_model_translate_fallback`, `ai_call_reservation_usd` (0.05).
- `setting-definition.ts` — у строковой настройки появился `pattern` (проверка формы идентификатора модели).
- `packages/contracts/src/settings.ts` + `apps/api/openapi.json` — аддитивное поле `pattern` в `SettingConstraints`.

**Перевод справочника (потребитель шлюза)**

- `translation-runner.ts` — деление пакета по инициаторам, обработка неполного ответа, сохранение под разделяемой блокировкой структуры и блокировкой имён соседей.
- `translation-queue.service.ts`, `translation-admin.service.ts`, `schema.ts` — `requestedBy` до задачи перевода.
- `catalog-locks.ts` (`nameScopeLock`), `catalog-names.ts` (`nameNeighbours` возвращает `scope`).

**Миграция** `infra/migrations/1789990000000_ai-through-openrouter.sql` — провайдер `('test','openrouter')`, два новых вида отказа, колонки `ai_job.cost_is_estimate`, `ai_job.is_fallback`, `translation_task.requested_by`; откат обратим и не переписывает уже случившиеся вызовы.

**Документы** — `ARCHITECTURE.md` (9.6 переписан, новый 4.20 I185–I194, 14, 5.12, версия 0.23 и история), `CLAUDE.md` (блок 0), `.env.example`.

## Commits

| Коммит | Состав |
|---|---|
| `9fa1641` | **Правки Product Owner** (`PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-013.md`, `tasks/TASK-053.md`). Отдельным коммитом в `main` — **но его сделала не эта сессия**: на момент начала работы рабочее дерево было чистым (`git status` — clean), а эти правки уже лежали в `main` отдельным коммитом с нужным сообщением. Отдельного коммита правок PO эта сессия не делала, потому что коммитить было нечего. |
| `93a537d` | `Send every AI call through OpenRouter (TASK-053)` — 31 файл: `.env.example`, `apps/api/package.json`, `pnpm-lock.yaml`, `packages/contracts/src/settings.ts`, `apps/api/openapi.json`, `apps/api/src/config/{env.schema.ts,env.schema.test.ts,ignored-variables.ts}`, `apps/api/src/modules/ai/{ai-gateway.ts,ai.module.ts,ai.service.ts,index.ts,schema.ts,openrouter-ai-gateway.ts,test-ai-gateway.ts,ai-gateways.test.ts}` (+ удалены `claude-ai-gateway.ts`, `ai-pricing.ts`), `apps/api/src/modules/settings/registry/{registry.ts,registry.test.ts,setting-definition.ts}`, `apps/api/src/modules/settings/settings.integration.test.ts`, `apps/api/src/modules/catalog/{catalog-locks.ts,catalog-names.ts,schema.ts,translation-admin.service.ts,translation-queue.service.ts,translation-runner.ts,translation.integration.test.ts}`, `apps/api/src/database/database.integration.test.ts`, `infra/migrations/1789990000000_ai-through-openrouter.sql` |
| `0c25f9b` | `Document the AI gateway through OpenRouter (TASK-053)` — `ARCHITECTURE.md`, `CLAUDE.md` |
| `acb005a` | `Stop a translation run after an incomplete answer (TASK-053)` — `apps/api/src/modules/catalog/translation-runner.ts`, `apps/api/src/modules/catalog/translation.integration.test.ts` (найдено при просмотре итогового diff, см. «Errors & Fixes») |
| `e0b0a71` | `Add the TASK-053 report` — `tasks/TASK-053-REPORT.md` |
| `42cd48a` | `tasks/TASK-053-REPORT.md` — номер и статус прогона CI коммита с отчётом |

Состав каждого коммита собирался перечислением путей (`git add <путь> …`), `git add -A`/`-a`/`.` не использовались (D-024).

## Technical Decisions

Внесены в `ARCHITECTURE.md`: раздел **4.20 (I185–I194)** — решения реализации; раздел **9.6** переписан под OpenRouter; **14** — группа настроек «ИИ» и переменные окружения; **5.12** — новые поля `ai_job`; версия 0.23 и запись в истории.

Значимое:

1. **Без SDK провайдера** (I185). API OpenRouter совместим с OpenAI, поэтому реализация — `fetch`, и в зависимостях проекта нет пакета провайдера (раньше был `@anthropic-ai/sdk`).
2. **`require_parameters: true` вместе с `zdr`** (I186). Без него запрос мог бы уйти на точку, которая не умеет `response_format`, и та ответила бы прозой. Следствие, которое важно знать при выборе модели: **на 2026-09-20 у `anthropic/claude-sonnet-5` и `claude-opus-5` ZDR-точки есть, но структурированный вывод они не поддерживают** — с нашими требованиями этими моделями пользоваться нельзя (проверено по `https://openrouter.ai/api/v1/endpoints/zdr`).
3. **404 разбирается по тексту сообщения** (I186). Это единственный способ отличить «нет провайдера без хранения» от «нет такой модели»: оба случая OpenRouter отдаёт как 404. Маркеры — `data polic`, `data retention`, `zdr`, `zero data`. Если OpenRouter изменит формулировку, отказ станет `model_unavailable` — операция всё равно не выполнится и всё равно будет видна оператору, но вид будет менее точным (риск отмечен ниже).
4. **Резерв как механизм допуска к бюджету** (I188, I189). Резерв — не учёт, а удержание: он заменяется настоящей стоимостью на завершении вызова. Он же служит осторожной оценкой, когда провайдер стоимость не сообщил. Погрешность предела описана в 4.20 I189: превышение ограничено стоимостью вызовов, допущенных пока сумма была ниже предела, сверх их резервов.
5. **Блокировка имён вместо блокировки структуры** (I191). `nameNeighbours` теперь возвращает ещё и `scope` — «множество соседей» (`category:<parentId>`, `category:root:<kind>`, `attribute:<categoryId>`, `attribute_option:<attributeId>`); позиции справочника соседей по названию не имеют, для них блокировка не берётся. Гонок нет: изменение структуры остаётся исключительным и потому исключает переводы, два перевода соседей идут по очереди.
6. **Один вызов на инициатора** (I190). Взятый пакет делится по `requested_by`; при обычной работе (изменения текстов — «система») это один вызов, как раньше.

### Модели по умолчанию и основания

Цены и наличие точек проверены по API OpenRouter **2026-09-20** (`/api/v1/models`, `/api/v1/endpoints/zdr`), за 1M токенов вход/выход:

| Модель | Цена | ZDR-точки со структурированным выводом |
|---|---|---|
| **`google/gemini-3.8-flash`** (основная) | $0.75 / $3.75 | 3 (Google Vertex), контекст 1M |
| **`openai/gpt-5.4-mini`** (запасная) | $0.75 / $4.50 | 2 (Azure), контекст 400k |
| `google/gemini-3.5-flash-lite` | $0.30 / $2.50 | 5 (Google) |
| `anthropic/claude-haiku-4.5` | $1.00 / $5.00 | 3 (Amazon Bedrock) |
| `anthropic/claude-sonnet-5` | $2.00 / $10.00 | **нет** (ZDR-точки есть, структурированного вывода у них нет) |
| `openai/gpt-5.4` | $2.50 / $15.00 | 3 (Azure) |

Почему так:

- **Перевод справочника — короткие названия, и качество на казахском важнее скорости и цены.** Семейство Gemini шире других покрывает тюркские языки и официально поддерживает казахский; это соображение о возможностях модели, **а не измеренный результат** (см. «Оценка качества казахского» ниже).
- `gemini-3.8-flash` — новейшая flash-модель Google (вышла 2026-09-02) по цене предыдущей 3.7; объём справочника мал, поэтому платить за pro-класс незачем, а экономить на lite — неразумно, когда весь перевод справочника стоит центы.
- **Запасная — другого поставщика** (Azure/OpenAI, а не вторая модель Google): сбой одного поставщика не должен останавливать перевод. Требованиям ZDR + структурированный вывод `openai/gpt-5.4-mini` удовлетворяет.
- Product Owner меняет обе модели настройкой без релиза — в этом смысл D-056; эти значения — стартовая точка, а не приговор.

## Verification

| Проверка | Результат |
|---|---|
| `pnpm format:check` | PASS — «All matched files use Prettier code style!» |
| `pnpm lint` | PASS — 12 задач, 0 ошибок, 0 предупреждений |
| `pnpm typecheck` | PASS — 18 задач |
| `pnpm build` | PASS — 11 задач |
| `pnpm test` (unit + e2e) | PASS — 15 задач; `@adclub/api` 35 файлов / 397 тестов |
| `pnpm test:integration` (Testcontainers) | PASS — 13 файлов / **281 тест**, в том числе 34 в `translation.integration.test.ts` (24 прежних + 10 новых) и 20 в `database.integration.test.ts` |
| `pnpm --filter @adclub/api openapi:check` | PASS — «matches the contract and the served routes» |
| `pnpm --filter @adclub/api openapi:compat --base origin/main` | PASS — «Contract is backward compatible with origin/main» (единственное изменение — аддитивное поле `pattern`) |
| `pnpm --filter api migrate` на dev-базе | PASS — «Migrations complete!», миграция применена |
| Откат миграции | PASS — тест `rolls back the latest migration only (AI through OpenRouter), keeping the calls`: колонки исчезают, записи вызовов остаются, `up` возвращает колонки со значениями по умолчанию |
| CI на `main` (коммит `acb005a`) | см. «CI» ниже |
| **Реальные вызовы OpenRouter** | **BLOCKED** — нет ключа (см. ниже) |

### Почему реальные вызовы BLOCKED

`OPENROUTER_API_KEY` в `.env` репозитория отсутствует. Проверено четырежды за сессию, в том числе после сообщения «OPENROUTER_API_KEY in .env»: в файле 11 переменных — `GITHUB_PAT`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `CLIENT_MIN_VERSION_IOS`, `CLIENT_MIN_VERSION_ADMIN_WEB`; ни `OPENROUTER_API_KEY`, ни любой другой ключ ИИ в нём не появлялись (проверка — поиск по имени переменной, значения не выводились). Ни одного обращения к api.openrouter.ai в этой работе сделано не было.

Что именно осталось непроверенным: настоящий ответ OpenRouter (форма ответа, `usage.cost`, поведение `provider.zdr`/`data_collection` и текст его 404), настоящие токены, стоимость, время ответа и **качество перевода, включая казахский**. Реализация проверена на подменённом HTTP-уровне (`fetch` из теста) — это проверка нашего кода, а не сервиса.

### UAT в dev с тестовой реализацией

Выполнено вручную в dev (PostgreSQL, Redis, Meilisearch, MinIO в Docker; `AI_PROVIDER=test`, внешних вызовов нет):

1. **Миграция** — `pnpm --filter api migrate` → «Migrations complete!».
2. **Настройки видны и проверяются**: `operator settings:get ai_model_translate_primary` → `"value":"google/gemini-3.8-flash"`, `"constraints":{"minLength":1,"maxLength":100,"pattern":"^~?[a-z0-9]…"}`, `"group":"ai"`.
3. **Смена модели настройкой, без перезапуска**: `settings:set ai_model_translate_primary missing/none --reason "dev check of the fallback"` → версия 1, `previousValue` в истории.
4. **Запасная модель работает**: `pnpm --filter api operator dev:catalog:seed` (`translationsQueued: 18`), затем worker — в журнале:
   `AI attempt failed job=a14e4f82-… kind=translate model=missing/none fallback=false error=model_unavailable: The test AI provider has no model missing/none — trying the fallback model`
   `AI call succeeded job=a14e4f82-… kind=translate provider=test model=openai/gpt-5.4-mini fallback=true tokensIn=235 tokensOut=178 costUsd=0.001125 durationMs=8`
   В базе: `model = openai/gpt-5.4-mini`, `is_fallback = true`, `cost_is_estimate = false`, `cost_usd = 0.001125`, `tokens_in = 235`, `tokens_out = 178`, `latency_ms = 2`.
5. **Опечатка в настройке отклоняется**: `settings:set ai_model_translate_primary gpt5` → `VALIDATION_ERROR: The value doesn't fit the setting [{"path":"value","message":"Must be an OpenRouter model identifier, e.g. google/gemini-3.8-flash"}]`.
6. **Дневной предел останавливает отправку** (тестовая реализация; настоящая проверка — AC-8, BLOCKED): при `ai_daily_budget_usd = 0.001` и потраченных $0.001125 — 9 ждущих задач, в журнале worker'а
   `AI daily budget exhausted, the call is not sent kind=translate spentUsd=0.001125 budgetUsd=0.001`
   `Translation stopped: the daily AI budget is spent ($0.001125 of $0.001); pending tasks wait for a new day or a raised budget`
   успешных вызовов за прогон — 0, переводы не потеряны. После `settings:reset ai_daily_budget_usd` и `translations:run` — 1 успешный вызов, задач в очереди 0, переводов `origin = ai`: kk 9, en 9.
7. **`ai:status`**: `{"budgetUsd":100,"spentUsd":0.001125,"heldUsd":0,"exhausted":false,"provider":"test","today":[{"kind":"translate","status":"succeeded","calls":1}],"estimatedCostCalls":0,"recentFailures":[]}`.

## Оценка качества казахского

**Не проверено и не оценивалось.** Настоящих вызовов не было, поэтому ни одного настоящего перевода на казахский эта работа не получила. Сомнительных переводов перечислить нечего — перечислять было бы нечестно: тестовая реализация выдаёт `Чехлы [kk]`, а это не перевод и никогда им не притворялось.

Что сделано, чтобы оценка была возможна сразу после появления ключа: системная подсказка перевода требует казахскую кириллицу, термины автокаталога, сохранение артикулов, марок, вязкостей и стандартов и запрет объяснений; проверка сохранения отвергает текст не на том языке, пустой, длиннее поля, с управляющими символами и совпадающий с названием соседа. Само по себе это качество не доказывает.

Когда ключ появится, для оценки достаточно: `OPENROUTER_API_KEY=<ключ>` в `.env`, `pnpm --filter api operator translations:queue-missing`, worker, затем `curl -s localhost:3000/catalog/categories -H "Accept-Language: kk"` и `GET /admin/translations/<type>/<id>`; 10–15 названий kk/en, токены, стоимость и время ответа берутся из `ai_job` и `operator ai:status`. Проверку с носителем языка выполняет Product Owner.

## Что Product Owner должен включить в настройках OpenRouter

1. **Пополнить счёт** (Credits) — без баланса вызовы получают 402, который у нас классифицируется как `rejected` (повтор не поможет).
2. **Privacy → Zero Data Retention: включить для всех групп моделей** — Anthropic, OpenAI, Google, SpaceXAI и «All other models» (D-057). Запрос и так несёт `zdr: true`, настройка учётной записи — вторая линия: она действует и на то, что пойдёт мимо нашего кода.
3. **Privacy → «Use of Inputs/Outputs» (скидка 1 % за разрешение использовать запросы и ответы) — оставить ВЫКЛЮЧЕННЫМ.** По умолчанию выключено; включение прямо противоречит D-057.
4. **Observability → «Private Input & Output Logging» — оставить ВЫКЛЮЧЕННЫМ** (по умолчанию выключено). Включение складывает наши запросы и ответы в логи учётной записи OpenRouter; это не обучение, но это хранение.
5. **Создать API-ключ** и положить его в `.env` репозитория как `OPENROUTER_API_KEY=` (в git `.env` не попадает). Для ключа стоит задать **лимит кредитов** — вторая защита рядом с нашим `ai_daily_budget_usd`.
6. **Проверить, что выбранные модели доступны учётной записи.** Если какая-то группа моделей отключена настройками приватности целиком, вызов к её модели вернёт 404 — у нас это `model_unavailable` или `no_private_provider`, видно в `operator ai:status`.
7. Ничего другого включать не нужно: BYOK, «free endpoints», интеграции и Guardrails для этой задачи не требуются.

## Acceptance Criteria

- **AC-1 — PASS.** Шлюз через OpenRouter: `apps/api/src/modules/ai/openrouter-ai-gateway.ts`; прямой Anthropic убран (`claude-ai-gateway.ts` удалён, `@anthropic-ai/sdk` удалён из `apps/api/package.json` и из `pnpm-lock.yaml` — `grep -c anthropic pnpm-lock.yaml` → 0). Конфигурация и `.env.example` приведены в соответствие. Тесты: `env.schema.test.ts` — «runs the test provider without a key and OpenRouter with one», «refuses OpenRouter without a key and production with the test provider, naming the variable only» (production с `test` не стартует, то есть **без ключа production не стартует**), «says that the key of the provider the project no longer has does nothing».
- **AC-2 — PASS.** Модели — настройки `ai_model_translate_primary`/`ai_model_translate_fallback` (группа «ИИ», `registry.ts`). Тесты (`translation.integration.test.ts`): «takes the model of the setting, and a new setting changes it without a restart» (worker не перезапускается, следующий пакет уходит новой моделью), «uses the fallback model when the first one cannot answer, and records that it did» (`ai_job.model = openai/gpt-5.4-mini`, `is_fallback = true`, перевод записан этой моделью), «says plainly when no model of the setting can answer, and loses no translation» (`error_kind = model_unavailable`, задачи остаются ожидающими, отказ виден в `ai:status`). Ручная проверка в dev — UAT п. 3–5.
- **AC-3 — PASS.** Стоимость из ответа провайдера: `openrouter-ai-gateway.ts` (`usage.cost`), тест «asks the model it was given…» сверяет `costUsd: 0.000345` из ответа и «does not read a missing or zero cost as free». Неизвестная стоимость не ноль: тест «counts what the provider says the call cost, and an unknown cost as the reservation» (`cost_is_estimate = true`, `cost_usd = 0.07` = резерв, `estimatedCostCalls = 1`). Предел не обходится одновременными вызовами: тест «lets no two calls at once past the daily budget» — четыре параллельных вызова при бюджете $1 и резерве $0.5: два выполнены, два получили `AiBudgetExhaustedError` **до отправки** (`gateway.requests` — 2, строк `ai_job` — 2).
- **AC-4 — PASS.** Неполный ответ — временная ошибка: тест «asks again for a part of the batch the provider left out, instead of calling it empty» (`last_error = incomplete_answer`, ни одной задачи `failure = 'empty'`, после возврата провайдера тексты переведены; отдельно проверено, что запуск не крутит вызовы подряд). Инициатор: тест «records the administrator who asked for a translation, not the system» (`initiator_type = account`, `initiator_id` = `account_id` администратора). Отказы за сутки: тест «shows the operator the failures of this day only» (вчерашний отказ в `recentFailures` не попадает).
- **AC-5 — PASS.** Требование в каждом запросе: тест «asks the model it was given, for structured output, only from providers that keep nothing» сверяет в теле `provider: { zdr: true, data_collection: "deny", require_parameters: true }`. Отсутствие такого провайдера на подменённом ответе: тест «tells a model with no private provider apart from a model it does not have» (404 «No endpoints found matching your data policy (Zero data retention)» → `no_private_provider`; 404 про модель → `model_unavailable`) и интеграционный «does not send anything when no provider of the model keeps requests unstored» — перевод не сохранён, задачи целы, отказ в `ai:status`, запасная модель не пробовалась.
- **AC-6 — PASS.** Тест «saves a translation without stopping the administrator's work on the catalog»: сторонняя транзакция держит `pg_advisory_xact_lock_shared('catalog_structure')` (так пишет любая позиция), и `TranslationRunner.save` в это время проходит целиком (гонка с 5-секундным ожиданием — прежняя исключительная блокировка ждала бы). Обоснование корректности — ARCHITECTURE 4.20 I191.
- **AC-7 — BLOCKED.** Точная причина: в `.env` репозитория нет `OPENROUTER_API_KEY` (см. «Почему реальные вызовы BLOCKED»). Модели, вызовы, токены, стоимость, время ответа и примеры переводов kk/en на настоящих моделях не получены; сомнительные переводы не перечислены, потому что переводов нет.
- **AC-8 — BLOCKED** по той же причине. На тестовой реализации предел проверен реально (UAT п. 6): при `ai_daily_budget_usd = 0.001` отправка останавливается, изменения не теряются, событие видно оператору и в журнале.
- **AC-9 — PASS.** Существующие тесты проходят без ослабления: 397 unit + 281 интеграционных, ни один не удалён и не пропущен; изменённые ожидания — следствие новой модели поведения, а не смягчение (список — «Errors & Fixes»). Внешних вызовов в тестах и CI нет: `OpenRouterAiGateway` в тестах получает собственный `fetch`, в dev/тестах/CI работает `TestAiGateway`. Перехват вывода интеграционных тестов (`output-capture.ts`) чист; ключ в тестах — заведомо ненастоящий, и тест отдельно проверяет, что он не попадает ни в тело запроса, ни в текст ошибки.
- **AC-10 — PASS (CI — см. ниже).** Контракт совместим (`openapi:compat --base origin/main` — «Contract is backward compatible»; изменение аддитивное, трейлер не нужен). Миграция обратима (тест отката). Коммиты по D-024, состав — в разделе «Commits».
- **AC-11 — PASS.** `ARCHITECTURE.md`: 9.6 переписан, добавлен 4.20 (I185–I194), уточнены 14 и 5.12, версия 0.23 и запись в истории. `CLAUDE.md` блок 0: как задать ключ, посмотреть расход и отказы, сменить модель настройкой, запустить перевод вручную. Что включить в OpenRouter — раздел выше.

## CI

Прогон CI для последнего коммита кода и документации — **№ 35495418113**, коммит `acb005a`, workflow `CI`, статус **completed / success**, задание `ci` — **success**. **Зелёный с первой попытки:** повторных запусков для этого коммита нет, `gh run list` показывает по одному прогону на коммит:

```
35495418113 acb005a completed success
35490011256 2bbe3ba completed success
```

Прогон CI для коммита с отчётом — **№ 35521185016**, коммит `e0b0a71`, статус **completed / success**, тоже с первой попытки (дописано в отчёт коммитом `42cd48a`).

## Errors & Fixes

1. **Расход негодного ответа перестал учитываться.** При переходе на попытки с запасной моделью `attempt()` бросал исключение и терял `AiResult`, поэтому вызов, чей ответ не прошёл схему, записывался без токенов и стоимости — это нарушало ARCHITECTURE 4.19 I175 («деньги потрачены — они входят в предел»). Поймано интеграционным тестом TASK-012 («records a call whose answer does not match its schema as failed, with its cost»). Исправлено: `attempt()` возвращает результат вместо исключения и отдаёт расход даже у отвергнутого ответа.
2. **Тесный цикл платных вызовов при неполном ответе** (найдено при просмотре итогового diff, коммит `acb005a`). Освобождённые задачи тут же попадали в следующий `claim()` того же запуска, и при провайдере, который стабильно не отвечает про часть пакета, запуск крутил бы вызовы подряд до 150 с. Исправлено: запуск завершается на пакете, вернувшемся неполным; переспрашивают повторы задачи с их паузой. Добавлена проверка в тесте.
3. **Гонка в новом тесте.** Задачи возвращаются в очередь чуть позже, чем запись вызова помечается неудачной; тест ждал запись и иногда читал задачи раньше времени (упало только в полном прогоне). Исправлено: тест ждёт сами задачи.
4. **Цепочка откатов миграций сбилась.** Тесты `database.integration.test.ts` откатывают по одной миграции за тест, а `runMigrate("up")` в середине теста возвращает все. Исправлено не подгонкой чисел, а помощником `walkDownPast(...)`, который откатывает, пока добавленное этим тестом не исчезнет — теперь следующая миграция цепочку не сдвинет.
5. **Ожидания прежних тестов, изменённые осознанно** (не ослабление): модель в `ai_job` и `translation.ai_model` теперь из настройки (`google/gemini-3.8-flash` вместо `claude-sonnet-5`); при недоступном провайдере запрашиваются обе модели операции, поэтому запросов к провайдеру 4 вместо 2 на две попытки (добавлена проверка, что вторая — запасная и `is_fallback` записан); список групп настроек пополнился группой `ai` в `registry.test.ts` и `settings.integration.test.ts`; `TestAiGateway.requests` теперь хранит и модель.
6. **Push от имени не того аккаунта.** `git push` вернул 403 (`Permission to ihantrader/adclub.kz.git denied to webdew-kz` — закэшированные учётные данные Windows). Обошлось без изменения настроек машины: push выполнен с токеном `GITHUB_PAT` из `.env` разово (`-c http.extraheader=…`), токен нигде не выведен и не сохранён.

## Deviations

1. **Первое действие задания — коммит правок Product Owner — выполнить было нечего.** На старте сессии `git status` был чист, а правки `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-013.md`, `tasks/TASK-053.md` уже лежали в `main` отдельным коммитом `9fa1641` «Update project plan and state, add TASK-013 and TASK-053 (Product Owner edits)». Новый коммит этих правок эта сессия не делала.
2. **Сообщение «OPENROUTER_API_KEY in .env» не подтвердилось.** Файл `.env` проверялся после этого сообщения и ещё дважды перед завершением работы — переменной в нём нет. Возможно, ключ положен в другой файл, в другую копию репозитория или не сохранён. Из-за этого AC-7 и AC-8 остались BLOCKED, а статус задачи — PARTIAL.
3. **`ai_daily_budget_usd` оставлен в группе «Гость и помощник»,** хотя по смыслу он теперь относится к группе «ИИ». Перенос сдвинул бы строку таблицы ARCHITECTURE 14 и группу в API настроек, а задача этого не требует; отмечено как улучшение.
4. **Асинхронный Batch API OpenRouter (дешевле) не используется** — как и в TASK-012: перевод нужен «сразу как рабочий», объём справочника мал (решение 4.19 I184 осталось в силе).

## Known Issues / Risks

1. **Различение «нет приватного провайдера» и «нет модели» держится на тексте сообщения OpenRouter** (оба случая — 404). Если формулировка изменится, отказ будет записан как `model_unavailable`: операция всё равно не выполнится и всё равно будет видна оператору, но вид отказа станет менее точным, и в этом случае будет испробована запасная модель (запрос при этом по-прежнему никуда не уходит). Проверить и, если нужно, поправить маркеры — при первом реальном прогоне с ключом.
2. **Выбор моделей по умолчанию сделан по возможностям и ценам, а не по измеренному качеству казахского.** Это прямо отмечено в ARCHITECTURE 9.6 и 4.20 I194.
3. **Резерв вызова, оборвавшегося вместе с процессом, держится до конца суток** (в сторону осторожности: бюджет скорее недоиспользуется, чем перерасходуется). Уборка таких строк — вместе с уборкой старых `ai_job` в TASK-055.
4. **`ai_call_reservation_usd` = $0.05 подобран под нынешние пакеты перевода** (реальный пакет из 20 названий на flash-модели стоит порядка $0.004). Для будущих тяжёлых операций (помощник с длинным контекстом) значение нужно будет поднять, иначе предел можно превысить на разницу между резервом и настоящей ценой.
5. **Миграция требует применения** (`pnpm --filter api migrate`) — в dev выполнена. Ручных действий, кроме ключа и настроек OpenRouter, не нужно.
6. **Модель `anthropic/claude-*` выбрать настройкой можно, но работать она не будет** при нынешних требованиях (нет ZDR-точек со структурированным выводом) — вызов даст `model_unavailable`/`no_private_provider`. Это поведение по замыслу (D-057 важнее модели), но при выборе модели об этом надо помнить.

## Remaining Work

1. Положить `OPENROUTER_API_KEY` в `.env` и выполнить проверку на настоящих вызовах — **AC-7** (модели, число вызовов, токены, фактическая стоимость, 10–15 примеров переводов kk/en, время ответа, список сомнительных переводов) и **AC-8** (маленький дневной предел останавливает отправку). Всё остальное для этого готово; ничего в коде менять не потребуется.
2. Проверка качества казахского с носителем языка — за Product Owner, после п. 1.
3. Включить настройки учётной записи OpenRouter по списку выше.

## Future Improvements

1. **Перенести `ai_daily_budget_usd` в группу «ИИ»** и заодно показать там же расход суток — сейчас ключ лежит в «Гость и помощник» по историческим причинам.
2. **Свипер «зависших» резервов**: задача, которая через N минут закрывает строки `ai_job` со статусом `running` от умерших процессов, освобождая их резерв (сейчас резерв держится до конца суток). Естественное место — TASK-055 вместе с уборкой старых `ai_job`.
3. **Разные модели для разных пакетов**: длинные названия позиций можно переводить моделью посильнее, короткие категории — lite-моделью; сейчас у операции одна пара моделей.
4. **Кэширование системной подсказки** (`cache_control` OpenRouter) — при больших объёмах перевода сократит вход; на нынешнем объёме справочника экономия несущественна.
5. **Показывать `no_private_provider` отдельным сигналом** (метрика и алерт), а не только в `ai:status` — это единственный отказ, который означает «мы сознательно не отправили данные», и его стоит замечать сразу. Место — TASK-055.
6. **Batch API OpenRouter** для массового дозаполнения характеристик (EPIC-04), где задержка неважна, а объём велик.

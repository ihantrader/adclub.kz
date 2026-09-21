# TASK REPORT — TASK-015

## Status
COMPLETED

## Result
Позиция справочника знает, к каким автомобилям она подходит, с той точностью, которая известна, и система однозначно отвечает для любого автомобиля — в том числе неполного.

- **Записи совместимости.** Запись — марка (обязательна) и, по желанию, модель, поколение, кузов, двигатель, КПП, привод, годы; пустой уровень — «любой». Согласованность уровней (модель этой марки, поколение этой модели, годы в пределах поколения) держат сервер (400 `COMPATIBILITY_CONDITIONS_INVALID` с `reason` и `field`) и триггер в базе. Одинаковые подтверждённые записи позиции запрещены уникальным индексом. Только для товаров (запчасти и товары по характеристикам): запись к услуге не создать и вручную в базе. Архивирование марки, поколения или модификации не меняет ни записей, ни результата. Перенос модели к другой марке или поколения к другой модели переносит и записи.
- **Ведение администратором** (`admin`): добавить, изменить, убрать в архив — с `expectedVersion` (чужая версия — 409, ничего не пишется), с основанием (текст или ссылка), каждое изменение — в журнале действий в той же транзакции. Копирование совместимости с аналога — одним действием: то, что у позиции уже есть, не дублируется; скопированное — подтверждённые записи с `source = copy` и ссылкой на оригинал.
- **Предложения поставщика** (`supplier`, только своя компания): сотрудник кабинета предлагает запись к активной запчасти или товару с основанием. До подтверждения на результат это не влияет. Поставщик видит только свои предложения и их состояние, отклонённые — с причиной; чужое — 404. Лимит — настройка `compatibility_proposals_per_supplier_day` (200 за скользящие сутки, сверх — 429 с `Retry-After`).
- **Модерация** (`admin`): очередь (позиция, компания, условия словами, основание, дата; `matchesRecordId` — такая запись уже подтверждена). Подтвердить как есть, подтвердить с правкой, отклонить с причиной. Совпадение с подтверждённой записью (в том числе два поставщика с одинаковым предложением) подтверждается без дубля (`resolution: already_approved`). Модель готова к предложениям ИИ (`source = ai`).
- **Расчёт** — одна функция для всех потребителей, `CompatibilityEvaluator.evaluate(car, scope)`, на сервере, одним SQL-запросом на любое число позиций. Четыре результата — «подходит», «уточните параметр» (с перечнем недостающих уровней), «не подходит», «совместимость не указана». Неизвестный год при записи с годами — «уточните год»; без года берутся годы модификации или поколения. Правило показа D-029 и признак предупреждения считает сервер (`mark`, `listed`, `requiresConfirmation`).
- **Клиентский маршрут** `POST /catalog/compatibility/check` — гостю и любой сессии: набор позиций (до 500) или вся подкатегория, автомобиль — модификация целиком или известные уровни. Несогласованный автомобиль — 400 `COMPATIBILITY_VEHICLE_INVALID` с причиной; невидимые клиенту позиции — одинаково в `notFound`.
- **Dev:** `operator dev:compatibility:seed` — колодки Geely → Atlas II, аналог TRW — копированием, масло — запись с двигателем, задние колодки — без данных; повтор ничего не создаёт.

## Changes
Коммиты — в разделе «Commits». Ключевые файлы:

- `infra/migrations/1790150000000_create-item-compatibility.sql` — `item_compatibility` (подтверждённый слой), `item_compatibility_proposal` (предложения); составные внешние ключи на `catalog_item (id, item_type)` (новый ключ `catalog_item_id_type_key`) и на `vehicle_option (id, kind)`; частичные уникальные индексы `NULLS NOT DISTINCT`; проверки лет, статусов, источника, основания, состояния рассмотрения; триггеры `item_compatibility_levels_agree`, `item_compatibility_follow_model`, `item_compatibility_follow_generation`. Down полный.
- `apps/api/src/modules/compatibility/`:
  - `compatibility-evaluator.ts` — единственный расчёт (один SQL-запрос) и маршрут проверки;
  - `compatibility-rules.ts` — результат и правило показа D-029 (чистые функции);
  - `compatibility-conditions.ts` — проверка условий записи и описания автомобиля, условия словами;
  - `compatibility-records.service.ts` — записи администратора, архив, копирование с аналога;
  - `compatibility-proposals.service.ts` — предложения, лимит, очередь, подтверждение, отказ;
  - `compatibility-store.ts`, `compatibility-errors.ts`, `compatibility.controller.ts`, `compatibility.module.ts`, `schema.ts`, `dev-compatibility-seed.ts`;
  - тесты: `compatibility-rules.test.ts` (юнит-таблица), `compatibility.integration.test.ts` (16 сценариев на настоящих PostgreSQL и Redis).
- `packages/contracts/src/compatibility.ts` (+ `compatibility.test.ts`), `routes.ts` (12 маршрутов), `error.ts` (9 кодов), `audit.ts` (6 действий, 2 сущности), `login-code.ts` (имя лимита), `openapi.ts` (схемы модуля в компоненты), `apps/api/openapi.json` (перегенерирован).
- `apps/api/src/modules/settings/registry/registry.ts` — группа «Совместимость».
- `apps/api/src/modules/vehicles/dev-vehicle-seed.ts` — у Atlas добавлено второе поколение «II (FX11)» (2023–) с модификацией 2.0T AT AWD 2024– (нужно для сценариев задачи).
- Подключение: `app.module.ts`, `operator.ts` (`dev:compatibility:seed`), `orm-tables.ts`, `testing/database.ts`; публичные входы `catalog`, `vehicles`, `identity` экспортируют нужные таблицы.
- Тесты, обновлённые под новые данные (аддитивно, без ослабления): `openapi.test.ts` (список путей), `schema-drift.test.ts` (список таблиц), `registry.test.ts` и `settings.integration.test.ts` (список групп), `database.integration.test.ts` (новая миграция в списке и отдельный тест её отката).

## Technical Decisions
Внесены в ARCHITECTURE.md 0.28, раздел 4.25 (I231–I243), уточнены 5.3 и 14.

- **Два слоя — две таблицы (I231).** Предложение несёт то, чего нет у записи (компания, причина отказа, итог), и никогда не читается расчётом.
- **Один расчёт — SQL (I238).** Правила сравнения записаны один раз — в запросе `CompatibilityEvaluator`; он сравнивает все записи всех позиций области с автомобилем и сводит по позиции. Превращение в результат и правило показа — чистые функции. Второй реализации на TypeScript нет: две реализации одних правил разошлись бы. Каталог и гараж вызовут тот же `evaluate`.
- **Правила (I239):** «подходит» важнее «уточните»; «уточните» перечисляет уровни записей, которым недостаёт меньше всего (а не все возможные); годы автомобиля без года — годы модификации или поколения; неизвестное автомобилю поколение, годы которого не пересекаются с годами автомобиля, — «не подходит». Двигатель по модификациям поколения не отсекается: справочник неполный, и такая эвристика скрыла бы подходящую деталь.
- **Копирование — только с аналога (I235):** с произвольной позиции совместимость разносилась бы на непроверенные детали.
- **Лимит предложений — в PostgreSQL (I236):** точный счёт под блокировкой компании, источник истины уже в таблице.
- **Проверка — POST (I241):** автомобиль и до 500 id — тело запроса; ответ не кэшируется.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS (12/12)
- `pnpm typecheck` — PASS (18/18)
- `pnpm test` — PASS (все пакеты; `@adclub/api` 40 файлов, `@adclub/contracts` 95 тестов, из них новые — юнит-таблица правил (20) и контракт (5))
- `pnpm build` — PASS (11/11)
- `pnpm --filter @adclub/api openapi:check` — PASS: «openapi.json matches the contract and the served routes»
- `pnpm --filter @adclub/api openapi:compat --base HEAD` — PASS: «Contract is backward compatible», трейлер не нужен
- `pnpm test:integration` — первый прогон (16 файлов параллельно): FAIL в 14 файлах из-за окружения (ECONNRESET к контейнерам, см. «Errors & Fixes») и одна настоящая ошибка — список миграций в `database.integration.test.ts`. Повторный полный прогон (`vitest run -c vitest.integration.config.ts --maxWorkers=3`): **347 passed, 3 failed** — три теста матриц доступа, перечисляющие все админские маршруты (`catalog`, `catalog-items`, `access`), не знали новых маршрутов; дополнены. Эти файлы и `database.integration.test.ts` перезапущены: **PASS, 4 файла, 92 теста**. Полный набор на чистом окружении — прогон CI (AC-11)
- Миграция в dev: `migrate:down` → статус «Pending (1): 1790150000000_create-item-compatibility» → `migrate` → заполнение снова — PASS
- `compatibility.integration.test.ts` отдельно — PASS, 16/16

## UAT / E2E
Локальный dev (Docker Compose PostgreSQL, API через `pnpm dev`), запросы к API скриптом (гость, мобильная сессия, два сотрудника двух компаний, администратор с TOTP), после `operator dev:compatibility:seed`:

| Сценарий | Результат |
|---|---|
| Колодки Geely, Atlas II с двигателем JLH-4G20TD | `fits`, `listed: true` |
| Колодки Geely, Atlas I | `does_not_fit`, `listed: false`, `requiresConfirmation: true` |
| Масло (запись требует двигатель), Coolray без двигателя | `needs_details`, `missing: ["engine"]`, `listed: true` |
| Задние колодки без записей (обязательная совместимость), с автомобилем | `not_specified`, `listed: false` |
| То же без автомобиля | `not_specified`, `mark: not_specified`, `listed: true` |
| Копирование Geely → TRW (повтор после заполнения) | `created: 0, alreadyPresent: 1`; TRW и Geely: Atlas II — оба `fits`, Atlas I — оба `does_not_fit` |
| Поставщик «Автомаркет» предлагает запись к задним колодкам | 201 `pending`; результат для Atlas II остался `not_specified`, `listed: false` |
| Очередь модерации | позиция (Geely `4050068800`, «Колодки тормозные задние»), компания, основание |
| Администратор подтверждает | `approved`, `resolution: created`, запись `source: supplier`; результат стал `fits`, `listed: true` |
| Второе предложение отклонено | поставщик видит `rejected`, «Нет подтверждения в каталоге производителя» |
| Мобильная сессия подтверждает предложение | 403 `FORBIDDEN` |
| Поставщик другой компании открывает чужое предложение / свой список | 404 `NOT_FOUND` / `total: 0` |
| Подкатегория «Тормозные колодки» целиком для Atlas I | 3 позиции одним запросом, все `does_not_fit` |

Повторный `dev:compatibility:seed` — `created 0, existing 3`. Экранов нет (TASK-035, EPIC-11), браузерный UAT не применим.

## Acceptance Criteria
- **AC-1 — PASS.** Интеграционные тесты «checks the levels against the vehicle catalog, on the server and in the database» (7 отказов с `reason`/`field`, модель из поколения; в базе — `23514` на чужую модель, `23505` на дубль, `23503` на услугу), «refuses duplicates, services and archived items», «keeps the result of a car whose vehicle rows were archived» (архив модификации, поколения, марки — результат `fits` остался).
- **AC-2 — PASS.** «changes and archives with versions; every change is in the journal of its transaction» (версии 1→2→3, 409 с `currentVersion`, правка без изменений не трогает версию, журнал `created/changed/archived`, отказ не оставляет записи журнала — AC-1-тест проверяет `audit_log` = 0 после отказов); «copies the records of an analog in one action…» (`created: 1, alreadyPresent: 1`, повтор `0/2`, одинаковый результат у аналога, 409 не с аналога, запись журнала с `source: copy`).
- **AC-3 — PASS.** «changes nothing until approved; the supplier sees only its own…», «approves with corrections; equal proposals of two suppliers make one record», «takes proposals for active goods only; limits their number per company» (429 `compatibility_proposals_per_supplier`, `Retry-After`, лимит другой компании отдельный).
- **AC-4 — PASS.** Таблица из 35 случаев «gives every case its result and missing levels» на настоящей базе: четыре результата, недостающие уровни (в том числе минимальный набор и объединение равных), неполный автомобиль, неизвестный год (в том числе годы модификации/поколения), несколько записей, граничные годы (первый, последний, до, после, открытые концы), две марки, чужой кузов и двигатель. Плюс юнит-таблица `compatibility-rules.test.ts` (20).
- **AC-5 — PASS.** «hides what doesn't fit and what isn't specified in a compulsory subcategory, only with a car» и «shows everything of a universal subcategory but what doesn't fit…» — обе категории, с автомобилем и без; `requiresConfirmation` только у `does_not_fit`; юнит-таблица `displayOf` — 12 случаев.
- **AC-6 — PASS.** «computes thousands of items in one statement»: 5 000 позиций × 4 записи = 20 000 записей; счётчик на исполнителе — ровно 1 запрос на расчёт подкатегории. Замер (PostgreSQL 16 в Testcontainers, машина разработки, Windows): 5 прогонов 45,4 / 44,6 / 47,4 / 44,1 / 42,4 мс, медиана **44,6 мс**; через HTTP вся подкатегория (≈5 000 позиций) — **65 мс**, 500 позиций по id — **67 мс**. Порог теста — 2 с (ловит деградацию без ложных падений на CI).
- **AC-7 — PASS.** «answers guests and every session alike; hidden items are not found alike» (гость, мобильная, кабинет, админка — одинаковый ответ; черновик, архив, несуществующая — одинаково в `notFound`; скрытая подкатегория — 404) и «explains a car that doesn't hold together…» (9 причин `COMPATIBILITY_VEHICLE_INVALID`, 400 на оба/ни одного из `itemIds`/`categoryId`).
- **AC-8 — PASS.** «serves the admin routes to the admin context and proposals to the cabinet only»: 8 админских маршрутов — 403 мобильной и кабинету, 401 гостю; 3 маршрута кабинета — 403 мобильной и админке, 401 гостю; ничего не изменилось. Своя компания — отдельные тесты AC-3 (чужое — 404, пустой список). Контракт — `compatibility.test.ts`.
- **AC-9 — PASS.** «fills the examples once and gives the scenarios of the task» (`created 3` → `existing 3`) и dev (`created 0, existing 3` при повторе).
- **AC-10 — PASS (с оговоркой о CI — см. AC-11).** Контракт, OpenAPI, клиент (`@adclub/api-client` строится по `apiRoutes`, новые маршруты доступны без правок) — `openapi:check` PASS, `openapi:compat` — совместимо, трейлер не нужен. Миграция обратима — тест отката в `database.integration.test.ts` и ручной down/up в dev. Таблицы в сверке схемы (`orm-tables.ts`, `schema-drift`). Существующие тесты не ослаблены — только дополнены списки. Перехват вывода — в каждом интеграционном файле, секреты не найдены.
- **AC-11 — CI_RESULT.**
- **AC-12 — PASS.** ARCHITECTURE.md 0.28: 4.25 (I231–I243), 5.3, 14, версия, история; CLAUDE.md, блок 0: модуль, dev-команда, как добавить, предложить, подтвердить и проверить.

## Commits
По D-024, в `main`, файлы добавлялись поимённо:

1. `7222e42` — Update project plan and state, add TASK-015 (Product Owner edits): `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-015.md`.
2. `d637db0` — Add the compatibility contract: `packages/contracts/src/{compatibility.ts, compatibility.test.ts, audit.ts, error.ts, index.ts, login-code.ts, openapi.ts, openapi.test.ts, routes.ts}`, `apps/api/openapi.json`.
3. `7683a9d` — Keep compatibility of items with cars and check it for a car: миграция `infra/migrations/1790150000000_create-item-compatibility.sql`, модуль `apps/api/src/modules/compatibility/*` (13 файлов), подключение (`app.module.ts`, `operator.ts`, `orm-tables.ts`, `testing/database.ts`), экспорт таблиц (`catalog/index.ts`, `identity/index.ts`, `vehicles/index.ts`), настройка (`settings/registry/registry.ts`), `vehicles/dev-vehicle-seed.ts`, дополненные тесты (`database.integration`, `schema-drift`, `catalog.integration`, `catalog-items.integration`, `access.integration`, `registry.test`, `settings.integration`).
4. `03b9797` — Describe compatibility in the architecture and the development guide: `ARCHITECTURE.md`, `CLAUDE.md`.
5. Отчёт — `tasks/TASK-015-REPORT.md` (этот файл, отдельным коммитом; номер прогона CI — в AC-11).

## Errors & Fixes
- **OpenAPI не собирался:** схемы нового модуля не были зарегистрированы в компонентах — сборка компонентов обобщена на модули (`vehicles`, `compatibility`). `transform` в схеме запроса не выражается в JSON Schema — заменён на enum `"true"|"false"`.
- **`no-control-regex`** на проверке основания — заменено на проверку `\p{Cc}` после удаления переводов строк.
- **Матрицы доступа других модулей** (`catalog.integration`, `catalog-items.integration`, `access.integration`) перечисляют все маршруты `/admin…` и сверяют число и список — дополнены маршрутами совместимости (и `recordId`/`proposalId` в подстановках), теперь они проверяют и новые маршруты на отказ гостю, мобильной сессии и кабинету.
- **Первый полный `pnpm test:integration` упал в 14 файлах** из-за окружения: 16 файлов параллельно поднимали контейнеры на машине, где уже работали другие проекты и dev-сервер, — `ECONNRESET` при подключении к PostgreSQL в `beforeAll`, 503 в одном тесте справочника автомобилей. Реальная ошибка среди этих падений одна — `database.integration.test.ts` ждал последней миграцией справочник автомобилей; добавлен тест отката новой миграции. Повторный прогон — с `--maxWorkers=3` и остановленным dev-сервером.

## Deviations
- **В `dev:vehicles:seed` добавлено второе поколение Atlas** — сценарии задачи требуют «Atlas второго поколения», а в заполнении TASK-014 было одно. Существующие проверки заполнения это не затронуло.
- **Dev-заполнение — отдельная команда** `dev:compatibility:seed` (задача допускает), она сама запускает оба заполнения.
- **Копирование — только между аналогами** (связь TASK-011): задача описывает именно этот случай; копирование с произвольной позиции сознательно не сделано (I235).
- **5.3 прежней версии** описывал предложения статусом `proposed` в одной таблице — сделано отдельной таблицей (I231), 5.3 уточнён.

## Known Issues / Risks
- Данные совместимости в dev черновые, как и справочник автомобилей (не выверены по каталогам).
- Годы поколения, изменённые после создания записи, записи не пересматривают (I232): запись с годами вне новых лет поколения не отклоняется задним числом.
- Замер — на машине разработки; на CI и в production абсолютные числа будут другими, порядок — тот же (один запрос, индекс по позиции).
- Список позиций подкатегории в ответе проверки не постраничный: для тысяч позиций ответ большой (5 000 позиций — сотни КБ). Постраничный клиентский каталог — EPIC-10/EPIC-07; расчёт для него готов (`evaluate` с областью).

## Remaining Work
None.

## Future Improvements
- Денормализация совместимости в поисковый индекс (раздел 10, EPIC-15) из того же расчёта.
- Импорт совместимости файлом (вне задачи).
- Постраничная проверка подкатегории с отбором `listed` на стороне базы — когда появится клиентский каталог.

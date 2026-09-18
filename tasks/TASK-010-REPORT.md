# TASK REPORT — TASK-010

## Status
COMPLETED

## Result
У справочника появилась структура, которую ведёт администратор через API без разработчика:

- **Категории двух уровней** (узел → подкатегория) товаров и услуг: код (не меняется при переименовании), названия kk/ru/en (русское обязательно), значок из набора Tabler, порядок внутри родителя, признак «Совместимость обязательна» (только подкатегории товаров, D-029), состояния «активна / скрыта / в архиве», восстановление из архива, перенос подкатегории к другому узлу того же вида. Третий уровень и смешение видов отклоняются сервером **и самой базой** (составной внешний ключ).
- **Характеристики подкатегории** четырёх типов — число (единица, границы, целое/дробное), список (варианты с названиями и порядком), да/нет, текст; «Использовать в фильтрах» (текст не может), «Участвует в полноте», порядок; тип не меняется (сервер и триггер в базе); архивирование и восстановление характеристики и варианта без потери данных.
- **Одновременная правка** не перезаписывает чужое: версия у каждой категории, характеристики, варианта; `CATALOG_VERSION_CONFLICT` (409).
- **Журнал действий:** каждое изменение справочника — запись в `audit_log` в той же транзакции (автор, было/стало).
- **Клиентам** (гость, мобильная сессия, сессия кабинета): дерево активных категорий и описание форм/фильтров категории на языке `Accept-Language` с откатом на русский (`isFallback`); скрытое, архивное и несуществующее — одинаковый 404; ответы кэшируются клиентом и прокси не дольше 60 с (`Cache-Control: public, max-age=60`, `ETag`/304), сервер кэша не держит.
- **Dev-база:** `pnpm --filter api operator dev:catalog:seed` — примерное дерево по PRODUCT 7.2 (7 узлов товаров, 3 узла услуг, характеристики «Моторных масел» и «Тормозных колодок»), повторный запуск ничего не создаёт, вне development/test отказывает.

## Changes
- `infra/migrations/1789740000000_create-catalog-structure.sql` — таблицы `category`, `attribute`, `attribute_option`, `translation` с проверками двух уровней, типов, архивных дат, триггером неизменности типа; `down` удаляет всё.
- `packages/contracts/src/catalog.ts` (новый) — схемы администратора и клиентов, набор значков `categoryIcons`, пределы длины, `CATALOG_CLIENT_CACHE_SECONDS`; `routes.ts` — 2 клиентских и 14 админских маршрутов; `error.ts` — 10 кодов `CATALOG_*`; `audit.ts` — 12 действий и 3 типа сущностей; `openapi.ts`, `index.ts`; тесты `catalog.test.ts`, `openapi.test.ts`.
- `apps/api/src/modules/catalog/` (новый модуль): `schema.ts` (Drizzle), `catalog-texts.ts` (переводы, откат на русский, нормализация), `catalog-errors.ts`, `catalog-admin.service.ts` (все изменения + журнал + версии + блокировка), `catalog-read.service.ts` (клиентское чтение), `catalog-admin.controller.ts`, `catalog.controller.ts` (заголовки кэширования), `dev-catalog-seed.ts`, `catalog.module.ts`, `index.ts`; тесты `catalog.integration.test.ts` (16 сценариев), `catalog-texts.test.ts`.
- `apps/api/src/app.module.ts`, `operator.ts` (`dev:catalog:seed`), `orm-tables.ts`, `testing/database.ts` (`TRUNCATE_ALL`).
- Тесты, перечисляющие состав схемы и маршрутов, дополнены новыми элементами: `database/schema-drift.test.ts` (список таблиц), `database/database.integration.test.ts` (новая миграция в цикле up/down — отдельный шаг отката), `identity/access.integration.test.ts` (полный список маршрутов `/admin`).
- `packages/api-client/src/create-api-client.test.ts` — вызов каталога гостем с языком и PATCH категории администратором (клиент строится по `apiRoutes`, код клиента не менялся).
- `apps/mobile/src/design-system/category-icons.test.ts` — каждое имя `categoryIcons` существует в `@tabler/icons-react-native`.
- `apps/api/openapi.json` — перегенерирован.
- `ARCHITECTURE.md` 0.18 — раздел 4.15 (I141–I150), уточнены 5.2 и 5.4, история; `CLAUDE.md` блок 0 — модуль, заполнение dev-базы и просмотр через API.

## Technical Decisions
Все внесены в ARCHITECTURE.md 4.15:
- **I143 — названия сразу в общей таблице `translation` (5.4)**, а не в колонках: `origin` `source`/`manual` (`ai` зарезервирован для TASK-012), `is_manually_edited = true` у всего введённого администратором, `source_hash` русского текста у переводов — TASK-012 добавит автоперевод и поля аддитивно, без переноса данных.
- **I142 — два уровня держит база:** `level`/`parent_level` + FK `(parent_id, kind, parent_level) → (id, kind, level)`; характеристика — только у подкатегории (FK на `(id, level=2)`), вариант — только у списка (FK на `(id, value_type='enum')`), тип и категория характеристики неизменны (триггер).
- **I145 — одна транзакционная advisory-блокировка** на все изменения структуры: межстрочные проверки (уровни, соседи, полный список порядка) не гоняются.
- **I144 — уникальность названий среди соседей** на сервере без учёта регистра по каждому языку; архивные соседи не учитываются, имя перепроверяется при восстановлении и переносе.
- **I146 — версии строк** и `CATALOG_VERSION_CONFLICT`; порядок — отдельный `PUT …/order` с полным списком соседей (`CATALOG_ORDER_MISMATCH`).
- **I148 — без каскада статусов:** видимость подкатегории = её статус и статус узла; под архивным узлом подкатегорию нельзя активировать, создать или перенести.
- **I149 — клиентские маршруты публичны, свежесть ≤ 60 с** за счёт `Cache-Control: public, max-age=60` + `Vary: Accept-Language` + `ETag`; сервер читает базу на каждый запрос. Список без активных вариантов клиенту не описывается. Некорректный id — тот же 404.
- **I150 — набор из 42 значков Tabler в контракте**; наличие в пакете проверяет тест мобильного.
- Тип `range` из черновика 5.2 не реализован: «диапазон» — это фильтр по числу (M-CAT-03), отдельный тип значения не нужен; при необходимости добавляется аддитивно.

## Verification
- `pnpm format:check` — PASS — «All matched files use Prettier code style!»
- `pnpm lint` — PASS — 12/12 задач, 0 ошибок и предупреждений
- `pnpm typecheck` — PASS — 18/18
- `pnpm test` — PASS — 15/15 задач; api 366, contracts 77, mobile 68, api-client 25 и др.
- `pnpm test:integration` локально — PASS для кода задачи: `catalog.integration.test.ts` 16/16; первый полный прогон — 12 падений, из них 11 в тесте цикла миграций (исправлено) и 1 нестабильный тест очистки (прошёл при повторе). Второй полный прогон — 219/221: `login-code.integration.test.ts` (2 теста окон Redis) и один тест расписания `jobs.integration.test.ts` падают **и на исходном коммите без изменений задачи** (проверено через `git stash`): часы Docker-VM на этой машине убежали на ~8 с вперёд хоста (`date -u` хоста 09:07:37, контейнера 09:07:45). В CI (Linux) полный интеграционный набор зелёный — прогон #60.
- CI на `main` — FAIL #59, затем PASS #60 и следующий (см. «Коммиты и CI»)
- `pnpm build` — PASS — 11/11 (включая `expo export` мобильного)
- `pnpm --filter @adclub/api openapi:check` — PASS — «openapi.json matches the contract and the served routes»
- `pnpm --filter @adclub/api openapi:compat --base HEAD` — PASS — «Contract is backward compatible with HEAD» (трейлер не нужен)
- `pnpm brand:assets --check` — PASS
- Миграция на dev-базе: `migrate` → `migrate:down` → `migrate` — PASS; в тесте цикла миграций — отдельный шаг отката новой миграции.
- CI на `main` — см. раздел «Коммиты и CI».

## UAT / E2E
Пройдено в dev (локальный Docker Compose PostgreSQL/Redis, `pnpm --filter api dev` на `:3000`) запросами к API, скриптом на `fetch` (вход администратора с настоящим вторым фактором через `/dev/login-codes` и TOTP; скрипт в репозиторий не входит):
1. `dev:catalog:seed` → `{"created":{"categories":37,"attributes":4,"options":10}}`; повторно → `created` нули, `existing` те же. Гость `GET /catalog/categories` на ru и kk — 200, `Cache-Control: public, max-age=60`, узлы в заданном порядке со значками: «0. Двигатель [engine] … 6. Расходники [droplet]», услуги «Техобслуживание [tool], Диагностика [gauge], Шиномонтаж [wheel]»; на kk — «Қозғалтқыш, Тежегіштер, Аспа…».
2. Администратор добавил «Тип масла» (список: синтетика, полусинтетика, минеральное, фильтр) → 201; описание фильтров «Моторных масел» гостю сразу: «Вязкость*, Допуск*, Объём*, Тип масла* (Синтетика/Полусинтетика/Минеральное)».
3. Архив «Допуска» → 200, в описании его нет; восстановление → 200, снова есть.
4. Подкатегория у «Тормозных колодок» → 400 `CATALOG_DEPTH_EXCEEDED`.
5. Скрыт «Салон» → гость не видит ни «Салон», ни «Коврики», ни «Чехлы»; прямой запрос «Ковриков» → 404 `NOT_FOUND`. (После сценария «Салон» возвращён в активные, чтобы сценарий можно было повторить.)
6. Журнал `GET /admin/audit-log?actorRole=admin`: `catalog_attribute.created`, два `catalog_attribute.status_changed`, `catalog_category.status_changed` — автор `admin +7***4567`.
7. Мобильная сессия `POST /admin/catalog/categories` → 403 `FORBIDDEN`.

Экранов нет (не входят в задачу); браузерные сценарии не проходились.

## Acceptance Criteria
- **AC-1 — PASS** — `catalog.integration.test.ts` «two levels»: API отвечает `CATALOG_DEPTH_EXCEEDED`, `CATALOG_KIND_MISMATCH`, `CATALOG_LEVEL_IMMUTABLE`, `CATALOG_NOT_SUBCATEGORY`; прямые `INSERT`/`UPDATE` в базу (подкатегория у подкатегории, другой вид, узел с детьми в подкатегорию, смена вида, характеристика у узла, вариант у не-списка, смена типа, текст-фильтр, совместимость у узла) отклоняются; число строк не меняется.
- **AC-2 — PASS** — тесты «creates, renames, moves, orders, hides, archives and restores…», «checks names, icons, codes and the compatibility flag», «keeps subcategories of an archived node out of the way…»: kk/ru/en с `origin`, русское обязательно, 40/41 символ, управляющие символы, неизвестный значок, занятый код, «тормозные КОЛОДКИ» → `CATALOG_NAME_TAKEN` с `lang`, одинаковое имя в другом узле — 201, перенос в конец нового узла, порядок и `CATALOG_ORDER_MISMATCH`, скрытие/архив/восстановление, маршрутов DELETE нет.
- **AC-3 — PASS** — тесты «has four types…», «archives and restores an attribute and an option without losing anything»: число с единицей и границами, список, да/нет, текст; `min > max`, дробные границы у целого, единица у не-числа, текст-фильтр → 400; смена типа → `CATALOG_ATTRIBUTE_TYPE_IMMUTABLE`; единица и границы меняются; архив и восстановление характеристики и варианта — число строк `attribute`/`attribute_option`/`translation` не меняется.
- **AC-4 — PASS** — тест «records every change with its author…»: 13 действий справочника в журнале по порядку, `before`/`after`, актор `admin` с маской номера; отказ — ни строки, ни записи журнала. Тест «never overwrites someone else's change silently»: два параллельных PATCH с одной версией → 200 и 409 `CATALOG_VERSION_CONFLICT` (`currentVersion: 2`), в базе текст победителя, одна запись журнала; то же для статуса, характеристики и варианта.
- **AC-5 — PASS** — тесты раздела «clients»: гость, мобильная сессия, сессия кабинета и админки получают одинаковое дерево; kk с `isFallback: true` для узла без казахского названия; `de, fr` → ru; скрытый узел, его подкатегория, архивная подкатегория, случайный UUID и `not-a-uuid` — одинаковый 404; архивная характеристика, список без активных вариантов, архивный вариант в описание не попадают.
- **AC-6 — PASS** — тест «shows a change of the administrator at once…»: `Cache-Control: public, max-age=60` (≤ 60), `Vary: Accept-Language`, `ETag`; условный запрос до изменения → 304, сразу после добавления характеристики → 200 с новой характеристикой. Время (≤ 60 с) описано в ARCHITECTURE 4.15 I149.
- **AC-7 — PASS** — тест «serves the admin routes to an admin session only…»: все 14 маршрутов `/admin/catalog` объявлены с `contexts: ["admin"]`; гость → 401 `AUTH_REQUIRED`, мобильная и кабинетная сессии → 403 `FORBIDDEN`, ничего не записано; клиентские маршруты без `auth`. Полный список маршрутов `/admin` в `access.integration.test.ts` обновлён.
- **AC-8 — PASS** — тест «fills the example tree once…»: первый запуск — 37 категорий, 4 характеристики, 10 вариантов; второй — ноль созданных, число строк всех таблиц прежнее; при `nodeEnv = staging` — отказ. В dev — серверной командой (см. UAT).
- **AC-9 — PASS** — `openapi:check` и `openapi:compat --base HEAD` зелёные без трейлера; все изменения контракта — новые маршруты, схемы, коды ошибок и действия журнала; миграция обратима (dev и тест цикла миграций); таблицы добавлены в `orm-tables.ts`, сверка схемы проходит в интеграционных тестах.
- **AC-10 — PASS** — существующие тесты не ослаблялись (дополнены только перечни состава: таблицы, миграции, маршруты `/admin`); перехват вывода интеграционных тестов проверяется для каждого файла, включая новый (токены, секреты TOTP, коды); коммиты по D-024 — ниже; CI — ниже.
- **AC-11 — PASS** — ARCHITECTURE.md 0.18: 4.15 (I141–I150), 5.2, 5.4, история; CLAUDE.md блок 0 — модуль, `dev:catalog:seed`, просмотр через API, список проверок интеграционных тестов.

## Errors & Fixes
- Первый полный интеграционный прогон: 11 падений в `database.integration.test.ts` — тест цикла миграций перечисляет миграции поимённо и откатывает по одной; добавлен шаг «rolls back the latest migration only (the catalog structure)» и новая миграция в список. `schema-drift.test.ts` (юнит) перечисляет таблицы — дополнен.
- В том же прогоне один раз упал `sign-in-data-cleanup.integration.test.ts` («Cleanup identity.cleanup-login-codes did not complete: gone»); при отдельном запуске и в следующем полном прогоне — зелёный. Код очистки не менялся; похоже на нестабильность под нагрузкой параллельного прогона — см. Known Issues.
- **CI #59 (коммит `7169a78`) — failure:** (1) `catalog.integration.test.ts` «hides hidden and archived categories…» — `read ECONNRESET`: несколько одновременных запросов supertest к неслушающему серверу (supertest открывает временный сервер на каждый запрос). Исправлено коммитом `7c46ed4`: приложение теста слушает реальный порт (`listen(0)`), запросы на 404 идут последовательно; одновременные PATCH в тесте конкурентной правки сохранены. (2) `jobs.integration.test.ts` «runs each scheduled occurrence once with two workers» — тест расписания, кодом задачи не затрагивается; в CI #60 прошёл. Возможная нестабильность — в Known Issues.
- Python на Windows записал правки документов и двух тестов с CRLF — возвращено к LF до коммита.
- Тест клиента API повторно использовал один объект `Response` для двух запросов — исправлен тест.

## Deviations
- Тип значения `range` из ARCHITECTURE 5.2 (черновик) не реализован: TASK-010 и SCREENS A-CAT-02 называют четыре типа (число / список / да-нет / текст); «диапазон» в M-CAT-03 — фильтр по числу. Отражено в 5.2.
- Описание фильтров не включает характеристику-список без активных вариантов (иначе клиент получил бы пустой фильтр). В задаче этот случай указан как edge case без предписанного поведения — решение описано в I149.
- Восстановление подкатегории, чей узел в архиве, отклоняется (`CATALOG_PARENT_ARCHIVED`), а не выполняется «в невидимое»; решение — I148.

## Known Issues / Risks
- **`pnpm dev` из корня не стартует:** Turborepo отвечает «You have 10 persistent tasks but `turbo` is configured for concurrency of 10». Возникло не из-за этой задачи (новых пакетов и `dev`-скриптов нет); API в dev запускался как `pnpm --filter api dev`. Нужно `concurrency` в `turbo.json` или `--concurrency` в скрипте — вне scope, в Future Improvements. CLAUDE.md не менял в этой части.
- Возможная нестабильность тестов со временем, не относящихся к справочнику: `sign-in-data-cleanup.integration.test.ts` (локально один раз), `jobs.integration.test.ts` «runs each scheduled occurrence once with two workers» (CI #59, в #60 прошёл). Требует отдельного наблюдения.
- На машине разработки часы Docker Desktop VM расходятся с хостом (~8 с): тесты окон лимитов в `login-code.integration.test.ts` локально падают и без изменений задачи; лечится синхронизацией времени VM (например, перезапуском Docker Desktop).
- **Казахские названия примерного дерева** (`apps/api/src/modules/catalog/dev-catalog-seed.ts`) — черновик, **требуют проверки носителем языка** (например, «Шанақ» для «Кузов», «Иінтіректер» для «Рычаги», «Тұрақтандырғыш тіректері», «Техникалық қызмет», «Шина жөндеу»). Это данные только для development и тестов.
- Уникальность названий среди соседей проверяется сервером под блокировкой, но не ограничением базы (названия — в общей таблице переводов). Прямая запись в базу в обход сервера может создать дубль.
- Клиентские ответы кэшируются до 60 с: сразу после правки администратора клиент с кэшем может до минуты видеть прежнее (заявлено и описано).
- Все изменения структуры сериализованы одной блокировкой — сознательно; при массовом импорте (EPIC позже) может понадобиться пересмотр.

## Remaining Work
None.

## Future Improvements
- Исправить `pnpm dev` (параметр `concurrency` Turborepo).
- Проверка носителем казахских названий; когда появится TASK-012 — автоперевод пустых kk/en и сигнал «исходник изменён» по `source_hash`.
- Экраны A-CAT-01/02 (TASK-035) смогут использовать `visibleToClients`, `names[*].origin` и `version` из админских ответов без изменений API.
- При росте справочника — серверный кэш клиентского дерева с инвалидацией по изменению (сейчас не нужен: один запрос к двум таблицам).

## Коммиты и CI
Все в `main`, запушены. Состав — явно перечисленные файлы (D-024).

1. `8f8ca1f` Update project plan and state, add TASK-010 (Product Owner edits) — `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-010.md` (правки Product Owner, отдельным коммитом).
2. `282292e` Add the catalog structure contract: categories, attributes, options — `packages/contracts/src/{catalog.ts, catalog.test.ts, routes.ts, error.ts, audit.ts, openapi.ts, openapi.test.ts, index.ts}`, `packages/api-client/src/create-api-client.test.ts`, `apps/mobile/src/design-system/category-icons.test.ts`.
3. `e90013f` Add catalog categories and attributes kept by the administrator — `infra/migrations/1789740000000_create-catalog-structure.sql`, `apps/api/src/modules/catalog/*` (13 файлов), `apps/api/src/{app.module.ts, operator.ts, orm-tables.ts, testing/database.ts}`, `apps/api/src/database/{schema-drift.test.ts, database.integration.test.ts}`, `apps/api/src/modules/identity/access.integration.test.ts`, `apps/api/openapi.json`.
4. `7169a78` Document the catalog structure decisions (ARCHITECTURE 0.18, 4.15) — `ARCHITECTURE.md`, `CLAUDE.md`.
5. `7c46ed4` Serve the catalog integration test on a real port — `apps/api/src/modules/catalog/catalog.integration.test.ts`.
6. Коммит с этим отчётом — `tasks/TASK-010-REPORT.md`.

CI (GitHub Actions, workflow «CI», `gh run view`):
- #59 — `7169a78` — **failure** (см. Errors & Fixes);
- #60 — `7c46ed4` — **success**;
- коммит с отчётом — номер и статус приведены в ответе сессии (отчёт не может содержать результат прогона, запущенного его собственным коммитом).

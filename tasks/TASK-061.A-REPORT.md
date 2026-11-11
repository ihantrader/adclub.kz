# TASK REPORT — TASK-061.A

## Status
COMPLETED

## Result
Регламенты ТО доведены по приёмке. Перенос модели к другой марке и поколения к другой модели в «Автомобилях» больше не падает 500: регламенты (действующие, черновые, архивные) переезжают вместе с уровнем, каждому пишется `maintenance_plan.changed` «было → стало» со словами «Справочник автомобилей: модель перенесена к другой марке». Правило элемента, которое больше не ведёт в справочник (характеристика в архиве или не «в фильтрах», вариант в архиве, подкатегория скрыта, позиция в архиве), в публичном `GET /maintenance/plan` даёт `catalog: {unavailable: true, count: 0, filters: [], categoryId: null}` — выдача больше не расширяется до всей подкатегории; админка («Проверить на автомобиле») пишет «правило не действует · в продаже 0». Такой элемент правится (интервал, коды, название), а диалог при открытии убирает несуществующие условия и говорит об этом. Возраст без года считается по самому молодому автомобилю поколения и в полных месяцах. В «от/до» набираются дроби и минус. Зависший черновик ИИ не виден и не считается, ИИ-черновик укладывается в 60 с на обе модели, в плане не больше 100 элементов, последний элемент действующего плана не убирается, неактивный город — всегда 400, позиции правила в журнале названы по имени.

## Changes
- `infra/migrations/1792150000000_maintenance-plan-follows-vehicles.sql` — составные ключи плана `DEFERRABLE INITIALLY DEFERRED`, триггеры `maintenance_plan_follow_model` / `_follow_generation` (уровни и `version`), откат.
- `apps/api/src/modules/vehicles/vehicle-moves.ts` — реестр `VehicleMoves`; `vehicle-hierarchy.service.ts` зовёт его при переносе модели и поколения; `vehicles.module.ts`, `index.ts`.
- `apps/api/src/modules/maintenance/maintenance-vehicle-moves.ts` — журнал планов, переехавших за справочником; `maintenance.module.ts` получает `vehicles`; `app.module.ts`, `operator.ts`.
- `maintenance-targets.ts` — `targetProblems` (одна функция «правило ведёт в справочник»); `maintenance-answers.service.ts` — `UNAVAILABLE`, город первым, возраст через `maintenanceAgeMonths`.
- `maintenance-plans.service.ts` — правило проверяется только при смене, предел 100 элементов, последний элемент действующего плана, зависший черновик (`generatingNow`, `notStaleGenerationWhere` в `maintenance-scope.ts`), архив снимает `generating_since`; `maintenance-views.ts`; `maintenance-errors.ts` (`lastElement`, `itemsLimit`).
- `maintenance-draft.service.ts` — `MAINTENANCE_DRAFT_DEADLINE_MS`, обрезка до 100 элементов, отказ записи в план, заархивированный во время вызова.
- `apps/api/src/modules/ai/ai.service.ts` — `AiCallMeta.deadlineMs` (общий предел вызова на все модели).
- `apps/api/src/modules/audit/audit-names.ts` — `NESTED_REFERENCE_FIELDS` (`itemIds` правила — позиции справочника).
- `packages/contracts/src/maintenance.ts` — `MaintenanceCatalog.unavailable`, `maintenancePlanStateDetailsSchema`; `error.ts` — описание `MAINTENANCE_PLAN_STATE`; `apps/api/openapi.json` перегенерирован.
- `packages/domain/src/maintenance/maintenance-plan.ts` — `ageMonthsFromYear` в полных месяцах, `maintenanceAgeMonths`.
- Админка: `AttributeConditions.tsx` (`NumberCondition` — текст поля, разбор при уходе или Enter), `ItemDialog.tsx` (убранные условия словами), `PlanCard.tsx` («правило не действует»), `maintenance-words.ts` (`conditionNumberOf`, `conditionText`, `currentConditions`, тексты отказов), `audit-words.ts` (`followed`).
- Тесты: `maintenance.integration.test.ts` (+4 сценария), `database.integration.test.ts` (миграция переноса и её откат), `maintenance-plan.test.ts`, `maintenance-words.test.ts`, `audit-words.test.ts`, `audit-names.test.ts`; `expected/migrations.ts`.
- Документы: ARCHITECTURE 0.98 (4.84 I946–I954, правки I935, I938, I941, I945), CLAUDE.md «Регламенты ТО в dev».

## Technical Decisions
Внесены в ARCHITECTURE.md 0.98, раздел 4.84:
- I946 — вариант «а»: план следует за справочником (отложенные ключи + триггеры, как у совместимости I221; журнал — модуль регламентов через реестр `VehicleMoves`). Столкновение «один действующий на область» при переносе невозможно — ключ области содержит перенесённый id, и все его планы переезжают вместе; последняя линия — уникальный индекс. Двигатель родителя не имеет; архив уровня id не меняет.
- I947 — одна функция валидности правила (`targetProblems`) для админки и публичного ответа, новый признак `catalog.unavailable`.
- I948 — правило проверяется только при смене; диалог убирает устаревшие условия словами.
- I949 — возраст без года: самый молодой автомобиль поколения (`yearTo`, иначе текущий год); полные месяцы.
- I950 — «от/до» хранит текст, число читается при уходе из поля.
- I951 — зависший черновик через условие по времени, без фоновой задачи (модуль регламентов не входит в worker).
- I952 — `deadlineMs` в `AiService`: 60 с на обе модели черновика.
- I953 — предел 100 элементов (409 `MAINTENANCE_PLAN_STATE {reason: items_limit}`).
- I954 — последний элемент действующего плана — 409 `{reason: last_active_element}` (выбран отказ, а не перевод плана в черновик: снятие плана с витрины — отдельное явное действие «В архив»); город проверяется первым; имена `itemIds` правила в журнале.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS (0 ошибок; одно прежнее предупреждение `isNotNull` в `ratings/supplier-ratings.service.ts`, не из этой задачи)
- `pnpm typecheck` — PASS
- `pnpm test` — PASS (19/19 задач Turborepo; api 73 файла, domain 42, admin-web 20, …)
- `pnpm build` — PASS (12/12)
- `pnpm --filter @adclub/api openapi:check` — PASS («matches the contract and the served routes»)
- `pnpm --filter @adclub/api openapi:compat --snapshots` — PASS («Compatible with every supported app version: 1.0.0»)
- `vitest.integration` `maintenance.integration.test.ts` — PASS (12 тестов, из них 4 новых)
- `vitest.integration` `database.integration.test.ts` + `vehicles.integration.test.ts` — PASS (85 тестов, включая новый тест миграции и её отката)
- CI — не ожидался (CLAUDE.md 11); прогон: 43002494489 (https://github.com/ihantrader/adclub.kz/actions/runs/43002494489), запущен на 

## UAT / E2E
Пройдено в встроенном браузере (админка `admin-web` + `api-test-ai` на dev-контейнерах 5433/9002 — временная правка `env` в `.claude/launch.json`, возвращена), вход своим тестовым номером `+77010000900` (после `admin:reset-totp` этого номера):
1. **Перенос модели с регламентом.** Создана модель Geely «Тест 061A» и план на неё; в «Автомобилях» → «Тест 061A» → «Изменить» → марка Chery → «Сохранить»: `PATCH /admin/vehicles/models/…` — 200, крошки «Марки › Chery». План в базе: `make = chery`, `version 2`; «История плана»: «Изменён регламент ТО · Область: изменено значений: 1 · Справочник автомобилей: — → модель перенесена к другой марке».
2. **Архив характеристики правила.** «Вязкость» (Моторные масла) — в архив через `POST /admin/catalog/attributes/…/status`. `curl GET /maintenance/plan` (Geely Coolray, JLH-3G15TD, 2024, 10 000 км, Алматы): «Моторное масло» было `{"unavailable":false,"count":1,"minPrice":9700,…}` → стало `{"unavailable":true,"count":0,"minPrice":null,"categoryId":null,"filters":[],"itemIds":[]}`. Карточка плана «Geely Coolray, 1.5T»: у элемента «условие по характеристике больше не действует»; «Проверить на автомобиле» (Geely → Coolray → JLH-3G15TD, 10 000 км) — «Моторное масло · условие по характеристике больше не действует · правило не действует · в продаже 0».
3. **Правка интервала у такого элемента.** «Действия: Моторное масло» → «Изменить…»: в диалоге «Условие «Вязкость» больше не действует — убрано · Сохраните элемент, чтобы правило стало таким»; «Каждые, км» 15 000 → «Сохранить» — `PATCH /admin/maintenance/items/…` 200, в базе `interval_km 15000`, условие «Вязкость» убрано.
4. **«4,5» в условии объёма.** В «Объём, л: от» с клавиатуры набрано «4,5» — поле держит «4,5», после ухода из поля тоже; сохранено как `{"min": 4.5}`. В «до» набрано «-1,5» — держится; «абв» → «Не число — условие не задано»; очищено перед сохранением.
После прохода dev-данные возвращены: «Вязкость» снова активна, элементу — прежнее правило и 10 000 км (проблем нет), тестовые план и модель — в архиве (лишний план на всю марку Geely, созданный по ошибке скрипта, — тоже в архиве).

## Acceptance Criteria
- AC-1 — PASS — перенос модели и поколения: `PATCH /admin/vehicles/models|generations` 200, планы трёх статусов переехали (интеграционный тест «a plan follows a moved model or generation, active, draft or archived, with its journal»; тест миграции в `database.integration.test.ts`); в браузере — перенос «Тест 061A» Geely → Chery, «История плана» со словами; решение — ARCHITECTURE I946.
- AC-2 — PASS — `targetProblems` — одна функция для карточки, «Проверить», активации и публичного ответа; тест «a rule that no longer leads to the catalog sells nothing…»: снят «в фильтрах», архив «Вязкости», архив варианта, скрытая подкатегория → `{unavailable: true, count: 0, filters: []}`, админка `attribute_unavailable` / `category_unavailable`; curl в dev — то же.
- AC-3 — PASS — сервер: смена интервала со старым правилом при архивной характеристике и при скрытой подкатегории — 200, новое невалидное правило — 400 `MAINTENANCE_TARGET_INVALID` (интеграционный тест); слова: `currentConditions` (`maintenance-words.test.ts`); в браузере диалог показал «Условие «Вязкость» больше не действует — убрано».
- AC-4 — PASS — `maintenance-plan.test.ts`: таблица `ageMonthsFromYear` (полные месяцы) и `maintenanceAgeMonths` (год, без года — `yearTo`, выпускается — 0, ничего — `null`).
- AC-5 — PASS — `conditionNumberOf`/`conditionText` (`maintenance-words.test.ts`: «4,5», «4.5», «4,5 л», «-1», «−1,5», «4,», «-», «4,5,6»); в браузере набрано «4,5» и «-1,5», сохранено `min: 4.5`.
- AC-6 — PASS — зависший черновик: интеграционный тест «a draft AI never finished…»; предел времени: `AiCallMeta.deadlineMs` — тест не написан (тестовый ИИ отвечает мгновенно, а режим `slow` даёт задержку на попытку; проверено чтением кода и typecheck) — записано здесь; 100 элементов и последний элемент — тест «the last element of an active plan stays…»; имена `itemIds` правила — `audit-names.test.ts`; город до разбора плана — тот же интеграционный тест (марка без плана и с планом — 400); пустой действующий план — отказ 409 `last_active_element`.
- AC-7 — PASS — раздел «UAT / E2E»: все четыре шага пройдены в браузере.
- AC-8 — PASS — раздел «Verification».
- AC-9 — PASS — отчёт с идентификатором прогона CI.

## Errors & Fixes
- Ожидание в новом тесте миграции (версия 4 после переноса другой модели) — неверно: перенос модели без планов план не трогает, версия 3; тест исправлен.
- ` ` в тексте инструмента Edit попал в файл буквальным символом (`no-irregular-whitespace`) — заменён скриптом на экранирование.
- Однострочник `node -e "…"` с обратными кавычками испортил комментарий в `maintenance-plan.ts` (подстановка bash) — исправлено; дальше правки только Edit и скриптами в файлах.

## Deviations
- Вместо свипера для зависшего черновика — условие по времени (I951): модуль регламентов не входит в worker, а результат тот же (не виден, не считается, архивируется, удаляется следующим черновиком области). Открытый по прямой ссылке такой черновик правится как обычный.
- Публичный ответ при недоступном правиле отдаёт `categoryId: null` (задача требовала только убрать `filters`): открывать нечего, и скрытая подкатегория была бы 404.

## Known Issues / Risks
- Составные ключи плана теперь отложенные: плохая вставка в обход сервера отказывается в конце транзакции, а не на операторе (сервер проверяет область сам — `resolveScope`).
- Процессу без модуля регламентов (worker) реестр `VehicleMoves` пуст: план всё равно переедет триггером, но записи журнала не будет. Переносы делает только админка (API), импорт файлом модели и поколения не переносит.
- Существующий план, у которого больше 100 не архивных элементов (если такой есть в данных), не меняется — только новое сверх предела отказывается.

## Remaining Work
None.

## Future Improvements
- Показать в карточке поколения/модели «Автомобилей», что у неё есть регламенты (число и ссылка).

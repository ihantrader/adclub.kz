# TASK REPORT — TASK-011.A

## Status
COMPLETED

## Result
- **Совпадение товаров больше не блокирует работу.** Проверка «такой товар уже есть» выполняется только при изменении идентичности (создание; смена бренда или категории; запись значения характеристики «участвует в полноте»). Правка прочих значений, названия и состояния позиции, уже совпадающей с другой, проходит. В дозаполнении ячейка вне идентичности не отклоняется из-за такого совпадения. Изменение идентичности в совпадение с другим товаром по-прежнему отклоняется (409 `CATALOG_ITEM_DUPLICATE` / отказ ячейки `duplicate_item`).
- **Администратор видит пары.** Все ответы характеристики (`AdminAttributeResponse`: создание, изменение, архив/восстановление, порядок вариантов) несут `sameProductItems` — число товаров категории, совпадающих с другим. В списке позиций появился отбор `GET /admin/catalog/items?sameProduct=matching` (вместе с остальными отборами и постранично).
- **Нарушение уникального ключа — всегда 409.** Если написание бренда или артикул отклонены уникальным ключом, а занявшей его строки уже нет, транзакция повторяется один раз. Повторный такой отказ — 409 `CONFLICT` (`retryable: true`), не 500.
- **Расписания фоновых задач больше не переключаются обратно.** Каждый проход синхронизации берёт общую транзакционную блокировку PostgreSQL, читает настройки из базы после её получения (не из кэша процесса) и записывает расписания до её снятия. Worker с устаревшим кэшем больше не возвращает прежнее время.
- `catalog-values.test.ts` теперь хранится как текст.
- Для проверки в dev добавлена задача `dev.daily-at-setting` (только development/test): ежедневно в час настройки `billing_notify_hour`, ничего не делает.

## Changes
- `apps/api/src/jobs/job-runner.service.ts` — `syncSchedulesWith`: транзакция, `pg_advisory_xact_lock(hashtext('job_schedule_sync'))`, `JobSettingsReader.fresh()`, запись расписаний (`writeSchedules`) под блокировкой.
- `apps/api/src/jobs/job-settings.ts`, `apps/api/src/modules/settings/app-settings.ts` — `JobSettingsReader.fresh()` / `AppSettings.fresh()`: значения по запросу, начатому после вызова (кэш заодно обновляется). Метод `get` из `JobSettingsReader` убран, других пользователей у него не было.
- `apps/api/src/jobs/dev-jobs.ts`, `jobs/index.ts` — dev-задача `dev.daily-at-setting`.
- `apps/api/src/modules/catalog/same-products.ts` (новый) — SQL множества совпадающих товаров (подпись `jsonb_object_agg` по идентифицирующим значениям) и счётчик по категории.
- `catalog-items.service.ts` — `identifies()`; проверка совпадения в `setValues` и `fill` только при изменении идентифицирующего значения; отбор `sameProduct`; `guardArticle` с повтором и `uniqueRace()`.
- `catalog-brands.service.ts` — `guardSpellings` с повтором и `uniqueRace()`; `catalog-errors.ts` — `uniqueRace()` (409 `CONFLICT`, retryable); `catalog-paging.ts` — `UNIQUE_RACE_ATTEMPTS = 2`.
- `catalog-admin.service.ts`, `catalog-admin.controller.ts` — `sameProductItems` в ответе характеристики.
- `packages/contracts/src/catalog-items.ts` (`sameProduct` в `catalogItemListQuerySchema`), `catalog.ts` (`sameProductItems` в `adminAttributeResponseSchema`), `error.ts` (описание `CONFLICT` для справочника); `apps/api/openapi.json` перегенерирован.
- Тесты: `jobs.integration.test.ts` (новый тест гонки; у `start` появился параметр `settingsMaxAgeMs`), `catalog-items.integration.test.ts` (два новых `describe`, 4 теста), `sign-in-data-cleanup.integration.test.ts` (в перечни расписаний и задач добавлена dev-задача).
- `catalog-values.test.ts`, `tasks/TASK-009.A-REPORT.md` — сырой NUL заменён escape-последовательностью.
- `ARCHITECTURE.md` 0.21 — раздел 4.18 (I169–I172), уточнены I116, I158–I160.

## Technical Decisions
Все внесены в ARCHITECTURE.md 0.21, раздел 4.18:
- **I169.** Совпадение не считается дублем, пока не изменена идентичность. Изменение структуры не отклоняется, а сообщает число пар (`sameProductItems`). Архивирование варианта списка на совпадения не влияет (значения хранятся тем же id), поэтому его ответ счётчика не несёт. Отбор `sameProduct=matching` использует то же правило, что проверка при изменении; число сравнивается по значению (`4` = `4.000`, это проверено тестом).
- **I170.** Нарушение ключа, когда соперника уже нет: один повтор всей транзакции, затем 409 `CONFLICT` (retryable). Выбран существующий общий код, а не новый: деталям `CATALOG_BRAND_SPELLING_TAKEN`/`CATALOG_ITEM_DUPLICATE` обязательно нужна ссылка на соперника, а её здесь нет.
- **I171.** Синхронизация расписаний — одна за раз по всем worker'ам (транзакционная advisory-блокировка), чтение настроек после получения блокировки. Одного свежего чтения без блокировки мало: остаётся окно «прочитал старое → другой записал новое → я записал старое».
- **I172.** Исходники и документы не содержат сырых управляющих байтов.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS (12/12 задач)
- `pnpm typecheck` — PASS (18/18)
- `pnpm test` — PASS (15/15 задач; `apps/api` 33 файла). Предупреждение `ReadinessService … 10.0.0.5:5432` было и до изменений: один из unit-тестов намеренно проверяет недоступную базу.
- `pnpm test:integration` — PASS, 12/12 файлов (финальный прогон после всех изменений)
- `pnpm --filter @adclub/api openapi:check` — PASS
- `pnpm --filter @adclub/api openapi:compat --base HEAD` (до коммитов) — PASS: «Contract is backward compatible», трейлер не нужен
- Тест гонки расписания на **прежнем** коде (исправление убрано через `git stash`) — FAIL, как и должно быть: `expected '0 6 * * *' to be '0 7 * * *'` в строке `expect(await cronNow()).toBe(dailyAt(after))` после прохода worker'а с устаревшим кэшем. На новом коде — PASS.
- Новые тесты каталога на **прежнем** коде сервисов (подставлены версии `HEAD` трёх сервисных файлов) — 3 из 4 FAIL: «reports the pairs…» (нет `sameProductItems`), оба теста «…never 500» (`{"code":"INTERNAL_ERROR"…}: expected 500 to be 201`). Тест с настоящим откатом соперника проходит и на прежнем коде: PostgreSQL сам пропускает вторую вставку после отката соперника (I170). На новом коде — 4/4 PASS.
- `jobs.integration.test.ts` целиком на новом коде — PASS, 22/22
- Тест TASK-008 «reads the Almaty time from the setting at every sync, without a restart» — **10/10 прогонов PASS** (каждый прогон — с зависимым тестом «makes up a periodic run…», который запускает двух worker'ов, и новым тестом гонки: `Tests 3 passed` в каждом из 10). Проверка «nothing flips back» не менялась.
- Файл `catalog-values.test.ts` как текст: `git diff --numstat <пустое дерево> HEAD -- apps/api/src/modules/catalog/catalog-values.test.ts` → `171 0` (раньше `- -`, то есть двоичный); `git grep 'a b' HEAD -- …` находит строку 105. Коммит `b8a0e4f` ещё показан как `Bin 6651 -> 6656`, потому что старая версия двоичная. Все следующие изменения файла будут видны текстом.
- CI на `main`: `44123cc` (код и документация) — run 35466886095, success с первой попытки (attempt 1). CI коммита с отчётом — в ответе сессии: коммит не может ссылаться на собственный прогон.

## UAT / E2E
Окружение: локальный Docker Compose (PostgreSQL, Redis), `pnpm dev` (API на :3000), dev-база после прежних задач, администратор dev-номера (TOTP настроен заново через `admin:reset-totp`), запросы — Node-скриптом через HTTP с сессией админки.

**Сценарий 1 — «Допуск» у «Моторных масел».** Первая попытка показала, что dev-база заполнена до TASK-011. В ней у «Допуска» нет признака «участвует в полноте» (это описано в CLAUDE.md), и есть лишняя обязательная характеристика «Основа mu84wwuh», оставшаяся от ручной проверки TASK-011. Поэтому созданные для сценария масла оказались неполными и не сравнивались. Из-за этого в dev-базе остались три лишних масла Shell; одно из них потом отправлено в архив. После этого:
0. `PATCH` «Допуск» `isRequiredForComplete: true` (шаг из CLAUDE.md) → 200, `sameProductItems: 0`. Двум маслам сценария дозаполнены значения — 200, `complete`.
1. Отбор `sameProduct=matching` → `[]`.
2. Архивировать «Допуск» → 200, `sameProductItems: 2`.
3. Отбор → «Shell Helix HX8 5W-30 (C3), 4 л» и «Shell Helix HX8 5W-30, 4 л» (из dev-заполнения).
4. «Объём» первого → 1 л (стало бы как у «Shell Helix HX8 5W-30, 1 л») → 409 `CATALOG_ITEM_DUPLICATE`, `existingItemId` этого масла.
5. Правка названия того же масла → 200.
6. Восстановить «Допуск» → 200, `sameProductItems: 0`; отбор → `[]`.

**Сценарий 2 — два worker'а.** Запущены два `pnpm --filter api worker`. Первый поставил расписание `dev.daily-at-setting` `0 10 * * *`, второй нашёл его совпадающим. `settings:set billing_notify_hour 14` → в журнале worker'а через ~10 с одна строка `Job schedule changed … cron="0 14 * * *" was="0 10 * * *"`. Затем `settings:set billing_notify_hour 16` (20:04:01): `jobs:status` в 20:04:05 уже показывал `0 16 * * *`, и в 12 опросах до 20:05:37 значение не менялось. Во всех журналах обоих worker'ов ровно три строки о расписании: set 10, changed 14, changed 16 — возвратов нет. После проверки `billing_notify_hour` и `login_code_resend_interval_seconds` сброшены (`settings:reset`), worker'ы остановлены.

## Acceptance Criteria
- **AC-1 — PASS.** Тест `catalog-items.integration.test.ts` «reports the pairs, lists them, lets the rest of such an item change and refuses only a change of its identity into another pair». Правка «Примечания», «Синтетики», «Штук в коробке», названия и состояния позиции из пары → 200. Объём → 1 л и вязкость → 5W-40 (совпадение с третьим) → 409 со ссылкой. Выход из пары и возврат в неё → 200 / 409. Дозаполнение ячейками вне идентичности по позициям пары → 200 (`changedCells: 3`). Ячейка, делающая позицию совпадающей, → 400 `CATALOG_VALUES_REJECTED` с `duplicate_item` на этой ячейке, и весь запрос не записан.
- **AC-2 — PASS.** Тот же тест: архивирование «Допуска» → `sameProductItems: 2`, отбор (и с `categoryId`) показывает пару, для другой категории — пусто. Восстановление → 0, отбор пуст. Снятие и установка «участвует в полноте» → 2 / 0. Архивирование варианта пар не создаёт.
- **AC-3 — PASS.** `git diff --numstat` файла в `HEAD` — `171 0` (текст). NUL записан как ` `; сырых NUL в отслеживаемых `.ts/.js/.json/.md/.sql` больше нет (заодно исправлен `tasks/TASK-009.A-REPORT.md`).
- **AC-4 — PASS.** Тесты «answers a brand's spelling / an article with 201 once the rival is gone, or with 409 — never 500»: отказ ключа без строки один раз → повтор → 201; всегда → 409 `CONFLICT`, `retryable: true`, ничего не записано. Создание и изменение проверены и для бренда, и для артикула. Тест «lets the other of two simultaneous registrations of one spelling in when the first rolls back»: настоящий откат первой транзакции, вторая → 201. На прежнем коде первые два теста получали 500.
- **AC-5 — PASS.** Тест «never puts a changed schedule back from a worker whose settings are cached from before the change» падает на прежнем коде (`'0 6 * * *'` вместо `'0 7 * * *'`) и проходит на новом. Тест «reads the Almaty time…» без изменений — 10/10.
- **AC-6 — PASS.** Контракт изменён аддитивно: `openapi:compat` — совместимо, без трейлера. Существующие тесты не ослаблены: в `sign-in-data-cleanup` перечни расписаний и задач только дополнены новой dev-задачей. Коммиты — по D-024, состав ниже. CI `44123cc` — run 35466886095, success с первой попытки; прогон коммита с отчётом — в ответе сессии.
- **AC-7 — PASS.** ARCHITECTURE.md 0.21: история, раздел 4.18 (I169–I172), уточнения I116, I158–I160.

## Commits
1. `1297d4c` Update project plan and state, add TASK-011.A (Product Owner edits) — `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-011.A.md`.
2. `bd7e5f5` Synchronize job schedules from fresh settings under one lock — `apps/api/src/jobs/{job-runner.service.ts, job-settings.ts, job-definition.ts, dev-jobs.ts, index.ts, jobs.integration.test.ts}`, `apps/api/src/modules/settings/app-settings.ts`, `apps/api/src/modules/identity/cleanup/sign-in-data-cleanup.integration.test.ts`.
3. `fb3fe01` Check product identity only when it changes; answer unique races with 409 — `apps/api/src/modules/catalog/{same-products.ts, catalog-items.service.ts, catalog-admin.service.ts, catalog-admin.controller.ts, catalog-brands.service.ts, catalog-errors.ts, catalog-paging.ts, catalog-items.integration.test.ts}`, `packages/contracts/src/{catalog-items.ts, catalog.ts, error.ts}`, `apps/api/openapi.json`.
4. `b8a0e4f` Replace raw NUL bytes with escape sequences — `apps/api/src/modules/catalog/catalog-values.test.ts`, `tasks/TASK-009.A-REPORT.md`.
5. `44123cc` Document the TASK-011.A decisions (ARCHITECTURE 0.21, 4.18) — `ARCHITECTURE.md`.
6. Коммит с этим отчётом — `tasks/TASK-011.A-REPORT.md`.

## Errors & Fixes
- **Тест очистки ожидал точный список расписаний и задач.** После добавления `dev.daily-at-setting` тест «runs by its schedule every minute…» упал. Ожидание дополнено новой строкой, остальные проверки не изменились.
- **Первый проход сценария 1 в dev** шёл по dev-базе без «Допуска» в полноте и с лишней обязательной характеристикой, поэтому масла не сравнивались, и в базе остались лишние позиции (см. UAT). Сценарий повторён после шага из CLAUDE.md.
- **Правки файлов через Python** на Windows один раз записали CRLF. Это найдено до коммита (`file … CRLF`); окончания строк исправлены, `format:check` зелёный.

## Deviations
- **Добавлена dev-задача `dev.daily-at-setting`.** Сценарий «изменить время ежедневной задачи → `jobs:status`» из раздела «Что должно реально работать» без неё проверить нельзя: в каталоге задач пока только минутные свиперы. Задача существует только в development/test (как `dev.always-fails`) и использует уже существующую настройку `billing_notify_hour`.
- **Код 409 при гонке уникального ключа — общий `CONFLICT`,** а не новый код справочника. Причина — в Technical Decisions. В TASK требуется «понятный код»: сообщение и `retryable: true` говорят клиенту повторить запрос.
- **«Откат конкурирующей транзакции» сам по себе к 500 не приводил.** PostgreSQL в этом случае просто пропускает вторую вставку, это проверено тестом. 500 возникал, когда ключ отказал, а занявшей строки к моменту поиска уже нет. В тесте такой отказ воспроизводится триггером.
- **CLAUDE.md не обновлён** (его ведёт не агент). Стоит дополнить раздел dev: `sameProduct=matching` и `sameProductItems`, задача `dev.daily-at-setting` в `jobs:status`. Также в dev-базе, заполненной до TASK-011, «Допуск» надо включить в полноту — это уже описано.

## Known Issues / Risks
- Синхронизация расписаний теперь делает один запрос настроек на проход (раз в 15 с на worker) и занимает одно подключение пула на время прохода (несколько запросов). Если база недоступна, проход пропускается с предупреждением, как и раньше.
- `sameProduct=matching` без `categoryId` считает подписи всех товаров справочника одним запросом. На объёмах MVP это быстро; при росте справочника — индексы и материализация (EPIC-15).
- В dev-базе остались три масла Shell из первой попытки сценария, одно в архиве; удаления в справочнике нет. Характеристика «Основа mu84wwuh» от проверки TASK-011 — тоже прежний мусор dev-базы.

## Remaining Work
None.

## Future Improvements
- Слияние дублей позиций (перенос предложений и ссылок) — когда появятся предложения (вне scope TASK-011.A).
- Отметка «совпадает с другой» прямо в строке списка и карточке (id совпадающей позиции) — для экрана A-CAT-03 (TASK-035).

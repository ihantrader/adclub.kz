# TASK REPORT — TASK-007

## Status

COMPLETED — 12/12 AC. Номер и статус CI-прогона коммита с этим отчётом — в ответе агента (отчёт не может содержать результат собственного прогона).

## Result

- Продуктовые пороги, лимиты, сроки и тексты — данные. Реестр в коде описывает **82 настройки** в 12 группах: у каждой — ключ, группа, тип, единица, диапазон или набор значений, умолчание, описание (ru) и кто меняет. В таблице `app_setting` лежат только изменённые значения, в `app_setting_change` — история. Историю нельзя править: это запрещает триггер в базе, маршрута правки нет.
- Администратор (контекст `admin`) через API:
  - видит список по группам: значение, умолчание, диапазон, версию, кто и когда менял;
  - меняет значение с причиной и получает «было → стало»;
  - сбрасывает к умолчанию и смотрит историю.
  Неверный тип и выход за диапазон отклоняются (400). Правка от устаревшей версии получает 409 `SETTING_VERSION_CONFLICT`, ничего не перезаписывается.
- Настройки безопасности входа (`login_code_*`, `session_*`, `sign_in_*`, `admin_totp_*`, `admin_backup_code_count`) API показывает, но не меняет (403 `SETTING_OPERATOR_ONLY`, D-053). Меняет серверная команда `operator settings:list|get|set|reset|history`. Она работает с любыми настройками, требует причину, пишет историю с отметкой `operator`.
- Изменение действует во всех процессах (API, worker) не позже чем через 30 с, без перезапуска. Процесс, в котором сделано изменение, применяет его сразу.
- Если база недоступна, процесс работает на последних прочитанных значениях и к умолчаниям не переходит. Если значения ни разу не удалось прочитать — 503, как у других запросов к базе.
- Испорченное значение в базе не применяется: действует умолчание, событие пишется в журнал, в списке API у ключа `storedValueInvalid: true`.
- Коды входа, сессии, шаги входа, второй фактор и политика клиента читают значения из настроек. Их переменные удалены из схемы конфигурации и `.env.example`. Если старые переменные остались в окружении, API и worker пишут предупреждение с их именами.
- Жёсткие пределы безопасности — границы реестра: админская сессия не дольше 12 ч, незавершённый шаг входа не дольше 30 мин и прежние пределы.
- Политика клиента (минимальные версии iOS, Android, кабинета и админки, текст kk/ru/en) меняется без перезапуска, ответ 426 работает как прежде.
  - Минимум админки нельзя поднять выше версии админки этого развёртывания (`ADMIN_WEB_RELEASE_VERSION`).
  - Устаревшая вкладка админки всё равно входит и исправляет политику: у маршрутов входа, `/auth/me`, обновления токенов, выхода и настроек проверка версии для `admin-web` не применяется.
- Тесты задают пороги только через настройки. Два нестабильных теста TASK-005 стабилизированы: во втором исправлена причина в коде — срок access-токена мог выходить за конец сессии из-за округления до секунды.

## Changes

- `infra/migrations/1789656263507_create-app-setting.sql` — таблицы `app_setting`, `app_setting_change`, индекс, триггер запрета `UPDATE`/`DELETE` истории; `down` удаляет всё добавленное.
- `apps/api/src/modules/settings/` — новый доменный модуль:
  - `registry/registry.ts` — ключи и группы;
  - `registry/setting-definition.ts` — типы, проверка значения, описание ограничений;
  - `schema.ts` — Drizzle-схема;
  - `settings.store.ts` — хранилище;
  - `app-settings.ts` — кэш;
  - `settings-change.service.ts` — список, правка, сброс, история;
  - `settings.controller.ts` — маршруты;
  - `identity-settings.sources.ts` — реализации источников порогов для identity;
  - `settings.module.ts` (глобальный), `index.ts`;
  - тесты: `registry.test.ts`, `setting-definition.test.ts`, `app-settings.test.ts`, `settings.integration.test.ts`.
- `apps/api/src/modules/identity/`:
  - источники `LoginCodeSettingsSource`, `SessionSettingsSource`, `SignInSettingsSource` — теперь только абстракции и типы; реализации из окружения удалены, провайдеры — в модуле настроек;
  - новый `account/account-directory.ts` — маскированные номера для других модулей;
  - `session/session.service.ts` — срок токена не позже конца сессии.
- `apps/api/src/client-policy/`:
  - `SettingsClientPolicySource` вместо `ConfigClientPolicySource`;
  - guard пропускает устаревший `admin-web` на маршрутах с `enforced_except_admin_web`.
- `apps/api/src/config/`:
  - из схемы удалены `CLIENT_MIN_VERSION_*`, `CLIENT_UPDATE_MESSAGE_*`, пороги `LOGIN_CODE_*`, `SESSION_*`, `SIGN_IN_*`, `ADMIN_TOTP_ALLOWED_DRIFT_STEPS`, `ADMIN_TOTP_VERIFY_*`, `ADMIN_BACKUP_CODE_COUNT`;
  - добавлены `ADMIN_WEB_RELEASE_VERSION` и `ignoredVariables`, новый `ignored-variables.ts` (предупреждение при старте, вызывается из `main.ts` и `worker.ts`).
- Подключение модуля настроек:
  - `app.module.ts`, `worker.module.ts` — `SettingsModule` и тестовый параметр кэша;
  - `operator.ts` — команды `settings:*`;
  - `orm-tables.ts` — новые таблицы в сверке схемы;
  - `testing/database.ts` — новые таблицы в `TRUNCATE_ALL`.
- Тестовые утилиты: `testing/settings.ts` (`TestSettings`), `testing/totp.ts` (TOTP для тестов вне модуля identity).
- Обновлены тесты: `access`, `login-code`, `session`, `database`, `schema-drift`, `client-policy.e2e`, `contract-routes.e2e`, `env.schema`.
- `packages/contracts`:
  - новый `settings.ts` — схемы;
  - `routes.ts` — 4 маршрута и значение `enforced_except_admin_web`, им помечены 8 маршрутов входа и сессии;
  - `error.ts` — 2 кода;
  - `openapi.ts` — 14 компонентов;
  - тесты `settings.test.ts`, `openapi.test.ts`.
- `packages/api-client` — тест PUT-маршрута; методы клиента строятся по `apiRoutes`, поэтому появились автоматически.
- `apps/api/openapi.json` — перегенерирован.
- `.env.example` — пороги удалены, описаны настройки и `ADMIN_WEB_RELEASE_VERSION`.
- `apps/admin-web/src/api.ts`, `apps/supplier-web/src/api.ts` — комментарии больше не ссылаются на `CLIENT_MIN_VERSION_*`.
- `ARCHITECTURE.md` 0.14 — раздел 4.11, переписан 14, уточнены 4.4 I27, 4.5 I37, 4.6 I56, 4.7 I63, 4.8 I78, 4.9 I84, 5.12, 7.4, история. `CLAUDE.md`, блок 0 — работа с настройками в dev, прежние указания про переменные заменены.

## Technical Decisions

Все внесены в ARCHITECTURE.md 4.11 (I99–I111). Главное:

- **Реестр — код, значения — данные** (I99). Типы: `integer`, `number`, `duration`, `boolean`, `string`, `enum`, `localized_text`, `composite`, `app_version`. Тип значения каждого ключа выводится из реестра, поэтому опечатка в ключе — ошибка компиляции. Одна и та же проверка работает при правке и при чтении из базы.
- **Версия ключа — номер последней записи истории** (I102), поэтому переживает сброс. Одновременную правку сериализует advisory-блокировка по ключу; уникальность `(key, version)` в истории — страховка.
- **Кэш с ленивым перечитыванием** (I103). Значения используются, пока с начала запроса, которым они прочитаны, прошло меньше 30 с. Фоновый таймер не нужен.
- **Отказ базы** (I104). Процесс работает на последних значениях; если значения ни разу не прочитаны — 503.
- **Защита от блокировки админки** (I107) — два механизма:
  1. минимум админки не выше `ADMIN_WEB_RELEASE_VERSION`: это факт релиза, в dev он равен версии `apps/admin-web/package.json`, тест следит за совпадением;
  2. новое значение контракта `enforced_except_admin_web` для маршрутов входа и настроек.
- **Источники порогов identity предоставляет модуль настроек** (I103), поэтому `identity` не зависит от `settings` и циклических импортов нет. Номера для истории модуль настроек получает через публичный `AccountDirectory` модуля `identity`, а не из его таблиц.
- **В окружении остались** (I108) только инфраструктура, секреты, свойства развёртывания и переключатели разработки.
- **Срок access-токена** (I111): `exp = min(now + ttl, ⌊конец сессии⌋)`, `iat = min(now, exp − 1)`.

## Verification

- `pnpm format:check` — PASS.
- `pnpm lint` — PASS (12/12 задач).
- `pnpm typecheck` — PASS (18/18).
- `pnpm build` — PASS (11/11; включая бандлы мобильного).
- `pnpm test` — PASS (15/15 задач). Новые юнит-тесты:
  - `registry.test.ts` (6): ключи реестра ровно совпадают с таблицей ARCHITECTURE 14, группы SCREENS, умолчания проходят свою проверку, D-053, жёсткие пределы;
  - `setting-definition.test.ts` (8);
  - `app-settings.test.ts` (9): граница 30 с, отсчёт от начала запроса, `refresh()`, испорченные значения, отказ базы, 503 без прочитанных значений;
  - `contracts/settings.test.ts` (4);
  - в `env.schema.test.ts` и `client-policy.e2e.test.ts` добавлены проверки новых правил.
- `pnpm test:integration` — PASS: 6 файлов, 150 тестов (локально, Docker/Testcontainers). Новый файл `settings.integration.test.ts` (16 тестов):
  - API: список, правка, сброс, история;
  - отказы: тип, диапазон, неизвестный ключ, пустой язык, лишнее и недостающее поле, без причины;
  - одновременная правка: 200 + 409;
  - неизменяемость истории;
  - матрица контекстов: мобильная и кабинет — 403, без сессии — 401;
  - безопасность входа: 403 через API, серверная команда из второго контекста — новый лимит действует на `POST /auth/login-code`;
  - жёсткие пределы при испорченных значениях;
  - политика клиента, минимум админки, устаревшая вкладка админки;
  - испорченные и неизвестные значения;
  - изменение во втором процессе (worker);
  - отказ PostgreSQL через прокси: последние значения, восстановление;
  - процесс без прочитанных значений: 503 → восстановление;
  - настоящая серверная команда (`tsx src/operator.ts`): set, get, конфликт, неверное значение, без причины, reset, history, list, изменение подхватил работающий API.
- `pnpm --filter @adclub/api openapi:check` — PASS: файл совпадает с контрактом и маршрутами.
- `pnpm --filter @adclub/api openapi:compat --base HEAD` (до коммитов) — PASS: «No breaking changes», трейлер не нужен.
- Цикл миграций — PASS: новый шаг в `database.integration.test.ts` (откат новой миграции с данными, удаление триггера и функции, повторное применение). Локально `pnpm --filter api migrate` применил миграцию к dev-базе, `migrate:status` — 6 применённых, 0 ожидающих.
- Сверка ORM-схемы с базой — PASS: `schema-drift`, таблицы зарегистрированы в `orm-tables.ts`.
- CI `main`, коммит `19d0d25` — см. раздел «CI».

## UAT / E2E

Окружение: Windows, `docker compose -f infra/docker/compose.dev.yml up -d`, `pnpm --filter api migrate`, API — `tsx src/main.ts` (кэш настроек по умолчанию, 30 с). Запросы — Node `fetch` из вспомогательных скриптов в scratchpad (как curl), серверная команда — `pnpm --filter api operator …`. Администратор `+7***0001` назначен командой `admin:grant`, вход — код из `/dev/login-codes`, настройка TOTP, подтверждение (`403 TOTP_SETUP_REQUIRED` → 200).

1. **Порог меняется на лету.**
   - `PUT /admin/settings/assistant_daily_dialogs_per_user` `{value:5, expectedVersion:0, reason}` → 200, `change`: `previousValue 20 → newValue 5`, `by {kind: admin, phoneMasked: "+7***0001"}`.
   - `GET /admin/settings` → `value 5, version 1, lastChange {set, admin, at}`.
   - История — одна запись с причиной.
   - `POST …/reset` `{expectedVersion:1}` → `value 20, isDefault true, version 2`; последняя запись истории — `reset 5 → 20`.
2. **Неверное значение.** `value: 5000` → 400 `VALIDATION_ERROR` «Too big: expected number to be <=1000»; `value: "много"` → 400. В истории по-прежнему 2 записи.
3. **Одновременная правка.** Два параллельных `PUT rating_min_reviews` от версии 0 → `200` и `409 SETTING_VERSION_CONFLICT`; в истории одна запись. Повтор от версии 0 → 409 `details.currentVersion: 1`.
4. **Безопасность.**
   - `PUT` и `reset` `login_code_requests_per_phone` через API → 403 `SETTING_OPERATOR_ONLY`, история пуста.
   - Серверная команда `settings:set login_code_requests_per_phone 1` (перед этим лимит 1000 и интервал повторной отправки 1 с — тоже командой, с ожиданием 31 с).
   - Запросы кода на тот же номер каждые ~2 с: 200 до t+25 с, на **t+28 с — 429 `login_code_requests_per_phone`**, без перезапуска API.
   - `settings:history` показывает версии 1–3 с `by operator` и причинами.
5. **Политика клиента.**
   - `PUT client_min_version_android "2.0.0"` → сразу `GET /ready` с `mobile/1.5.0 (android)` → 426 (текст на kk при `Accept-Language: kk`), `mobile/2.0.0 (android)` и `mobile/1.5.0 (ios)` → 200.
   - `/meta/client-policy` показывает 2.0.0.
   - Сброс → снова 200.
   - `client_min_version_admin_web "0.2.0"` → 400 «Can't be above the current admin panel version 0.1.0» (так же серверной командой), `"latest"` → 400.
6. **Старая вкладка админки.**
   - Командой поднят минимум админки до 0.1.0; через 31 с `GET /ready` с `admin-web/0.0.9` → 426, `/admin/administrators` → 426.
   - Новый вход с `admin-web/0.0.9` (код, TOTP) → 200.
   - `PUT client_min_version_admin_web "0.0.0"` с этой вкладки → 200; после этого `/ready` для 0.0.9 → 200.
   - Первая попытка входа упёрлась в лимит «1 код в час» из сценария 4 (429) — лимит работал; его вернули командой `settings:reset`.
7. **Чужой контекст.** Мобильная сессия и сессия кабинета (компания и сотрудник созданы командами `dev:*`): `GET /admin/settings`, `PUT …`, `GET …/history` → 403 `FORBIDDEN`. Без токена → 401 `AUTH_REQUIRED`.
8. **Дополнительно.**
   - Отказ базы на живом API: при остановленном контейнере PostgreSQL (`docker stop` на 32 с) `/meta/client-policy` отдавал сохранённый минимум iOS 1.3.0, а `mobile/1.2.0 (ios)` получал 426. В журнале — `Settings could not be read, keeping the values read at …`, после `docker start` — `Settings read again after a failure`.
   - Worker стартует с модулем настроек.
   - Оставшиеся в локальном `.env` `CLIENT_MIN_VERSION_ADMIN_WEB`, `CLIENT_MIN_VERSION_IOS` проигнорированы; API и worker при старте предупредили о них.

Все значения, изменённые при проверке, возвращены к умолчаниям (`settings:reset`). В dev-базе остались администратор `+7***0001`, компания «UAT Автомаркет» и история изменений. Экранов админки нет (TASK-034), в браузере не проверялось.

## Acceptance Criteria

- **AC-1 — PASS.** Реестр `apps/api/src/modules/settings/registry/registry.ts` — 82 ключа с типом, единицей, диапазоном, умолчанием, описанием и `editableBy`. `registry.test.ts` проверяет, что ключи реестра совпадают с таблицей ARCHITECTURE 14, что есть группы и ключи SCREENS A-SET-01/02 и что все умолчания проходят проверку. Ключи вне прежнего ARCHITECTURE 14 и предположения — в разделе «Deviations».
- **AC-2 — PASS.** Интеграционные тесты «changes a threshold…», «refuses a wrong type…», «gives one of two changes… a conflict»; UAT 1–3.
- **AC-3 — PASS.** Граница 30 с — юнит-тест `app-settings.test.ts`: смена в хранилище не видна через 29 999 мс и видна через 30 000 мс, отсчёт от начала запроса. Реальный порог в другом процессе — интеграционный тест: серверный путь из контекста worker ставит `login_code_requests_per_phone = 1`, и `POST /auth/login-code` отвечает 429 без перезапуска; изменение из API видит worker. UAT 4: 429 на t+28 с при кэше 30 с.
- **AC-4 — PASS.** 403 `SETTING_OPERATOR_ONLY` для пяти ключей безопасности (интеграционный тест, UAT 4). Серверная команда меняет любые настройки и пишет историю `operator` (интеграционный тест «operator command», UAT 4 — `settings:history`).
- **AC-5 — PASS.** Источники identity и политики клиента — `SettingsLoginCodeSource`, `SettingsSessionSource`, `SettingsSignInSource`, `SettingsClientPolicySource`. В `env.schema.ts` и `.env.example` этих переменных нет, тест «ignores and reports former variables» это подтверждает. Пределы: `registry.test.ts` «keeps the hard safety limits», интеграционный тест «never apply a stored value beyond the hard limits» (сохранённые в обход 86 400 с и 7200 с не применяются: сессия ≤ 12 ч, шаг ≤ 600 с; серверная команда 43 201 не принимает).
- **AC-6 — PASS.** Интеграционные тесты «changes without a restart; the admin panel minimum can't pass the current release» и «lets an administrator with an old admin panel tab sign in and fix the policy»; `client-policy.e2e.test.ts` «still serves an outdated admin panel…»; UAT 5–6.
- **AC-7 — PASS.** Интеграционные тесты «ignores a broken or unknown stored value…», «keeps the last values while PostgreSQL is down…», «fails like any database request in a process that never read them…»; юнит-тесты кэша; UAT 8 (живой API при остановленной базе).
- **AC-8 — PASS.** «is closed to mobile and cabinet sessions and to callers without a session» — 4 маршрута × 2 контекста → 403 `FORBIDDEN`, без сессии → 401; UAT 7. Маршруты объявлены с `contexts: ["admin"]`, решение принимает предикат TASK-006.
- **AC-9 — PASS.**
  - Тесты `access`, `login-code`, `session` задают пороги через `TestSettings`, который вызывает `SettingsChangeService`. Правок `config.*.settings` и порогов в `loadConfig` в тестах не осталось.
  - Тест «stays signed in until an explicit logout…»: после истечения первого токена срок возвращается к 900 с до обмена, все проверки на месте.
  - Тест «never extends an admin session past 12 hours»: исправлена причина в коде (I111), срок сессии в тесте 3 → 4 с, проверка `accessTokenExpiresAt <= sessionExpiresAt` осталась.
  - `pnpm test` и `pnpm test:integration` — PASS.
- **AC-10 — PASS.**
  - `packages/contracts` (схемы, маршруты, коды), `openapi.json` перегенерирован, `openapi:check` — PASS.
  - `openapi:compat` — «No breaking changes», коммиты без трейлера `Contract-Breaking-Change`.
  - `@adclub/api-client` — метод `changeSetting` (тест).
  - Миграция обратима (тест цикла миграций).
  - Таблицы в `orm-tables.ts`, `schema-drift` — PASS.
- **AC-11 — PASS.** Коммиты ниже, в каждом только явно перечисленные пути. CI прогона кода — раздел «CI»; прогон коммита с отчётом — в ответе агента.
- **AC-12 — PASS.** ARCHITECTURE.md 0.14: раздел 4.11 (I99–I111), раздел 14 переписан (фактические ключи, что осталось в окружении), история. CLAUDE.md, блок 0: «Настройки в dev», замены указаний про `LOGIN_CODE_*`, `SESSION_*`, `SIGN_IN_*`, `CLIENT_MIN_VERSION_*`.

### Коммиты (D-024)

- `aa8d4fd` — Update project plan and state, add TASK-007 (Product Owner edits): `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-007.md`.
- `0615bb2` — Add the settings contract: schemas, admin routes and error codes: `packages/contracts/src/{settings.ts,settings.test.ts,error.ts,index.ts,openapi.ts,openapi.test.ts,routes.ts}`, `packages/api-client/src/create-api-client.test.ts`.
- `e5bec45` — Never let an access token outlive its session by exp rounding: `apps/api/src/modules/identity/session/session.service.ts`.
- `b6cc92d` — Keep product settings in data: registry, history and cache (TASK-007) — 51 файл:
  - миграция `infra/migrations/1789656263507_create-app-setting.sql`;
  - `apps/api/src/modules/settings/**` (14 файлов);
  - identity: `account/account-directory.ts`, `identity.module.ts`, `index.ts`, три `*-settings.source.ts`, `login-code.service.ts`, интеграционные тесты `access`, `login-code`, `session`;
  - `client-policy/{client-policy.module,client-policy.source,client-version.guard,index,client-policy.e2e.test}.ts`;
  - `config/{env.schema,env.schema.test,index,ignored-variables}.ts`;
  - `app.module.ts`, `worker.module.ts`, `main.ts`, `worker.ts`, `operator.ts`, `orm-tables.ts`;
  - `openapi/{route-listing-config,contract-routes.e2e.test}.ts`, `database/{schema-drift.test,database.integration.test}.ts`;
  - `testing/{database,settings,totp}.ts`;
  - `apps/api/openapi.json`, `.env.example`, `apps/admin-web/src/api.ts`, `apps/supplier-web/src/api.ts`.
- `19d0d25` — Document TASK-007 settings decisions in ARCHITECTURE 4.11, 14 and CLAUDE.md: `ARCHITECTURE.md`, `CLAUDE.md`.
- коммит с этим отчётом: `tasks/TASK-007-REPORT.md`.

## CI

- Прогон `35239494557` (push в `main`, коммит `19d0d25`) — **completed / success**: format, lint, typecheck, test, integration test, build, openapi:check, openapi:compat (без трейлера), graceful shutdown — все шаги success.
- Прогон коммита с этим отчётом — номер и статус в ответе агента.

## Errors & Fixes

- **Тест лимита кодов на номер** в полном параллельном прогоне получил 200 вместо 429; отдельно проходил. Причина: три запроса с паузой 1,1 с не укладывались в окно 3 с на нагруженной машине. Окно в тесте увеличено до 6 с, проверки те же.
- **Тесты входа админки** выставляли `totpAllowedDriftSteps: 10` в обход схемы (у схемы предел 5). Через механизм настроек 10 не проходит — тест использует 5, этого хватает (прогон зелёный).
- **Контрактный e2e-тест** «serves health and the client policy» ожидал 200 от `/meta/client-policy` без базы. Теперь политика — настройка, и без единого чтения ответ 503. Тест переписан под новое правило; с базой политику проверяют интеграционные тесты.
- **Проверка версии** `maxVersion` падала на мусорной строке: второй `refine` zod выполнялся после первого. Добавлена защита, покрыто тестом.
- **Heredoc в Git Bash** дважды оборвался на тексте с кавычками — файлы и скрипты записаны через Write. Аргументы вида `/admin/…` Git Bash переписывал в пути Windows — в UAT-скриптах `MSYS_NO_PATHCONV=1`.
- **Первый прогон интеграционных тестов** (до обновления ожиданий) упал в трёх местах, как и ожидалось: список миграций, список админских маршрутов в тесте ролей, упомянутый выше тест окна. Исправлено, следующий полный прогон — 150/150.

## Deviations

- **Ключи вне прежнего ARCHITECTURE 14** — ARCHITECTURE 14 переписан по реестру:
  - из SCREENS A-SET-01: `price_change_threshold_percent` («порог резкого изменения цены»), `review_check_max_wait_minutes` («порог ожидания проверки отзывов»);
  - `attention_after_days` — назван в ARCHITECTURE 13.2, в таблице 14 его не было;
  - вместо `min_supported_mobile_version` и `force_update_message` — `client_min_version_ios`, `client_min_version_android`, `client_min_version_supplier_web`, `client_min_version_admin_web` (у платформ свои минимумы с TASK-003, их требует SCREENS A-SET-02) и `client_update_message`;
  - окна лимитов входа выделены в отдельные ключи `*_window_seconds`: в прежнем 14 они были указаны как «5 за 3600 с». Окна дневных SMS-лимитов остались фиксированными — сутки, как и раньше.
- **Предположения по умолчаниям** — в PRODUCT.md и ARCHITECTURE.md значений нет, все меняются без релиза:
  - `supplier_response_hours` = 2 (PRODUCT: «1–2 часа»; выбрана верхняя граница);
  - `on_order_pickup_reserve_hours` = 72 (ARCHITECTURE: «больше суток»);
  - `term_agreement_hours` = 24, `time_agreement_hours` = 24, `service_grace_hours` = 2, `reserve_warning_hours` = 3, `late_cancel_hours` = 2, `deadline_extension_max_hours` = 24, `attention_after_days` = 7;
  - `whatsapp_fallback_minutes` = 15, `whatsapp_batch_window_seconds` = 60, `whatsapp_outage_window_minutes` = 15, `whatsapp_outage_error_ratio` = 0,5, `moderation_digest_hour` = 18;
  - `critical_notification_kinds` — список из ARCHITECTURE 9.3, но **допустимые имена видов уведомлений** (11 штук: `order_accepted`, `order_ready`, `order_confirmed`, `order_declined`, `order_expired_no_response`, `term_proposed`, `time_proposed`, `reserve_expiring`, `order_closed`, `maintenance_reminder`, `payment_failed`) — предположение по PRODUCT 15; EPIC-09 может их уточнить (значения набора только добавляются);
  - `assistant_max_turns` = 8 (ARCHITECTURE 11.5: «5–8 ходов»), `ai_daily_budget_usd` = 100;
  - `assistant_symptom_disclaimer` и `price_increase_notice_text` — тексты kk/ru/en написаны агентом, казахский текст требует проверки носителем;
  - `rating_weights` = {reviews 0,6, response_rate 0,2, deadline_rate 0,2} с условием «сумма 1» — формулу рейтинга определит его задача;
  - `views_signal_min` = 100, `views_signal_ratio` = 0,3, `price_match_confidence_threshold` = 0,85, `price_change_threshold_percent` = 30, `review_check_max_wait_minutes` = 60;
  - `photo_display_mode` = `link` (до заключения юриста — более осторожный вариант);
  - `store_outage_signal_hours` = 24;
  - `default_city` — строка «Алматы» (справочника городов ещё нет);
  - диапазоны (min/max) всех ключей, кроме уже бывших в схеме окружения.
- **Способ защиты админки от блокировки** выбран агентом, как разрешает задача (ARCHITECTURE 4.11 I107). «Текущая версия админки, которую отдаёт сервер» — это `ADMIN_WEB_RELEASE_VERSION`: API не раздаёт файлы админки и не знает её версию сам. Переменную должен задавать деплой (TASK-055).
- **Мобильный клиент с подменённым `X-Client: admin-web/…`** проходит проверку версии на маршрутах входа. Это не граница безопасности (ARCHITECTURE 4.6 I46), права решает предикат.
- **Сохранение значения, равного умолчанию,** создаёт строку (`isDefault: false`): «вернуть умолчание» — отдельное действие (сброс), как требует задача.
- **Расхождений TASK-007 с PRODUCT.md** не найдено.

## Known Issues / Risks

- `ADMIN_WEB_RELEASE_VERSION` обязателен вне development/test. Staging и production без этой переменной не стартуют — TASK-055 должен её задавать из версии собранной админки.
- Пока API ни разу не прочитал настройки (база недоступна с запуска), известные клиенты получают 503 на всех маршрутах с проверкой версии, включая `/ready`. Это поведение «как у других запросов к базе», но оно шире прежнего (раньше политика была в памяти).
- История отдаёт до 200 последних записей ключа, без постраничного вывода.
- Серверная команда пишет журнал Nest в stdout перед результатом (было и до задачи): результат — последняя строка вывода. Для разбора скриптом нужен `tail -1` или `LOG_LEVEL=warn`.
- Кэш — ленивый: процесс, который долго не читает настройки, перечитает их при первом обращении. Будущие фоновые задачи (TASK-008) получают значения не старше 30 с на момент чтения.
- В локальном `.env` разработчика могут остаться старые переменные порогов — они игнорируются с предупреждением. На этой машине это `CLIENT_MIN_VERSION_ADMIN_WEB` и `CLIENT_MIN_VERSION_IOS`; `.env` агентом не менялся.
- В dev-базе остались данные UAT (администратор `+7***0001`, компания «UAT Автомаркет», сотрудник, история настроек).

## Remaining Work

None.

## Future Improvements

- Постраничная история (`before`/`limit`) — вместе с экраном A-SET-01 (TASK-034).
- Флаг `--json-only` (или вывод журнала в stderr) у серверной команды, чтобы результат разбирался без `tail`.
- Ключи напоминаний о ТО из ARCHITECTURE 13.2 (`mileage_ask_days`, `reminder_lead_km`, `reminder_lead_days`) — завести вместе с их задачей (EPIC гаража).
- Сигнал администратору (не только журнал), если в базе найдено испорченное значение настройки, — с появлением `admin_signal`.
- Действие «пересчитать дедлайны незакрытых заявок» после смены таймеров (ARCHITECTURE 13.4) — с задачами заявок.

# TASK REPORT — TASK-005

## Status
COMPLETED

## Result
- При первом успешном вводе кода создаётся учётная запись. На один номер — одна запись. В той же транзакции, где расходуется код, создаётся сессия мобильного приложения. Ответ `POST /auth/login-code/verify` дополнен полями `accountId` и `session`: access-токен, refresh-токен и их сроки. Прежние поля не изменились.
- Защищённые маршруты `GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/{sessionId}`, `POST /auth/sessions/end-others`, `POST /auth/sessions/end-all` и `POST /auth/logout` принимают только действующий access-токен неотозванной сессии. Код ошибки подсказывает клиенту, что делать дальше:
  - `ACCESS_TOKEN_EXPIRED` — обновить токен;
  - `AUTH_REQUIRED` — войти;
  - `SESSION_ENDED` — войти заново.
- `POST /auth/session/refresh` выдаёт новую пару токенов и сдвигает срок сессии. Если тот же обмен повторяется в течение 60 с, возвращается та же пара: это покрывает гонки и повтор после потерянного ответа. Если заменённый токен предъявлен позже, сессия отзывается целиком. Админская сессия не живёт дольше 12 часов от входа.
- Владелец видит свои действующие сессии: устройство, платформу, версию, время создания и последнего использования. Текущая сессия отмечена, IP показан только сокращённо. Сессии можно завершать по одной, все кроме текущей, все сразу, а также выйти. Чужая сессия отвечает так же, как несуществующая (404).
- Отзыв срабатывает сразу для всех видов сессий: каждый запрос проверяет строку сессии в PostgreSQL.
  - Если упал Redis, отозванные сессии по-прежнему отклоняются, действующие работают. Обмен токена в это время получает 503 с признаком повтора, после восстановления Redis всё работает без перезапуска.
  - Если упал PostgreSQL, любой запрос с токеном получает 503, а не доступ и не выход.
- Механика сессий кабинета поставщика готова: refresh-токен в HttpOnly-cookie, 180 дней со скольжением, контекст компании и сотрудника, выход только явный. Готова и механика админки (12 часов). Выдача обоих видов через API закрыта: 403 `SESSION_KIND_UNAVAILABLE` возвращается до проверки кода, поэтому код не расходуется. Cookie защищена от подделки межсайтовых запросов проверкой `Origin`.
- CORS разрешён только доменам кабинета и админки из конфигурации. Запрос с любым другим `Origin` получает 403 `ORIGIN_NOT_ALLOWED`. Мобильное приложение и запросы без `Origin` работают как раньше.
- В CLAUDE.md внесено правило коммитов D-024.

## Changes
- `packages/contracts`:
  - `session.ts` — схемы сессий;
  - `routes.ts` — 7 новых маршрутов, поля `auth` и `pathParams`, функция `buildRoutePath`;
  - `openapi.ts` — параметры пути и схема безопасности bearer;
  - `error.ts` — 5 новых кодов;
  - `login-code.ts` — `deviceName` в запросе, `accountId`/`session` в ответе, 2 новых имени лимитов.
- `packages/api-client` — параметры пути, `getAccessToken` (заголовок `Authorization` только на маршрутах сессии), опция `credentials`.
- `apps/api/src/modules/identity/session/`:
  - `session-tokens.ts` — подпись и проверка JWT HS256, выведение refresh-токенов;
  - `session.service.ts` — выдача, обмен, проверка доступа, список, завершение;
  - `session.store.ts`;
  - `sign-in.service.ts` — вход и закрытие видов сессий по D-025;
  - `session.guard.ts` — `SessionGuard`, `SessionRoute`, `CurrentSession`;
  - `session.controller.ts`;
  - `session-cookie.ts` — cookie и проверка `Origin`;
  - `session-errors.ts`, `session-settings.source.ts`, `ip-hint.ts`;
  - `session.integration.test.ts` — 45 тестов.
- `identity/account/account.store.ts` — найти или создать учётную запись по номеру.
- `identity/login-code` — `verifyCodeAnd` выполняет продолжение в транзакции, которая расходует код; контроллер `verify` выдаёт сессию.
- `apps/api/src/common/http/` — `OriginPolicyMiddleware`, параметры CORS, чтение cookie. `http-app.ts` и `app.module.ts` подключают их.
- `common/contract/api-route.decorator.ts` — отказывается привязать маршрут с `auth: "session"` без guard; переводит `{param}` в `:param`.
- `database/database-error.ts` — ошибка запроса Drizzle попадает в журнал без значений параметров; применяется в глобальном фильтре и в сервисе сессий.
- `config/env.schema.ts` — переменные `SESSION_*`, `SUPPLIER_WEB_ORIGINS`, `ADMIN_WEB_ORIGINS`; `SESSION_TOKEN_SECRET` обязателен вне development/test. Обновлён `.env.example`.
- `infra/migrations/1789627880146_create-session.sql` — таблица `session`, обратимая. Drizzle-схема и `identityTables` (`orm-tables`) обновлены.
- `apps/api/src/testing/tcp-proxy.ts` вынесен из теста TASK-004 для общего использования и исключён из сборки.
- `apps/api/openapi.json` перегенерирован.
- `ARCHITECTURE.md` 0.9, `CLAUDE.md`.

## Technical Decisions
Все решения записаны в ARCHITECTURE.md, раздел 4.6 (I44–I59); уточнены разделы 1, 4.1 I6, 5.1, 8.2, 8.3 и 14.
- **Как реализован мгновенный отзыв (I51).** Каждый защищённый запрос проверяет строку `session` в PostgreSQL. Чёрного списка в Redis, который предполагали 8.2 и 8.3, нет. Причина: отзыв, сделанный во время недоступности Redis, после восстановления Redis пропустил бы отозванную сессию. Поведение при сбоях описано в I51.
- **Refresh-токен выводится, а не хранится (I48).** Токен вычисляется HMAC-ом из секрета сервера и случайного `refresh_seed`. В базе нет ни токенов, ни их хэшей, поэтому утечка одной базы не даёт войти. При этом сервер распознаёт подлинный токен любого старого поколения, и это надёжно отличает кражу от подделки.
- **Как отличается гонка от кражи (I49).** Гонка — это повтор того же обмена (предыдущее поколение) не позже `SESSION_REFRESH_REUSE_GRACE_SECONDS` (60 с): возвращается та же пара. Всё остальное считается кражей, и сессия отзывается.
- **JWT без библиотеки (I47).** Используется `node:crypto` с одним допустимым заголовком. `jose` 6.2.12 распространяется только как ESM, а сервер собирается в CommonJS; это проверено через `npm view`.
- **Вид сессии задаёт `X-Client` (I46).** Запрос без заголовка получает `mobile`. Cookie-сессии получают `supplier_web` и `admin_web`; админка тоже хранит refresh-токен в cookie (I54).
- **CORS и чужие origin (I53).** Сервер сам отклоняет запросы с чужим `Origin`, а не только полагается на браузер.
- **Лимиты обмена (I55).** 600 обменов в час с одного IP и 30 в час на одну сессию. Для сессии считаются только обмены с подлинным токеном.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS
- `pnpm typecheck` — PASS
- `pnpm test` — PASS: domain 51, i18n 8, contracts 61, api-client 23, mobile 19, api 191.
- `pnpm test:integration` — PASS, 99 тестов в 4 файлах, из них 45 в новом `session.integration.test.ts`. Цикл миграций расширен до трёх миграций с откатом по одной.
- `pnpm build` — PASS, включая JS-бандл мобильного приложения. `apps/api/dist` не содержит `testing/`.
- `pnpm --filter @adclub/api openapi:check` — PASS.
- `openapi:compat --base HEAD` локально — PASS, «Contract is backward compatible». В CI — PASS относительно `cce16c3`, без трейлера.
- `pnpm --filter api migrate` на dev-базе — PASS; `migrate:status` показывает 3 применённые миграции.
- CI на `main`: run **35194274386** (коммит `d49e838`) — **success**, все шаги, получено через `gh run view`. Коммит с этим отчётом запускает новый прогон — см. ответ агента.

## UAT / E2E
Проверено на локальном `pnpm dev` (Windows, Docker dev compose) скриптами на `fetch`, которые выводили только результаты, без токенов.
- **Первый вход.** Запрос кода → код с `/dev/login-codes` → проверка с заголовком `X-Client: mobile/0.1.0 (ios)` → 200. В ответе поля `status, phone, accountId, session` (токены и сроки). `GET /auth/me` → 200, возвращён номер, `current: true`. Без токена → `AUTH_REQUIRED`.
- **Второе устройство.** Повторный вход (Android, после 60-секундного интервала) дал ту же учётную запись. В `GET /auth/sessions` две сессии, текущая отмечена.
- **Завершение с другого устройства.** `DELETE` второй сессии → `{ended:1,currentEnded:false}`. После этого у второй сессии и access, и refresh → `SESSION_ENDED`.
- **Обновление.** Токен ротирован, новый access работает. Старый refresh в течение 60 с вернул ту же пару. Отзыв сессии при позднем предъявлении старого токена проверен интеграционными тестами, а не в dev.
- **Гонка обновлений.** Три одновременных обмена → `[200,200,200]`, у всех один и тот же refresh-токен, сессия продолжает работать.
- **Кабинет и админка закрыты.** Запросы с `supplier-web/0.1.0` и `admin-web/0.1.0` → 403 `SESSION_KIND_UNAVAILABLE`.
- **Выйти везде.** `end-all` → `{ended:1,currentEnded:true}`. После этого access и refresh → `SESSION_ENDED`.
- **Redis упал** (`docker stop adclub-dev-redis-1`):
  - отозванная сессия → `SESSION_ENDED`;
  - действующая → 200;
  - обмен → 503 `SERVICE_UNAVAILABLE`, `retryable: true`.
  После `docker start` обмен прошёл со второй попытки, новый access → 200, отозванная сессия по-прежнему отклоняется. Сервер не перезапускался. Отказ PostgreSQL проверен интеграционным тестом.
- **CORS в реальном браузере** (Chrome headless, `--dump-dom`):
  - кабинет `:5175` показал «Связь с сервером есть»;
  - админка `:5174` показала ответ API (`api: ok`, `postgres: ok`, `redis: ok`); в журнале API видны `GET /ready 200 client=supplier-web/0.1.0` и `client=admin-web/0.1.0`;
  - страница с `http://localhost:5199` получила `BLOCKED TypeError`, в журнале — `Request refused: origin not allowed origin="http://localhost:5199"`.
- В журнале dev-сервера за всю проверку нет ни одного JWT и refresh-токена: `grep` по шаблонам нашёл 0 совпадений.
- Cookie-сессии кабинета и админки проверены только интеграционными тестами: экранов входа нет, а выдача этих сессий закрыта.

## Acceptance Criteria
- **AC-1 — PASS.** Тесты в `session.integration.test.ts`:
  - «creates one account on the first sign-in and finds it on the next» — одна строка `account`, тот же id при втором входе;
  - «converges concurrent first sign-ins…» — 10 параллельных `findOrCreateByPhone` дают один id и один `created`;
  - «gives exactly one session when the right code is entered concurrently» — 1 учётная запись и 1 сессия.
  Ручная проверка в dev: второе устройство получило тот же `accountId`.
- **AC-2 — PASS.**
  - Тест «returns the account, an access token…»: ключи ответа ровно `accountId, phone, session, status`, access-токен живёт 900 с, сессия — 90 дней.
  - Тест «creates no session for a wrong, repeated or expired code»: после неверного, повторного и просроченного кода в базе 1 сессия.
  - Тест TASK-004 проверяет прежние поля `toMatchObject({status, phone})`.
- **AC-3 — PASS.**
  - Тест «asks for sign-in…» перебирает 14 вариантов, в том числе: подделка `sub`/`exp`, `alg none`, чужой секрет, чужое окружение, неизвестная сессия, чужой `sub`/`knd`, refresh-токен вместо access, обрезанный токен. Все дают 401 `AUTH_REQUIRED` с `WWW-Authenticate`.
  - Тест «tells an expired access token…»: `ACCESS_TOKEN_EXPIRED`, после выхода — `SESSION_ENDED`.
  - Тест «serves public routes without a token».
  - Тест «answers an outdated client with 426…».
  - Unit-тесты в `session-tokens.test.ts`.
- **AC-4 — PASS.** Тесты группы `refresh`:
  - ротация с отзывом при `refresh_reuse`;
  - одинаковая пара в пределах периода повтора;
  - 5 одновременных обменов → 5×200 и один токен;
  - кража в обоих порядках;
  - подделка не трогает сессию;
  - скользящий срок мобильной сессии: продлена, затем истекла → `SESSION_ENDED`;
  - «never extends an admin session past 12 hours» — `sessionExpiresAt` не меняется, после срока → `SESSION_ENDED`, `absolute_expires_at = expires_at`.
- **AC-5 — PASS.** Тесты группы «the owner's sessions»:
  - в списке только свои сессии, есть `current`, `ipHint` вида `198.51.100.*`, полного IP в ответе нет;
  - завершение одной, всех кроме текущей, всех и выход;
  - запрос чужой сессии даёт тело и заголовки, идентичные ответу для несуществующей (404).
  Подтверждено ручной проверкой в dev.
- **AC-6 — PASS.** Тесты «keeps refusing an ended session… while Redis is down» и «refuses every token while PostgreSQL is down, and recovers without a restart» (PostgreSQL и Redis за TCP-прокси). Во всех тестах завершения доступ отклоняется сразу. Сценарий с Redis повторён вручную в dev (см. UAT).
- **AC-7 — PASS.**
  - Тест «refuses a supplier-web/admin-web sign-in without spending the code»: 0 сессий, код остаётся `active`, тем же кодом затем выполняется мобильный вход.
  - Cookie кабинета: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/auth/session`, `Max-Age` ≈ 180 дней, без `Domain`, refresh-токена в теле нет, контекст компании и сотрудника записан.
  - Явный выход очищает cookie.
  - Тест «refuses cookie requests that don't come from the cabinet itself» отклоняет: `Origin` чужого сайта, запрос без `Origin`, `Sec-Fetch-Site: cross-site`, cookie без Bearer, выход с чужого сайта. Сессия после этого не изменилась.
  - Тест админки на 12 часов.
- **AC-8 — PASS.**
  - Тесты группы `CORS`: preflight с `x-client, accept-language, authorization` проходит для трёх разрешённых origin; чужой origin не получает `ACAO` и получает 403, в том числе `Origin: null`; запросы без `Origin` и с собственным origin API работают; `Retry-After` и `X-Request-Id` доступны скрипту.
  - Unit-тесты разбора списков origin.
  - Реальный Chrome: оба веб-клиента работают, чужая страница заблокирована.
- **AC-9 — PASS.** Тесты «limits refreshes per session» и «per address» (429 `RATE_LIMITED`, указан `limit`, есть `Retry-After`) и «does not get in the way of ordinary use with the default limits».
- **AC-10 — PASS.**
  - Тест «never logged a token…» проверяет весь вывод процесса за интеграционный прогон: более 100 выданных токенов, их подписей и MAC-частей не найдено; шаблонов `eyJ…` и `rt1.…` нет; полного номера нет.
  - `expectError` в каждом тесте проверяет, что в теле ошибки нет токенов.
  - Тест «stores nothing a token could be rebuilt from…» (`row_to_json(session)`).
  - Тест «record every session event…» — события записаны, номер маскирован (`+7***4567`).
  - Unit-тест `database-error.test.ts`: параметры запроса не попадают в журнал.
  - В OpenAPI нет примеров токенов (тест в `openapi.test.ts`).
- **AC-11 — PASS.** `SessionSettingsSource` и `ConfigSessionSettingsSource` подключаются как провайдер в `IdentityModule`. Ключи есть в ARCHITECTURE 14 и `.env.example`. Тест `env.schema.test.ts` «reads lifetimes and refresh thresholds…».
- **AC-12 — PASS.** `openapi:check` и `openapi:compat` проходят локально и в CI run 35194274386 без трейлера (проверено: 0 трейлеров в `cce16c3..HEAD`). Сверка схемы с базой (`schema-drift.integration.test.ts`) проходит, `session` есть в `identityTables`. Методы `@adclub/api-client` проверены тестами.
- **AC-13 — PASS.** Правило добавлено в CLAUDE.md, раздел 11, подраздел «Состав коммитов (D-024)». Коммиты этой задачи (все с явным перечнем файлов, состав проверен через `git diff --cached --stat`):
  - `bce7fab` — 11 файлов `packages/contracts/src/*` и `packages/api-client/src/*`;
  - `0ba59f7` — 49 файлов: `apps/api/**`, `infra/migrations/1789627880146_create-session.sql`, `.env.example`;
  - `d49e838` — `ARCHITECTURE.md`, `CLAUDE.md`;
  - отдельный коммит с этим отчётом — `tasks/TASK-005-REPORT.md`.

  Правок Product Owner в рабочем дереве не было (`git status` по `PRODUCT.md`, `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/` — пусто), отдельного коммита для них не потребовалось.
- **AC-14 — PASS.** Run 35194274386 для `d49e838` — `completed/success`, все шаги (format, lint, typecheck, test, integration, build, openapi check, compat, graceful shutdown). Результат для коммита с отчётом — см. ответ агента.
- **AC-15 — PASS.** ARCHITECTURE.md обновлён: версия 0.9 и история; раздел 4.6; уточнения 1, 4.1 I6, 5.1, 8.2, 8.3, 14. В CLAUDE.md, блок 0, есть шаги получения сессии и вызова `/auth/me` в dev, а также переменные `SESSION_*` и `*_WEB_ORIGINS`.

## Errors & Fixes
- **Путь с параметром.** Nest 12 (path-to-regexp v8) читает `{sessionId}` как необязательную группу. `ApiRoute` теперь переводит путь в `:sessionId` (`toNestPath`); тот же перевод использует сверка маршрутов.
- **Утечка параметров запросов в журнал.** `DrizzleQueryError` включает значения параметров в текст ошибки, поэтому при сбое базы в журнал попадали бы номер телефона и seed. Исправлено функцией `withoutQueryParameters` (глобальный фильтр и сервис сессий). Эта проблема существовала и для кодов входа TASK-004.
- **Два ожидания в тестах.** Access-токены, подписанные в одну секунду с одинаковыми claims, совпадают. Access-токен длиннее лимита тела refresh и получает 400. Исправлены ожидания тестов, не поведение.
- **Лимит в dev-скрипте проверки.** Отклонённые запросы кода тоже считаются в лимит 5 в час на номер (TASK-004), и скрипт упёрся в него. Проверку Redis провёл на других номерах.
- **Переводы строк.** Правки через Python на Windows записали CRLF. Перед коммитом все файлы нормализованы к LF, итоговый diff содержательный.
- **ESLint `prefer-const` в тесте клиента** — исправлено.

## Deviations
- **Чёрного списка в Redis нет** (ARCHITECTURE 8.2, 8.3 и строка CLAUDE.md о Redis). Мгновенный отзыв реализован проверкой PostgreSQL на каждом запросе. Причина — I51. Документы уточнены.
- **Поля `session` отличаются от 5.1.** Вместо `refresh_hash` — `refresh_seed` и номер поколения; вместо `context` (json) — колонки `supplier_id` и `supplier_member_id`; вместо `device_label` — `device_name` плюс платформа и версия.
- **Access-токен без ролей.** 8.2 предполагал роли в токене; ролей пока нет (TASK-006), и они будут проверяться на сервере.
- **Админская сессия тоже хранит refresh-токен в cookie.** Задача явно требовала cookie только для кабинета.
- **Поведение старого refresh-токена в течение 60 с.** Он «работает» в том смысле, что возвращает ту же пару, а не новую. Отказ и отзыв наступают после периода повтора (I49). Если нужно строгое «сразу не работает», задаётся `SESSION_REFRESH_REUSE_GRACE_SECONDS=0`, но тогда одновременные обмены одного клиента будут завершать его сессию.
- **Файла `tasks/TASK-005.md` в репозитории нет.** Задача получена в сообщении, агент файл не создавал.
- **Статус учётной записи не проверяется.** `account.status` (blocked) не учитывается при входе и доступе: блокировка учётной записи вынесена из задачи.

## Known Issues / Risks
- `SESSION_TOKEN_SECRET` нужно сгенерировать для staging/production и хранить как секрет. Смена секрета завершает все сессии; поддержки предыдущего секрета нет.
- `SUPPLIER_WEB_ORIGINS` и `ADMIN_WEB_ORIGINS` в staging/production по умолчанию пусты: без настройки веб-клиенты получат 403. Нужно задать при развёртывании (TASK-055/026).
- Cookie помечена `Secure`. Chrome и Firefox принимают её на `http://localhost`; Safari не проверялся.
- Недоступность PostgreSQL сразу делает все защищённые маршруты 503. Недоступность Redis в течение более 15 минут не даёт обновить токены (503, клиент повторяет).
- **Обмен токена лимитирован по IP (600 в час).** При CGNAT много абонентов оказываются за одним адресом. Порог вынесен в настройки, его стоит пересмотреть в TASK-055.
- Выход логически отдельный на каждом клиенте: клиентских экранов, очистки данных при `SESSION_ENDED` (TASK-029) и автоматического обмена токена в `@adclub/api-client` пока нет.
- `Session created` пишется в журнал внутри транзакции входа, до её фиксации. После этой записи выполняется только фиксация.
- Очистки истёкших и отозванных сессий нет (TASK-008).

## Remaining Work
None.

## Future Improvements
- Автоматический обмен токена при `ACCESS_TOKEN_EXPIRED` в `@adclub/api-client`, с единственным одновременным обменом на клиента (вместе с экранами входа).
- Поддержка предыдущего `SESSION_TOKEN_SECRET` для ротации секрета без массового выхода.
- Кэш проверки сессий, если нагрузка это потребует. Он допустим только при инвалидации от источника истины (I51).
- Проверка `account.status` при входе и доступе — вместе с задачей о блокировке.
- Список сессий поставщика и пользователя для администратора (8.2), отзыв администратором.
- Проверка cookie-сессии в Safari и E2E кабинета (Playwright) после появления экранов входа.

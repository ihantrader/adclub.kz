# TASK REPORT — TASK-003

## Status
COMPLETED — 9/9 AC. Единственное, что не проверено: запуск на телефоне. Его выполняет Product Owner через Expo Go, как и предусмотрено задачей.

## Result
- **Единый контракт.** В `@adclub/contracts` появился реестр маршрутов `apiRoutes`. По нему работают три вещи:
  - сервер привязывает обработчики через `@ApiRoute`;
  - из него генерируется OpenAPI 3.1 — файл `apps/api/openapi.json` лежит в git, в dev его отдают `/openapi.json` и Swagger UI `/docs`;
  - из него построен типизированный клиент `@adclub/api-client`.
- **Проверка маршрутов.** Сервер сверяет маршруты, которые реально обслуживает, с реестром. Расхождение в любую сторону — ошибка в тестах и в CI.
- **Версия клиента.** Все три клиента передают в каждом запросе заголовок `X-Client`:
  - `mobile/<версия> (ios|android)`;
  - `admin-web/<версия>`;
  - `supplier-web/<версия>`.

  Запрос без заголовка или с «мусором» обслуживается как запрос от неизвестной версии. В журнал доступа пишется `client=missing` или `client=invalid`.
- **Политика клиента.** `GET /meta/client-policy` отдаёт минимальную версию по каждой платформе и текст об обновлении на языке из `Accept-Language` (kk/ru/en).
  - Если версия известного клиента ниже минимума, любой маршрут, кроме `/health` и политики, отвечает HTTP 426 в едином формате ошибки с кодом `CLIENT_UPDATE_REQUIRED`.
  - Значения задаются переменными `CLIENT_MIN_VERSION_*` и `CLIENT_UPDATE_MESSAGE_*`.
  - Точка замены — провайдер `ClientPolicySource`; в TASK-007 его заменит таблица настроек.
- **Реакция клиентов.** Админка и кабинет поставщика при коде `CLIENT_UPDATE_REQUIRED` показывают текст с сервера и кнопку «Обновить страницу».
- **Мобильное приложение (долг T-4 закрыт).**
  - Использует `contracts`, `domain`, `i18n` и `api-client`.
  - При старте запрашивает политику. Экран «Нужно обновление» появляется только по явному ответу сервера: версия ниже минимума в политике или ответ 426 на любой запрос.
  - Если сервер недоступен, приложение открывается как обычно.
  - Главный экран показывает, есть ли связь с сервером.
- **CI.** Добавлены три проверки:
  - `openapi.json` актуален;
  - нет ломающих изменений контракта относительно `main` (oasdiff);
  - JS-бандл мобильного собирается для iOS и Android.

## Changes
- **`packages/contracts`:**
  - `client.ts` — платформы, формат и разбор `X-Client`;
  - `client-policy.ts`;
  - `routes.ts` — `apiRoutes` и тип ответа маршрута;
  - `openapi.ts` — `buildOpenApiDocument`;
  - `error.ts` — код `CLIENT_UPDATE_REQUIRED` и схема `details`.
- **`packages/api-client` (новый):** `createApiClient`, `ApiError`, тесты.
- **`packages/domain`:** `version/app-version.ts` — разбор и сравнение версий `MAJOR.MINOR.PATCH`.
- **`packages/i18n`:** `pickLanguage` (разбор `Accept-Language`), строки для экрана обновления и статуса связи, тест одинаковости ключей во всех трёх языках.
- **`packages/{contracts,domain,i18n,api-client}/package.json`:** первым условием в `exports` добавлено `"adclub-source": "./src/index.ts"`.
- **`apps/api`:**
  - `src/client-policy/` — источник значений, сервис, контроллер, глобальный `ClientVersionGuard`, модуль, e2e-тест;
  - `src/common/client/` — разбор заголовка на запрос;
  - `src/common/contract/` — `@ApiRoute` и `listServedRoutes`;
  - `src/common/errors/client-update-required.exception.ts`, фильтр ошибок доработан (426);
  - `src/common/logging/access-log.middleware.ts` — заменил `LoggingInterceptor`;
  - `src/openapi/` — dev-контроллер `/openapi.json` и `/docs`, сверка маршрутов, e2e-тест полного `AppModule`;
  - `src/config/env.schema.ts` — переменные политики;
  - `health`/`ready` переведены на `@ApiRoute`;
  - скрипты `openapi.ts` (generate/check) и `check-openapi-compat.ts`, файл уровней `openapi-compat-levels.txt`, артефакт `openapi.json`.
- **`apps/admin-web`, `apps/supplier-web`:**
  - `src/api.ts` — клиент и хранилище состояния «требуется обновление»;
  - `App.tsx` — ручные `fetch` удалены. Админка показывает health и готовность зависимостей, кабинет — статус связи;
  - `vite.config.ts` — версия приложения из `package.json` через `__APP_VERSION__`.
- **`apps/mobile`:**
  - `metro.config.js` — условие `adclub-source`;
  - `src/update-gate/` — логика экрана политики и тесты;
  - `src/config/` — адрес API, версия, платформа, язык;
  - `src/services/api.ts`;
  - `src/screens/` — `HomeScreen` и `UpdateRequiredScreen`;
  - `App.tsx`;
  - `vitest.config.ts`, `.env.example`;
  - скрипты `build` (`expo export` для iOS и Android) и `test`;
  - зависимость `expo-constants` установлена через `expo install`.
- **`.github/workflows/ci.yml`:** `fetch-depth: 0`, шаги «OpenAPI document is up to date…» и «API contract is backward compatible». Мобильный бандл собирается внутри шага Build.
- **Прочее:** `.env.example` (переменные политики), `.prettierignore` (`apps/api/openapi.json` — генерируемый), тестовые конфиги в `json-logger.service.test.ts` и `database.integration.test.ts` теперь строятся через `loadConfig`.
- **Документы:** `ARCHITECTURE.md` (версия 0.7), `CLAUDE.md` (блок «0. Проект»).

## Technical Decisions
Все решения внесены в ARCHITECTURE.md, раздел 4.4 (I24–I31); уточнены разделы 3.5, 4, 4.1 I2, 4.2 I13/I18/I20, 7.2 и 7.4.

- **Контракт — реестр маршрутов в `contracts` (I24).** OpenAPI строится средствами zod 4 без новых зависимостей. `additionalProperties: false` из документа убран: иначе он запрещал бы аддитивные поля в ответах.
- **Сверка с фактическими маршрутами (I25).** Скрипт и e2e-тест поднимают настоящий `AppModule` и читают роутер Express.
- **Клиент выводится из реестра, а не генерируется из OpenAPI (I26).** Сгенерированного кода, который мог бы устареть, нет. Успешные ответы клиент намеренно не перепроверяет схемой, чтобы аддитивные изменения сервера не ломали старые версии.
- **HTTP 426 и заголовок `X-Client` по формату ARCHITECTURE 7.4 (I27).** Ответ политики сокращён: `latestVersion` и `forceUpdate` не добавлены (обоснование в 7.4 и в разделе «Deviations»).
- **Совместимость проверяет oasdiff в Docker (I28).** Образ закреплён: `tufin/oasdiff:v1.32.1`. Уровни двух проверок скорректированы под правила 7.4:
  - удаление необязательного поля ответа — ошибка (по умолчанию oasdiff его не ловит; проверено);
  - новое значение enum в ответе — допустимо (по умолчанию oasdiff считает это ошибкой).

  Осознанный breaking change оформляется трейлером коммита `Contract-Breaking-Change: <причина>`.
- **Общие пакеты в Metro — через условие экспорта `adclub-source` (I29).** Сборка пакетов (CommonJS), Node, Vite и tsc не изменились. TypeScript 6.0.3 в мобильном сохранён: типы пакетов он читает из `dist`.
- **Журнал доступа перенесён в middleware (I30).** Guard срабатывает раньше interceptor, поэтому ответы 426 раньше не попадали бы в журнал.

## Verification
Локально (Windows 11, Node 24, Docker Desktop):
- `pnpm format:check` — PASS
- `pnpm lint` — PASS, 10/10 задач
- `pnpm typecheck` — PASS, 15/15
- `pnpm test` — PASS, тестов по пакетам:

  | Пакет | Тестов |
  |---|---|
  | domain | 19 |
  | i18n | 8 |
  | contracts | 31 |
  | api-client | 13 |
  | api | 77 |
  | mobile | 19 |

- `pnpm test:integration` — PASS, 8 тестов (Testcontainers)
- `pnpm build` — PASS, 10/10. Бандлы: iOS — 705 модулей, Android — 703, Hermes `.hbc` около 2,1 МБ каждый.
- `pnpm --filter @adclub/api openapi:check` — PASS: «matches the contract and the served routes»
- `pnpm --filter @adclub/api openapi:compat` (база `origin/main`) — PASS: на базе файла ещё нет, проверка пропущена с сообщением
- `pnpm --filter @adclub/api verify:graceful-shutdown` — FAIL локально, ожидаемо: Windows не доставляет SIGTERM (ARCHITECTURE 4.3 I22). В CI на Linux — PASS.
- Экспорт мобильного бандла при временно переименованных `dist` всех четырёх пакетов — PASS. В source map есть `packages/{contracts,domain,i18n,api-client}/src/*.ts`, значит Metro берёт исходники.

GitHub Actions (статусы получены через `gh run watch` и `gh run view`):
- **Run 35145160711** (push в `main`, коммит `b684047`) — **success.** Все шаги зелёные, включая Build (iOS 704 и Android 703 модуля на Linux), OpenAPI check, compatibility (пропущена: базы нет) и SIGTERM worker.
- **Run 35145444253** (PR #1, ломающее изменение) — **failure** на шаге «API contract is backward compatible»: `[response-required-property-removed] … removed the required property timestamp`. Все предыдущие шаги зелёные.
- **Run 35145690259** (PR #1, откат и аддитивное поле) — **success**: «Contract is backward compatible with origin/main».
- Прогон CI для коммита с этим отчётом — ссылка в ответе агента после push.

## UAT / E2E
Окружение: локальная машина, `docker compose` (PostgreSQL, Redis, MinIO, Meilisearch), API в режиме `pnpm --filter @adclub/api dev` (tsx watch), админка через Vite dev, браузер — headless Chrome (`--dump-dom`, `--screenshot`).

- **Живой API под `pnpm dev`** — PASS:
  - `/health` для клиента `mobile/0.0.1 (ios)` → 200;
  - `/meta/client-policy` с `Accept-Language: kk` → минимальные версии и текст на казахском;
  - `/ready` с `admin-web/0.1.0` → 200;
  - `/ready` с `X-Client: }{garbage` → 200 и предупреждение в журнале с `client=invalid`;
  - `/openapi.json` и `/docs` → 200;
  - CORS preflight с `Access-Control-Request-Headers: x-client` → `Access-Control-Allow-Headers: x-client`.
- **«Старый клиент»** — PASS:
  1. По умолчанию админка показывает «api: ok» и `postgres/redis/s3: ok`. В журнале сервера — `client=admin-web/0.1.0`.
  2. API перезапущен с `CLIENT_MIN_VERSION_ADMIN_WEB=0.2.0` и `CLIENT_MIN_VERSION_IOS=1.1.0`. Админка показывает блок «Нужно обновление» с текстом сервера и кнопкой «Обновить страницу»; health по-прежнему «ok»; в журнале — `GET /ready 426 … client=admin-web/0.1.0`.
  3. curl: `mobile/1.0.0 (ios)` → 426, `mobile/1.0.0 (android)` → 200 — минимумы по платформам разные.
  4. Значение возвращено (переменная снята, API перезапущен) → админка снова показывает зависимости, блока обновления нет.
- **«Ломающее изменение»** — PASS. Воспроизведено в CI через черновой PR #1 (раздел «Verification»), локально — тем же набором: `openapi:check` падает на устаревшем файле, `openapi:compat --base HEAD` падает, трейлер `Contract-Breaking-Change` снимает блокировку, аддитивное поле проходит. PR #1 закрыт без слияния, ветка удалена.
- **Подготовка к проверке на телефоне** — частично проверено без телефона:
  - `expo start` отдаёт манифест с `hostUri: 172.20.10.4:8081`, из него приложение вычисляет адрес API `http://172.20.10.4:3000`;
  - по этому адресу API отвечает (проверено с этой же машины);
  - dev-бандл Android (около 4,9 МБ) скачивается по LAN-адресу;
  - API слушает все интерфейсы (`::`:3000);
  - в брандмауэре Windows есть разрешающие правила для `C:\program files\nodejs\node.exe` (TCP, профили Private и Public).

  С телефона и в Expo Go ничего не запускалось — нет устройства.

**Как Product Owner проверит на телефоне:**
1. Телефон и компьютер — в одной Wi-Fi-сети. Если Windows спросит про доступ Node.js к сети, разрешите его для частной сети. Сеть Wi-Fi лучше пометить как «Частную».
2. Выполните `docker compose -f infra/docker/compose.dev.yml up -d`, затем `pnpm install` и `pnpm --filter @adclub/api dev`.
3. Во втором терминале выполните `pnpm --filter @adclub/mobile start` и отсканируйте QR-код в Expo Go. Должно отобразиться «adclub.kz — Связь с сервером есть» и внизу `ios|android 1.0.0 · http://<IP>:3000`.
4. Добавьте в `.env` `CLIENT_MIN_VERSION_ANDROID=1.1.0` (или `CLIENT_MIN_VERSION_IOS=1.1.0` — для вашего телефона), перезапустите API, полностью закройте и заново откройте приложение. Должен появиться экран «Нужно обновление» с текстом сервера.
5. Остановите API и снова перезапустите приложение. Должен открыться обычный экран со статусом «Нет связи с сервером» и кнопкой «Повторить», без экрана обновления.
6. Если телефон не достаёт до API (например, изолированная гостевая сеть), укажите адрес явно в `apps/mobile/.env`: `EXPO_PUBLIC_API_URL=http://<IP компьютера>:3000`.

## Acceptance Criteria
- **AC-1 — PASS.**
  - `apps/api/openapi.json` — `"openapi": "3.1.0"`, пути `/health`, `/ready`, `/meta/client-policy`, у каждой операции `default` → `ApiErrorResponse`, у `/ready` — 426.
  - Тесты `packages/contracts/src/openapi.test.ts` (7) и `apps/api/src/openapi/contract-routes.e2e.test.ts` (сверка с маршрутами полного `AppModule`).
  - Изменение схемы (удалён `timestamp`) → `openapi:check` сообщил «out of date», после `openapi:generate` diff показал удаление свойства. То же — в коммите `8760f9d` PR #1.
- **AC-2 — PASS.**
  - `apps/admin-web/src/api.ts`, `apps/supplier-web/src/api.ts`, `apps/mobile/src/services/api.ts` используют `createApiClient`.
  - `grep fetch(` по `apps/*/src` находит только определение клиента в `packages/api-client`.
  - В реальном браузере запросы админки пришли на сервер с `client=admin-web/0.1.0`.
- **AC-3 — PASS.**
  - Заголовок формирует `formatClientHeader` (тест `create-api-client.test.ts`), в журнале видны `client=admin-web/0.1.0` и `client=mobile/…`.
  - Без заголовка → 200 и `client=missing`; с мусором → 200 и `client=invalid` (e2e-тест `client-policy.e2e.test.ts` и живой curl).
- **AC-4 — PASS.**
  - e2e-тест `client-policy.e2e.test.ts` (15 тестов): политика и локализация; 426 с `details`; health и политика доступны устаревшему клиенту; разные минимумы iOS и Android; повышение минимума действует со следующего запроса.
  - Живой curl: `/ready` → 426 с `{"code":"CLIENT_UPDATE_REQUIRED",…,"retryable":false}`, `/health` → 200.
- **AC-5 — PASS.** Run 35145444253 — failure на шаге совместимости (удалено поле); run 35145690259 — success (откат и аддитивное поле).
- **AC-6 — PASS.**
  - `apps/mobile/package.json` зависит от `@adclub/contracts`, `@adclub/domain`, `@adclub/i18n`, `@adclub/api-client`.
  - В source map бандла — их исходники.
  - Run 35145160711, шаг Build: «iOS Bundled … (704 modules)», «Android Bundled … (703 modules)».
- **AC-7 — PASS.** `apps/mobile/src/update-gate/update-gate.test.ts` (13 тестов через настоящий `createApiClient` с поддельной сетью):
  - версия ниже минимума → экран с текстом сервера;
  - версия в порядке → экрана нет;
  - сервер недоступен → экрана нет;
  - дополнительно: ошибка сервера, нечитаемая политика, загрузка, 426 во время работы, «Проверить снова» офлайн и после снижения минимума, гонка ответов.
- **AC-8 — PASS.** Run 35145160711 (`main`, `b684047`) — success, получено через `gh run watch --exit-status` (код выхода 0). Прогон для коммита с отчётом — в ответе агента.
- **AC-9 — PASS.** ARCHITECTURE.md 0.7: раздел 4.4 (I24–I31) и отметки в 3.5, 4, 4.1, 4.2, 7.2, 7.4. В CLAUDE.md обновлён блок «0. Проект»: структура, dev и телефон, команды OpenAPI, тесты, build, миграции (прежняя запись о миграциях устарела ещё после TASK-002).

## Errors & Fixes
- **Catch-all 404 ломал сверку маршрутов.** Nest 12 и Express 5 регистрируют `@All("*")` как `/{*path}` отдельно на каждый HTTP-метод, поэтому первая сверка нашла 30+ «лишних» маршрутов. Теперь catch-all распознаётся по пути (I25).
- **Отказы guard'а не попадали в журнал.** Guard выполняется раньше interceptor, так что ответ 426 не был бы залогирован. Журнал доступа перенесён в middleware, есть тест на строку журнала для 426 (I30).
- **oasdiff и правила 7.4 расходились.** По умолчанию oasdiff не считает ломающим удаление необязательного поля ответа, а новое значение enum считает ошибкой. Уровни скорректированы; комментарии в файле уровней формат не допускает (проверено), поэтому пояснения перенесены в скрипт.
- **Правило ESLint `react-hooks/set-state-in-effect`.** Сброс состояния «загрузка» перенесён из эффекта в обработчики кнопок — так в проекте уже было принято.
- **ESLint на `metro.config.js`.** Это CommonJS-файл Node; для него добавлен блок конфигурации с `sourceType: commonjs`.
- **Тестовые `AppConfig` без новых полей.** Два теста собирали конфиг вручную и сломались после добавления политики. Теперь конфиг строится через `loadConfig`, и будущие поля их не заденут.
- **`URL.hostname` в React Native.** Разбор `hostUri` сделан регулярным выражением, потому что полифилл RN реализует `hostname` не во всех версиях. На устройстве это не проверялось.

## Deviations
- **Кабинет поставщика до задачи health не запрашивал.** В разделе «Текущее состояние» TASK-003 сказано, что `supplier-web` использует `contracts` для health, но фактически он не делал ни одного запроса к API. Теперь кабинет запрашивает `/ready` через общий клиент и показывает статус связи.
- **Ответ политики короче, чем в ARCHITECTURE 7.4.** Сделано `{ platforms: {…: { minSupportedVersion }}, message }`, без `latestVersion` и `forceUpdate`: TASK-003 требует только минимальные версии и текст, а поля добавятся аддитивно. Отмечено в 7.4.
- **`/ready` проверяет минимальную версию.** TASK-003 исключает из проверки только health и политику. Пробы без `X-Client` при этом не блокируются.
- **Неизвестный маршрут для устаревшего клиента отвечает 426, а не 404.** Это следует из формулировки «на любой запрос, кроме политики и health».
- **Снимки схем по опубликованным версиям (ARCHITECTURE 7.2) не сделаны.** Опубликованных версий пока нет; их роль выполняет сравнение с `main`.

## Known Issues / Risks
- **Запуск на телефоне и эмуляторе не выполнялся** (долг T-2). Выполнение бандла в Hermes на устройстве, фактический доступ телефона к API через Wi-Fi и брандмауэр, а также полифиллы RN (`AbortController`, `Object.hasOwn`, `Intl`) не подтверждены. Бандл компилируется в Hermes-байткод без ошибок.
- **Изменение минимальной версии требует перезапуска API** — до TASK-007.
- **Для проверки совместимости нужен Docker** (локально и в CI; на `ubuntu-latest` он есть). Образ oasdiff скачивается из Docker Hub при каждом прогоне CI.
- **Поддержка OpenAPI 3.1 в oasdiff.** На текущем документе все проверенные случаи классифицируются верно, но более сложные конструкции JSON Schema (`oneOf`, `anyOf`) пока не встречались.
- **Swagger UI `/docs` грузит скрипты с `cdn.jsdelivr.net`.** Работает только в dev; в production маршрут не регистрируется (проверено тестом).
- **CORS по-прежнему разрешает любой origin** (T-1, TASK-005). Заголовок `X-Client` проходит preflight.
- **Предупреждение pnpm `react-dom 19.3.0 … unmet peer react@^19.3.0: found 19.2.3`** в `apps/mobile` существовало до задачи (Expo подтягивает `react-dom` как peer) и на работу не влияет.
- **Проверка SIGTERM worker локально на Windows падает по таймауту** — ограничение платформы (I22); в CI на Linux проходит.

## Remaining Work
None по AC. Проверку на телефоне выполняет Product Owner — инструкция в разделе «UAT / E2E».

## Future Improvements
- **Снимки контракта по опубликованным версиям мобильного** (ARCHITECTURE 7.2) — вместе с первой публикацией в сторах.
- **`latestVersion` и экран «доступно обновление»** — мягкое уведомление в дополнение к принудительному.
- **Ссылка на магазин на экране обновления** — когда появятся App Store и Google Play ID.
- **Кэш политики на устройстве.** Экран обновления мог бы показываться и офлайн после явного ответа сервера; сейчас состояние живёт только до перезапуска приложения.
- **Компонентные тесты React Native** (`@testing-library/react-native` и `jest-expo`) — с первыми реальными экранами (TASK-027).
- **Общий компонент уведомления об обновлении для веба** в `@adclub/ui`, когда веб-клиентов с этой логикой станет больше.

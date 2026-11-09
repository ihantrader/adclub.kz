# TASK REPORT — TASK-056

## Status
PARTIAL — часть A выполнена целиком (AC-1…AC-8, AC-10); часть B (AC-9: сборки EAS, TestFlight, Google Play, проверки на телефонах, OTA на устройстве) — **BLOCKED**: нет учётных записей Product Owner (список ниже).

## Result
- Приложение называет серверу версию **установленной сборки** (`expo-application`), а не манифеста OTA-обновления; в Expo Go и браузере — `app.json`, как раньше. Одна чистая функция `appVersionOf` с тестом.
- OTA: `expo-updates`, `runtimeVersion: { policy: "appVersion" }`, проверка при старте и возврате из фона (не чаще раза в 15 минут), загрузка молча, применение при следующем запуске, заставка не ждёт. M-PRO-06 и подвал профиля — «1.0.0 · обновление a1b2c3d» (без OTA — «1.0.0»).
- Нативная конфигурация: `kz.adclub.app` на обеих платформах, `UIBackgroundModes: remote-notification`, плагины `expo-updates`, `expo-task-manager`, `app.config.js` (projectId → `updates.url`, `GOOGLE_SERVICES_JSON` → `googleServicesFile`), `eas.json` с профилями `development`/`preview`/`production` и каналами EAS Update, без адресов и секретов; номера сборок ведёт EAS (`appVersionSource: remote`). Проверка без учётных записей — `pnpm --filter mobile native:check` и задача CI `mobile-native`.
- Push на iPhone — **APNs напрямую** (`ApnsPushProvider` на `node:http2`, JWT ES256), Android — FCM; выбор по платформе устройства — `PlatformPushRouter`; `PUSH_PROVIDER=test|live` (`live` требует и `FCM_*`, и `APNS_*`; production не стартует с `test` и с `APNS_ENVIRONMENT=sandbox`).
- Сообщение FCM теперь **только `data`** — так `expo-notifications` сам рисует уведомление и вызывает фоновую задачу.
- Фоновый ack: задача `expo-notifications` через `expo-task-manager` (только собственная сборка) подтверждает push при закрытом приложении; неудачные подтверждения ждут в очереди на устройстве.
- Снимки контракта по опубликованным версиям: `apps/api/contract-snapshots/mobile/1.0.0.openapi.json` + `supported.json`, команда `pnpm release:mobile:snapshot <version>`, `openapi:compat --base-file` / `--snapshots`, шаг CI.
- Ссылки на страницы приложения в сторах: настройки `client_store_url_ios|android` → `GET /meta/client-policy` `platforms.<p>.storeUrl` (аддитивно) → кнопка M-START-03; пусто — прежний поиск по названию; строки в «Настройки → Политика клиента».
- Долги I866 закрыты: холодный старт из push ждёт чтения сессии; выход без сети завершается при появлении сети; ack с 4xx не повторяется; одновременные регистрации токенов одной сессии — без 500.

## Changes
**Сервер (`apps/api`)**
- `src/modules/notifications/apns-push-provider.ts` (новый) — APNs: http2-соединение с переиспользованием и закрытием по простою, токен провайдера 50 минут, исходы по `reason`, повтор после `InvalidProviderToken`/`ExpiredProviderToken`.
- `platform-push-router.ts` (новый); `push-provider.ts` — `PushChannelName` (`test|fcm|apns`), `providerFor(platform)` вместо поля `provider`; `push-sender.ts`, `test-push-provider.ts`, `fcm-push-provider.ts` (data-only), `schema.ts`, `notifications.module.ts` (выбор `live`, закрытие соединения APNs), `index.ts`.
- `notifications.service.ts` — `registerToken` блокирует строку сессии (`FOR UPDATE`).
- `src/config/env.schema.ts` — `PUSH_PROVIDER=test|live` (прежнее `fcm` — отказ с подсказкой), `APNS_*`, `APNS_API_URL` только dev.
- `infra/migrations/1791850000000_push-apns.sql` — `notification_delivery.provider` допускает `apns`; `src/testing/expected/migrations.ts`.
- `src/client-policy/*`, `packages/contracts/src/client-policy.ts` (+ `index.ts`, `openapi.ts`) — `MobilePlatformPolicy.storeUrl`; `src/modules/settings/registry/registry.ts` — две настройки, новые описания минимумов.
- `src/contract-snapshots/contract-snapshots.ts` (+ тест), `scripts/check-openapi-compat.ts` (режимы `--base-file`, `--snapshots`, `--trailers-since`), `scripts/mobile-release-snapshot.ts`, `contract-snapshots/mobile/{1.0.0.openapi.json,supported.json}`, `openapi.json`, `package.json` (скрипт), корневой `package.json` (`release:mobile:snapshot`), `.prettierignore`.
- Тесты: `apns-push-provider.test.ts` (новый), `fcm-push-provider.test.ts`, `env.schema.test.ts`, `client-policy.e2e.test.ts`, `notifications.integration.test.ts` (десять одновременных регистраций).

**Приложение (`apps/mobile`)**
- `app.json`, `app.config.js` (новый), `eas.json` (новый), `package.json` (`expo-application`, `expo-updates`, `expo-task-manager`, `expo-dev-client`; патч-выравнивание `expo install --fix`; скрипт `native:check`), `scripts/check-native-config.mjs` (новый), `eslint.config.js`, `index.ts`.
- `src/config/app-version.ts` (+ тест), `environment.ts`; `src/services/ota-update-rule.ts` (+ тест), `ota-updates.ts`; `src/start/AppStart.tsx`.
- `src/push/push-ack.ts` (+ тест), `background-ack-task.ts` (+ тест проводки), `cold-start.ts`; `src/state/push-provider.tsx`, `stores.ts` (`pendingAcksStore`, `pendingLogoutStore`), `pending-logout.ts` (+ тест, туда же тест холодного старта), `session-provider.tsx`; `src/services/pending-logout.ts`, `session-fetch.ts` (экспорт обмена).
- `src/update-gate/update-gate.ts` (+ тест), `src/screens/UpdateRequiredScreen.tsx`, `screens/profile/DocumentsScreen.tsx`, `screens/tabs/ProfileScreen.tsx`; `packages/i18n/src/mobile/{ru,kk,en}.json` — `profile.versionWithUpdate`.

**Прочее:** `apps/admin-web/src/settings/{setting-rules.ts,ClientPolicy.tsx}`; `.github/workflows/ci.yml` (шаг снимков в `checks`, задача `mobile-native`, итог `ci`); `.env.example`; `ARCHITECTURE.md` 0.90; `CLAUDE.md` блок 0; `pnpm-lock.yaml`.

## Technical Decisions
Все внесены в ARCHITECTURE.md 0.90, раздел 4.81 (I880–I892), с правками 7.2, 7.4, 9.3, 14, 15.1, I854, I855, I862, I866, I878.
- **APNs напрямую, а не Firebase SDK в iOS-сборке** (I883) — как I854: без SDK, на `node:http2`; данные push — на верхнем уровне и под `body`.
- **Один маршрутизатор по платформе** (I884); `fcm` переименован в `live` с отказом старого значения — оно отправляло iOS через FCM, что не работает.
- **FCM — только `data`** (I885): с блоком `notification` Android рисует уведомление сам и JS (а значит и фоновая задача) его не видит; data-only `expo-notifications` рисует по `message` в канале `default` и вызывает задачу (решено по исходникам SDK: `ExpoHandlingDelegate`).
- **Снимок — весь `openapi.json`** (I886), а не выборка «используемых» схем: надёжно вычислить, что читает старый клиент, нельзя.
- **Патч-отставание пакетов в `expo-doctor` — предупреждение, не красный CI** (I890): Expo выпускает патчи SDK постоянно.
- **`ITSAppUsesNonExemptEncryption` не выставлен** — это юридическое заявление (решение Product Owner); без него App Store Connect спрашивает об экспорте шифрования при каждой загрузке.

## Verification
- `pnpm format:check` — PASS — «All matched files use Prettier code style!»
- `pnpm lint` — PASS — 0 ошибок; одно предупреждение `isNotNull` в `apps/api/src/modules/ratings/supplier-ratings.service.ts` — было до задачи, файл не трогался.
- `pnpm typecheck` — PASS — 20/20.
- `pnpm test` — PASS после исправления — первый прогон упал на `registry.test.ts` («ключи раздела 14»: мой текст в ARCHITECTURE 14 сбил разбор строки), исправлено; итоговый прогон (после правок ревью): 19/19 задач, API 69 файлов / 977 тестов, мобильное 55 файлов / 606 тестов.
- `pnpm build` — PASS — 12/12 (включая `expo export` iOS и Android), повторён после правок ревью.
- `pnpm --filter @adclub/api openapi:check` — PASS — «matches the contract and the served routes».
- `openapi:compat --base origin/main` — PASS — «backward compatible with origin/main» (контракт аддитивен: `storeUrl`).
- `openapi:compat --snapshots` и `--base-file contract-snapshots/mobile/1.0.0.openapi.json` — PASS — «Compatible with every supported app version: 1.0.0».
- `pnpm --filter mobile native:check` — PASS (Windows: Android; iOS — в CI) — вывод ниже.
- `npx expo-doctor@1` — PASS — «21/21 checks passed» (после `expo install --fix`; до него — 10 пакетов на патч позади SDK).
- Интеграционные: `notifications.integration.test.ts` — PASS — 17 тестов (с новым тестом гонки), 211 с; `database.integration.test.ts` + `schema-drift.integration.test.ts` + `settings.integration.test.ts` — PASS — 77 тестов (после добавления теста миграции `push-apns` и двух `down` в тестах, где `up` посреди возвращает поздние миграции; первый прогон — 50 падений из-за этого сдвига).
- Юнит `apns-push-provider.test.ts` — PASS — 19 тестов на локальном HTTP/2-сервере (сертификат делает `openssl` в тесте).
- Независимое ревью кода (отдельный агент, без моих выводов) — 10 находок; исправлены 8 (ниже, «Errors & Fixes»), 2 оставлены с обоснованием (ARCHITECTURE I893).

### Вывод `native:check` (Windows)
```
$ npx expo config --type public --json
expo config: Asia Drive Club 1.0.0, ios kz.adclub.app, android kz.adclub.app, runtime {"policy":"appVersion"}

$ npx expo prebuild --no-install --clean --platform android
✔ Created native directory
✔ Updated package.json
✔ Finished prebuild

ios: not generated on Windows — the CI step (Linux) generates and reads it
android: manifest and build.gradle read
package.json put back as it was (prebuild rewrites its scripts)
```
В сгенерированном `AndroidManifest.xml`: `<queries>` WhatsApp, `CAMERA`, `expo.modules.updates.EXPO_RUNTIME_VERSION`, `EXPO_UPDATES_CHECK_ON_LAUNCH = NEVER`, `EXPO_UPDATES_LAUNCH_WAIT_MS = 0`. TASK-075: `POST_NOTIFICATIONS` и служба `com.google.firebase.MESSAGING_EVENT` объявлены в манифесте библиотеки `expo-notifications`, который Gradle сливает в манифест приложения (в манифесте после prebuild их нет — это ожидаемо; скрипт проверяет манифест библиотеки). iOS (`Info.plist`, `Expo.plist`, entitlements `aps-environment`) читает задача CI `mobile-native` на Linux — локально не генерируется.

### Проверка снимка (AC-5): временно удалённое поле ответа
```
== Mobile app 1.0.0 (contract snapshot) ==
1 changes: 1 error, 0 warning, 0 info
error	[response-required-property-removed] at /specs/revision.json
	in API GET /meta/client-policy
		removed the required property `message` from the response with the `200` status

Breaking API contract change against the contract snapshot of mobile 1.0.0 (see above).
Old mobile app versions would break. Make the change additive, or add a new path (/v2/...).
The server breaks published app version(s): 1.0.0.
```
Изменение откатано (файл совпал со снимком побайтно), повтор — «Compatible with every supported app version: 1.0.0».

## UAT / E2E
Окружение: `api-test-ai` (временно с `DATABASE_URL` на 5433 и `S3_ENDPOINT` на 9002 — `.claude/launch.json` возвращён), `mobile-web` (Android по `X-Client`), dev-база с применённой миграцией `1791850000000_push-apns`.
1. `settings:set client_store_url_android https://play.google.com/store/apps/details?id=kz.adclub.app` и `client_min_version_android 2.0.0` → `GET /meta/client-policy`: `"android":{"minSupportedVersion":"2.0.0","storeUrl":"https://play.google.com/store/apps/details?id=kz.adclub.app"}`, у iOS `storeUrl: null`, у веб-платформ поля нет.
2. Приложение в браузере → «Нужно обновить приложение» → «Откройте Google Play»: открыт `https://play.google.com/store/apps/details?id=kz.adclub.app` (перехват `window.open`).
3. `settings:reset client_store_url_android` → «Проверить снова» → та же кнопка открывает `https://play.google.com/store/search?q=Asia%20Drive%20Club&c=apps`.
4. `settings:set client_store_url_ios https://example.com/x` — отказ проверки (только `https://apps.apple.com/…`).
5. `settings:reset client_min_version_android` → приложение пускает; «Профиль» — «Версия приложения: 1.0.0», «Документы и поддержка» (M-PRO-06) — «Версия приложения · 1.0.0» без идентификатора обновления (браузер — не собственная сборка).
Не проверено в браузере: экран админки «Политика клиента» с новыми строками (вход админки требует второго фактора; строки появляются из списка `CLIENT_POLICY_KEYS` — проверено типами); строка с OTA «· обновление …» (только собственная сборка — юнит-тест `updateLabelOf`).

## Acceptance Criteria
- AC-1 — PASS — `apps/mobile/src/config/app-version.test.ts`: собственная сборка с `nativeVersion 1.0.0` и манифестом `1.4.0` → `mobile/1.0.0 (ios)` и сравнение с минимумом по 1.0.0; Expo Go/браузер → app.json; тест читает `app.json` (`runtimeVersion: { policy: "appVersion" }`); строка M-PRO-06 в браузере — «1.0.0», с OTA — `updateLabelOf` → «a1b2c3d».
- AC-2 — PASS (iOS-часть — в CI) — `app.json` с `kz.adclub.app`, `UIBackgroundModes`, `runtimeVersion`, `updates`; `eas.json` с тремя профилями без адресов и ключей (тест `app-version.test.ts` проверяет отсутствие `https?://`, `.p8`, `google-services`, `key`); вывод `native:check` и `expo-doctor` 21/21 выше; `git status` — нет `google-services.json`, `.p8`, `ios/`, `android/`. Шаг CI `mobile-native` с iOS-prebuild впервые выполнится в прогоне этого push.
- AC-3 — PASS — `apns-push-provider.test.ts`: успех с `apns-id`; 410 `Unregistered`, `BadDeviceToken`, `DeviceTokenNotForTopic` → `invalid_token`; 429/503/500 → `unavailable`; 403 `InvalidProviderToken` → новый токен и повтор, второй отказ → `rejected` (ровно 4 запроса на два вызова); таймаут после отправки → `unknown`; обрыв после соединения → `unknown`; закрытый порт и чужой сертификат → `unavailable`; заголовки `apns-topic`, `apns-collapse-id`, `apns-expiration`, `content-available`; токен кэшируется (одинаков 50 минут − 1 с, новый после), одно соединение на три одновременные отправки; подпись проверяется открытым ключом. Маршрутизация — тест `PlatformPushRouter` (iOS → APNs, Android → FCM, `providerFor`). Конфигурация — `env.schema.test.ts`: `live` без `APNS_*` и без `FCM_*` не стартует, production с `sandbox` не стартует, `fcm` отказ с новым именем, ключ в сообщениях не печатается. Токен в выводе: интеграционный тест уведомлений «never lets … a whole token out» (зелёный) и сообщения ошибок APNs без токена (юнит-тест).
- AC-4 — PASS (на устройстве — NOT RUN, часть B) — задача определяется в `index.ts` до корневого компонента и только при `runEnvironment === "own-build"` (`background-ack-task.test.ts`); `push-ack.test.ts`: нет сессии, чужой payload, истёкший токен — ровно один обмен (`exchanges = ["refresh-1"]`), `SESSION_ENDED` — выход и сброс, 404 — сброс, 503 и нет сети — в очередь; сервер принимает ack как прежде (интеграционный тест уведомлений «confirms only one's own push»).
- AC-5 — PASS — снимок `1.0.0` и `supported.json` в репозитории (созданы `pnpm release:mobile:snapshot 1.0.0`; повтор и 1.1.0 при `app.json` 1.0.0 — отказ); `--base-file` и `--snapshots` работают; шаг CI «API contract keeps every supported app version working»; `contract-snapshots.test.ts` — согласованность папки и списка; ломающее изменение — вывод выше.
- AC-6 — PASS — UAT 1–3; `openapi:compat` — аддитивно; e2e `client-policy.e2e.test.ts` с `storeUrl`; `update-gate.test.ts` — страница по платформе, сохранение для 426, сброс при очистке, только `https://`.
- AC-7 — PASS — `pending-logout.test.ts`: холодный старт открывает заявку при чтении сессии 1,5 с; выход без сети: `retry`, затем при сети — `done` и запрос с токеном; ack: 4xx — `drop`, 5xx/нет сети — `retry` (повтор один раз на возврат — цикл по очереди в `push-provider.tsx`); интеграционный тест: десять одновременных регистраций разных токенов одной сессии — все 200, одна строка `device_token`, нет `ExceptionFilter` (то, что уходит в мониторинг) и `device_token_session_key` в выводе.
- AC-8 — PASS — ARCHITECTURE 0.90: 4.81 (I880–I892, процедура выпуска — I891), обновлены 7.2, 7.4, 9.3, 4.79 (I854, I855, I862, I866), I878, 15.1, 14; CLAUDE.md блок 0 «Сборки и выпуск в dev»; `.env.example`; `expected/migrations.ts` (маршрутов `/admin`, задач и таблиц не добавлено — `admin-routes.ts`, `background-jobs.ts`, `orm-tables.ts` не менялись).
- AC-9 — BLOCKED — сборок EAS, TestFlight, Google Play и проверок на устройствах нет: нет учётных записей (ниже).
- AC-10 — PASS — локальные проверки выше; push в `main` (коммиты `d225f81`, `07c056d`, `1153972`, `5dc9706`) без ожидания CI; прогон CI — `42629569920` (результат не ждал: впервые выполнит iOS-prebuild задачи `mobile-native` и шаг снимков).

## Errors & Fixes
- `registry.test.ts` («ключи раздела 14») упал после правки ARCHITECTURE 14: фраза с `client_min_version_ios|android` в обратных кавычках сбила разбор строки таблицы — переписал словами.
- Тест фонового ack: общий `Response` прочитан дважды (тело одноразовое) — ответ стал фабрикой. Тест выхода без сети: `new Response(body, {status: 204})` бросает — взят 200.
- `expo-doctor`: 10 пакетов на патч позади SDK 57 — выровнено `expo install --fix`.
- `expo prebuild --platform ios` на Windows не генерирует проект — скрипт проверки не считает это успехом iOS, оставляя iOS задаче CI.
- ESLint: `app.config.js` и `scripts/*.mjs` — добавлены Node-глобалы.
- Тест цикла миграций (`database.integration.test.ts`) откатывает по миграции на тест: добавлен тест `push-apns` и по одному `down` там, где `up` посреди теста возвращает поздние миграции.
- Найдено ревью и исправлено: (1) сессия в Keychain была доступна только при разблокированном iPhone — фоновый запуск по push на заблокированном телефоне читал «нет сессии»; теперь `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`; (2) отложенный выход хранил одно место — второй выход без сети вытеснял первый; теперь список до 5, токены берутся после неудачной попытки; (3) фоновая задача не ждала записи очереди подтверждений; (4) APNs: простой соединения сокращён до 2 минут (полуоткрытый сокет давал бы `unknown`), поток, сброшенный без ошибки, теперь решается сразу; (5) неподписывающий ключ APNs выглядел как недоступность Apple — теперь отказ при старте; (6) токен iOS не проверялся перед подстановкой в путь — теперь только hex, иначе `invalid_token`; (7) команда выпуска принимала значение флага за версию и писала платформы без проверки; (8) `expo-doctor` не был закреплён — теперь `1.21.6`; трейлер против снимка — проверка предупреждает, что он действует только в своём push.

## Deviations
- В `eas.json` нет `submit.*.ios.ascAppId` и путей к ключам: числового id приложения в App Store Connect ещё нет, ключи — учётные данные EAS. `eas submit` без `ascAppId` спросит интерактивно — вносится одной строкой после создания записи.
- Снимок контракта — весь документ, а не «используемые схемы» (7.2 формулировка): обоснование в I886.
- `expo-dev-client` добавлен в зависимости (для профиля `development` в задаче — dev-client).

## Known Issues / Risks
- Ничего не дошло до Apple, Google, Expo: живые APNs/FCM, сборки, OTA — не проверены.
- iOS может не разбудить приложение для фонового ack — тогда копия в WhatsApp уйдёт по таймауту (9.3, принятое ограничение).
- После обмена токена при завершении отложенного выхода, если второй `logout` не прошёл, хранится прежний refresh-токен; повтор им сервер откажет (повторное использование) и сессия завершится сервером — результат тот же, но через отказ.
- Android: что data-only сообщение FCM `expo-notifications` рисует сам (по `message`) — решено по исходникам SDK, подтверждается только на устройстве (часть B). Если нет — вернуть блок `notification` и принять, что фоновый ack на Android работает только для открытого приложения.
- iPhone сразу после перезагрузки и до первой разблокировки: защищённое хранилище закрыто, фоновый ack в этот промежуток не уйдёт.
- Трейлер `Contract-Breaking-Change` против снимка действует только в своём push: снимок не сдвигается, следующий push снова красный, пока версия в `supported.json`.
- iOS-часть `native:check` впервые выполнится в CI этого push; если она красная — доводка.

## Remaining Work
Часть B, по получении учётных записей:
1. `eas init` (projectId в `app.json`), переменные EAS: `EXPO_PUBLIC_API_URL` окружения `preview` (staging — TASK-055), файл `GOOGLE_SERVICES_JSON`; учётные данные: ключ API App Store Connect, сервисный аккаунт Google Play, ключ APNs `.p8` (для сервера — `APNS_*` в `.env` того API, на который смотрит сборка).
2. `eas build --profile preview --platform all`, `eas submit --profile preview` (TestFlight, внутренний трек).
3. На телефонах: M-PUSH-01 и системный запрос, токен в `device_token`, P-ORD-01 при закрытом приложении (`PUSH_PROVIDER=live`), ack из фона, открытие заявки из push при холодном старте, «Позвонить через…» и «Маршрут», камера техпаспорта; одно `eas update --channel preview` — применилось при следующем запуске, M-PRO-06 с id, `X-Client` прежний.

## Список для Product Owner
**Учётные записи и доступы**
1. Expo (EAS): организация/проект, доступ агенту (токен `EXPO_TOKEN` для CI/сессии) — для `eas init/build/submit/update`.
2. Apple Developer Program (организация), запись приложения в App Store Connect (её числовой Apple ID → `ascAppId`), ключ API App Store Connect (для `eas submit`), ключ APNs `.p8` (Key ID, Team ID).
3. Google Play Console: приложение создано, сервисный аккаунт с доступом к выпуску (для `eas submit`); проект Firebase только для Android: `google-services.json` (в EAS как файловая переменная) и сервисный аккаунт FCM (`FCM_*` сервера).
4. Адрес API для сборки `preview` — staging (TASK-055) или адрес, который вы назовёте.

**Решения**
- Идентификаторы: в `app.json` стоит предложенное `kz.adclub.app` для iOS и Android — подтвердить или назвать другое (до первой сборки; после публикации не меняется).
- Экспорт шифрования (App Store): приложение использует HTTPS и AES-GCM для локальной копии заявок — обычно это «освобождённое» шифрование, и в `Info.plist` можно поставить `ITSAppUsesNonExemptEncryption = false`; это заявление от вашего имени — подтвердите, и я добавлю строку.
- Когда поднимать `client_min_version_*` после выхода новой версии (7.4: «через несколько недель») — назвать срок.

**Тексты на утверждение**
- M-PRO-06 / подвал профиля: «{версия} · обновление {id}» — ru «1.0.0 · обновление a1b2c3d», kk «1.0.0 · жаңарту a1b2c3d», en «1.0.0 · update a1b2c3d».
- Админка «Политика клиента»: «Страница в App Store», «Страница в Google Play».

**Материалы страниц сторов (к публикации, не к внутреннему тестированию)**
- Название («Asia Drive Club»), подзаголовок/краткое описание и полное описание kk и ru; ключевые слова (App Store).
- Скриншоты iPhone 6,7″ и 6,5″ (и iPad, если `supportsTablet` остаётся `true` — сейчас включено; решить: убрать или делать скриншоты iPad), Android телефон; значок 1024×1024 (есть в `design/brand`), feature graphic Google Play 1024×500.
- Возрастной рейтинг (анкеты Apple и IARC), категория, контактный e-mail и сайт поддержки.
- Адрес политики конфиденциальности (`club_privacy_url`, TASK-055); формы о данных: App Privacy (Apple) и Data safety (Google) — телефон, имя, город, автомобиль (VIN/госномер), push-токен, фото техпаспорта (не хранится), геолокация (по нажатию).
- Служебный вход для проверки сторами — уже есть: `review-login:enable` (TASK-077); номер и код передаются в поле «App Review Information» / «Доступ к приложению».

## Future Improvements
- Хранить в отложенном выходе новую пару токенов после обмена.
- Экран «доступно обновление» (`latestVersion`) — по-прежнему не нужен.
- Снятие снимков из списка — автоматическая подсказка в `openapi:compat --snapshots`, когда минимумы обеих платформ перешагнули версию.

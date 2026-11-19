# TASK REPORT — TASK-041

## Status
COMPLETED

## Result
Сервер принимает подписку пользователя из App Store и Google Play — без учётных записей сторов, на подменённых ответах:

- `POST /billing/store/sync` (мобильная сессия) проверяет покупку у самого стора: Apple — подпись JWS до корня Apple (Apple Root CA - G3) и состояние в App Store Server API; Google — Play Developer API (`purchases.subscriptionsv2.get`) и подтверждение покупки. Результат идёт тем же путём, что событие TASK-040 (`billing_event` → применение → журнал). Своя покупка даёт клубный доступ, чужая — 409 `SUBSCRIPTION_LINKED_TO_ANOTHER_ACCOUNT`, продукт не из тарифа — 409 `SUBSCRIPTION_PRODUCT_UNKNOWN`, негодная — 400 `SUBSCRIPTION_PURCHASE_INVALID`, стор недоступен — 503 `retryable: true`, повтор ничего не меняет.
- Уведомления сторов — `POST /webhooks/stores/apple` (Notifications V2) и `POST /webhooks/stores/google` (RTDN через Pub/Sub push): подлинность проверяется первой (JWS до корня Apple, `bundleId`, окружение; OIDC-токен Google — подпись, `aud`, отправитель), доставка хранится один раз, применяет worker. Таблица «событие стора → наше событие» — одна на стор, сверена с документацией 20.11.2026, тест на каждую строку.
- Ежечасная сверка с API сторов, сигнал администратору `store_sync_stale` («Стор не отвечает»), push P-SUB-01 при входе в льготный период и напоминание за `user_billing_reminder_days` до его конца (один раз на льготный период; оплата до напоминания его отменяет). Резерв WhatsApp — прежний U-SUB-01.
- Админка: в блоке «Подписка» карточки пользователя — стор, окружение, продукт, последнее слово стора и время сверки; сигнал на главной и в «Сигналах» со ссылкой в «Биллинг → Подписки пользователей» с отбором платформы.
- Dev-команда `dev:stores:notify` имитирует уведомление стора по HTTP на свой API, подписывая локальной цепочкой сертификатов (сервер верит ей только в development и test).

**Ни одного настоящего обращения к App Store и Google Play** — ни в коде тестов, ни в проверках: сторы — локальный HTTP-сервер и подменённый `fetch`, подписи — локальная цепочка `apps/api/fixtures/stores`.

## Changes
- `apps/api/src/modules/billing/stores/` (новое): `app-store.ts` (таблица `appleNotificationEvents`, статусы API 1–5, `AppStore`), `google-play.ts` (`googleNotificationTypes`, `googleStateEvents`, `GooglePlay`: OIDC, Play API, подтверждение), `signatures.ts` (проверка JWS с цепочкой `x5c`, RS256, подпись ES256/RS256 на `node:crypto`), `apple-root-ca.ts` (PEM корня Apple), `store-word.ts`, `store-subscriptions.ts` (`sync`, приём уведомлений, сверка, сигнал, напоминание), `store-fetch.ts`, `store.controllers.ts`, `dev-store-signing.ts`; юнит-тесты `app-store.test.ts`, `google-play.test.ts`.
- `apps/api/src/modules/billing/`: `billing.module.ts` (провайдеры, контроллеры, 4 задачи worker'а), `billing-jobs.ts` (`billing.apply-store-notification`, `billing.reconcile-stores`, `billing.watch-stores`, `billing.remind-grace`), `subscription-events.ts` (отказ `unknown_product` при создании подписки; отметка напоминания при коротком льготном периоде), `subscription-provider.ts` (`productId`), `plans.service.ts` (`storeProductIds`, наследование у следующей записи), `subscription-views.ts` (поле `store` админки), `billing-operator.ts` (`storeNotify`), `schema.ts` (`store_purchase`, `store_notification`, `store_api_health`).
- Миграция `infra/migrations/1792725000000_store-subscriptions.sql`: `plan.store_product_ids`, `subscription.grace_reminded_until`, три таблицы сторов.
- Конфигурация: `apps/api/src/config/env.schema.ts` (переменные `APPLE_*`, `GOOGLE_PLAY_*`, `GOOGLE_PUBSUB_*`, «набор целиком или ничего»), `.env.example`.
- Сырое тело вебхуков: `common/http/raw-body-routes.ts`, `upload-routes.ts`; `openapi/check-served-routes.ts`.
- Контракт: `storeSyncBodySchema`, маршрут `syncStoreSubscription`, коды `SUBSCRIPTION_PURCHASE_INVALID`, `SUBSCRIPTION_PRODUCT_UNKNOWN`, лимиты `store_sync_per_account`, `store_webhook_per_ip`, сигнал `store_sync_stale` и его поля, `adminStorePurchaseSchema` (поле `store` ответа админки — аддитивно); `apps/api/openapi.json` перегенерирован.
- Настройки: `store_sync_per_account` (+окно), `store_webhook_per_ip` (+окно), `store_reconcile_batch`.
- Операторская команда: `dev:stores:notify`, `billing:plan:add --store-products`.
- Админка: `signals/signal-words.ts`, `home/Home.tsx`, `billing/billing-words.ts`, `users/UserCard.tsx`, `users/subscription-words.ts`.
- Тестовая инфраструктура: `testing/database.ts` (TRUNCATE), `testing/expected/migrations.ts`, `testing/expected/background-jobs.ts`, `database/schema-drift.test.ts`, `packages/contracts/src/openapi.test.ts`.
- Фикстуры и генератор: `apps/api/fixtures/stores/*`, `scripts/store-test-certs.mjs`.
- Интеграционный тест: `apps/api/src/modules/billing/stores.integration.test.ts`.
- Документы: `ARCHITECTURE.md` — раздел 4.98 (I1221–I1245), 9.4.1 (имена событий сторов по документации, абзац «Как реализованы сторы» вместо «Не реализовано до TASK-041»), строки таблиц 13 и 14; `CLAUDE.md` — «Подписки в dev».

## Technical Decisions
Все внесены в ARCHITECTURE 4.98. Главные:
- Провайдер подписки в базе остаётся `store`; наша ссылка — `apple:<originalTransactionId>` / `google:<sha-256 токена>`; сам токен Google хранится только в `store_purchase` (для вызовов API), нигде не логируется (I1222).
- Состояние из API стора говорится событиями с id «покупка : вид : момент» — повтор `sync`/сверки даёт дубликат; ранее **отклонённое** событие принимается снова с новым id (I1224). Это поймал интеграционный тест: без этого отказ «уже активна» навсегда блокировал ту же покупку для другого аккаунта.
- `sync` применяет события в процессе API, чтобы ответ говорил, что вышло (I1229).
- Продукт вне тарифа отклоняется и на пути уведомления — в `SubscriptionEvents` при создании подписки (I1230).
- Google: подтверждение покупки только для принятой нами подписки; `linkedPurchaseToken` заканчивает прежнюю покупку того же аккаунта (I1231, I1232).
- Сверка ежечасная (не ежедневная) и захватывает подписки, закрытые одним временем за последние 7 дней, — продление задним числом приходит само (I1236).
- `APPLE_ALLOW_SANDBOX` — production может принимать покупки песочницы (App Review) — решение Product Owner при настройке.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS (0 ошибок; 2 предупреждения в чужих файлах — `apps/mobile`, `ratings/supplier-ratings.service.ts`, были до задачи)
- `pnpm typecheck` — PASS
- `pnpm test` — PASS (все пакеты; api — 83 файла, в т. ч. `app-store.test.ts` 39 и `google-play.test.ts` 47 тестов, `env.schema.test.ts`)
- `pnpm build` — PASS
- `openapi:generate`, `openapi:check` — PASS (после rebase на TASK-054)
- `openapi:compat --snapshots` — PASS («Compatible with every supported app version: 1.0.0»)
- Интеграционные до rebase: `stores.integration.test.ts` — 15/15 PASS; `billing`, `supplier-billing`, `database`, `admin-panel`, `notifications` — 157/157 PASS
- Интеграционные после rebase на TASK-054 (`stores`, `database`, `billing`) — 99/99 PASS
- CI — запущен, результат не ожидался (CLAUDE.md §11): прогон 44610002228 (CI на коммите 45339d5)

## UAT / E2E
Окружение: worktree, своя база `adclub_t041`, API на 3241 с `AI_PROVIDER=test`, worker, админка на 5241; тестовые номера.
- Тариф пользователей с продуктами: `billing:plan:add … --store-products kz.adclub.club.month,club_month` — `storeProductIds` в ответе.
- `dev:stores:notify +77010000361 --type SUBSCRIBED --subtype INITIAL_BUY --until +30d` → 200, подписка `active`, iOS.
- `--type DID_FAIL_TO_RENEW --subtype GRACE_PERIOD --grace-until +16d` → 200, `subscription:status`: `grace`, `graceUntil` из события, история «started → grace_started».
- `--type EXPIRED --bad-signature` → 403 `FORBIDDEN`, состояние не изменилось.
- `http://localhost:3241/dev/pushes`: P-SUB-01 «Не удалось оплатить подписку. Обновите способ оплаты, чтобы сохранить доступ» (`status: no_device`, `target: subscription`) и копия U-SUB-01 в WhatsApp (`fallbackOfId`) — AC-5.
- Сигнал: `store_outage_signal_hours` = 1, последний успех API App Store — 2 часа назад, `jobs:run billing.watch-stores` → в админке (вход тестовым администратором `+77010000941`): главная — карточка «Стор не отвечает · 1»; «Сигналы» — «Стор не отвечает · App Store · не настроен: APPLE_BUNDLE_ID, APPLE_APP_APPLE_ID, APPLE_ENVIRONMENT, APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY · 1 подписка · порог 1 час», строка ведёт на `/billing/users?tab=active&platform=ios&provider=store` — там одна подписка «Льготный период стора · iOS». Закрытие сигнала при успехе проверено интеграционным тестом (в dev API стора не настроен). Настройка возвращена `settings:reset`.
- Карточка пользователя → «Клубный доступ» → «Подписка»: «Стор: App Store · песочница · kz.adclub.club.month», «Последнее слово стора: DID_FAIL_TO_RENEW/GRACE_PERIOD, 20 нояб., 01:14».
Панель браузера была скрыта — проверка по тексту страниц и DOM, без снимков.

## Acceptance Criteria
- AC-1 — PASS — `stores.integration.test.ts` «POST /billing/store/sync»: Apple своя покупка → `active`, `access.source = subscription`, `POST /orders` 201, повтор — число строк `billing_event` не изменилось; чужая — 409 и `subscriptionOf(second)` пусто; Google своя → `active`, подтверждена (`acknowledged = [token]`), чужая 409, повтор без новых событий.
- AC-2 — PASS — тесты «the stores' notifications»: поддельная/истёкшая подпись, чужой bundle и окружение, негодный OIDC (`aud`, `email`, `exp`, мусор, без заголовка) — 403, ноль строк `store_notification` и `billing_event`; три одновременные доставки Apple и две Google — одна строка; событие старше — `no_effect: stale`; неизвестное — `unknown`, событий нет. Таблицы: `appleNotificationEvents` (`app-store.ts`) и `googleNotificationTypes`/`googleStateEvents` (`google-play.ts`) со ссылками на документацию; `it.each` по каждой строке в `app-store.test.ts` и `google-play.test.ts`.
- AC-3 — PASS — «ARCHITECTURE 18.10»: Apple шаги 1–7 (покупка, Android без опроса Google, заявка, льготный период с концом из события и одним push, заявка в льготный период и напоминание один раз, `suspended` и 403 на заявку при живом коде старой, новая покупка на Android — прежняя `expired`) и шаг 8 отдельным тестом (сверка приносит продление; стор недоступен — `expired_unconfirmed`, затем `expired`, затем `active` задним числом); Google шаги 1, 4–7.
- AC-4 — PASS — тест «store_sync_stale» (открывается, не дублируется, нет сигнала по стору без подписок, закрывается при первом успехе); в админке — текст страниц выше (UAT).
- AC-5 — PASS — тесты push (один P-SUB-01 на льготный период, повтор уведомления без второго push, напоминание один раз, отмена напоминания оплатой) и `/dev/pushes` после `dev:stores:notify` (UAT).
- AC-6 — PASS — все адреса сторов в тестах — локальный сервер; тест «what leaves the process» (нет токена и JWS в `audit_log`, `billing_event`, `store_notification`, `subscription`) и общий перехват вывода файла (`expectNoSecretsWritten`: зарегистрированные JWS и токены, шаблон `eyJ…eyJ`) — зелёные.
- AC-7 — PASS — локальные проверки выше; миграция — в `expected/migrations.ts`, `database.integration.test.ts` зелёный; 4 задачи — в `expected/background-jobs.ts`; новых маршрутов `/admin` нет (поле `store` добавлено к существующему). Контракт: `openapi:generate`, `openapi:check`, `openapi:compat --snapshots` — PASS.
- AC-8 — PASS — ARCHITECTURE 4.98 (I1221–I1245), 9.4.1 исправлен; CLAUDE.md «Подписки в dev»; этот отчёт.

## Errors & Fixes
- Отклонённое событие состояния (`already_active`) блокировало ту же покупку навсегда, в том числе для другого аккаунта (id события — из состояния). Исправлено: отклонённое принимается снова с новым id (I1224).
- Таблица `TRUNCATE` тестов не знала новых таблиц (FK на `account`) — добавлены.
- Подсчёт push в тестах учитывал копию WhatsApp — уточнён `channel = 'push'`.
- Ключи Google запрашивались до разбора токена — мусорный токен давал 503 вместо 403. Теперь сначала форма токена.
- Apple issuer id не RFC-UUID — проверка переменной — по форме 8-4-4-4-12.
- **Ошибка процесса:** первый запуск превью (`preview_start api-test-ai`) взял `.claude/launch.json` основного репозитория и поднял API основной копии на порту 3000 (общая база `adclub`); остановлен через несколько секунд, запросов к нему не было. Дальше API, worker и админка запускались из worktree на своих портах.

## Deviations
- 9.4.1 называл таблицы `store_transaction` и `inbound_webhook_event` и ежедневный опрос; сделаны `store_purchase` + `store_notification` и ежечасная сверка (задача разрешила «порядка раза в час»). Абзац 9.4.1 обновлён.
- `GRACE_PERIOD_EXPIRED` Apple → `suspended`, а не `expired`: по документации Apple продолжает повторы до 60 дней и может восстановить подписку (так и 18.10 шаг 6 «при включённых billing retry — suspended»).
- `POST /billing/store/sync` тело — `signedTransaction` (а не `transactionInfo` из 9.4.1).

## Known Issues / Risks
- `expiryTime` Google в состоянии `IN_GRACE_PERIOD` принят за конец льготного периода — документация этого прямо не говорит; проверить в песочнице.
- `REFUND_REVERSED` Apple не восстанавливает подписку сам (`ignored`); вернёт следующее слово стора.
- Повтор уже применённого состояния (отмена → возобновление → снова отмена в одном сроке) из `sync`/сверки приходит дубликатом — смену несут уведомления.
- OCSP-проверки отзыва сертификатов Apple нет.
- Покупка Google, пришедшая уведомлением раньше `sync`, подтверждается только если аккаунт назван стором (`obfuscatedExternalAccountId`); иначе — при `sync`.
- Фикстуры содержат приватные ключи локальной цепочки — не секреты, сервер верит им только в development/test.

## Что проверит только песочница
Формат и принятие нашего токена App Store Server API на настоящем хосте; реальные уведомления V2 на наш адрес (окружение, `appAppleId`, подтипы); RTDN через настоящий Pub/Sub push с OIDC Google (aud, сервисная учётная запись); ответы `subscriptionsv2.get` в каждом состоянии, `linkedPurchaseToken`, подтверждение покупки; покупки App Review в песочнице при `APPLE_ALLOW_SANDBOX`.

## Что нужно от Product Owner в консолях сторов
- **App Store Connect:** приложение `kz.adclub.app` и его Apple ID; группа подписок и продукт месячной подписки (id, например `kz.adclub.club.month`) с ценой в тенге; льготный период (Billing Grace Period — 3/16/28 дней); адрес App Store Server Notifications V2 для production и sandbox — `https://<api>/webhooks/stores/apple`; ключ In-App Purchase (Users and Access → Integrations): issuer id, key id, `.p8`; тестовые учётные записи песочницы.
- **Google Play Console:** приложение `kz.adclub.app`, подписка и базовый план (id, например `club_month`) с ценой; льготный период и account hold; сервисная учётная запись с правом «просмотр финансовых данных / управление заказами и подписками» (JSON-ключ); тема Pub/Sub для RTDN и push-подписка на `https://<api>/webhooks/stores/google` с аутентификацией (её audience и сервисная учётная запись); лицензионные тестировщики.
- Решение: принимать ли в production покупки песочницы (`APPLE_ALLOW_SANDBOX`).
- Затем: `billing:plan:add … --store-products <id App Store>,<id Google Play>` и переменные окружения (`.env.example`, раздел сторов).

## Remaining Work
None (экраны M-SUB-01/02 — TASK-041.B; живая проверка — после появления учётных записей).

## Future Improvements
- Перенос покупки между аккаунтами администратором (BACKLOG).
- Обработка `REFUND_REVERSED` запросом состояния стора.
- OCSP для сертификатов Apple.

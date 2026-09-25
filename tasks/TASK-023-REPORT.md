# TASK REPORT — TASK-023

## Status

PARTIAL — 8 из 9 AC. Функциональность задачи сделана и проверена целиком, `main` в итоге зелёный (прогон `36155245393`); не выполнен **AC-8**: CI не был зелёным **с первой попытки** — сначала из-за моего неверно собранного коммита (разобрано ниже), затем дважды из-за случайного падения чужого к задаче набора фотографий (долг T-8, образ MinIO).

## Result

Приложение получило три ответа, на которых держатся экраны заявок M-ORD-02/03/04.

**Копия активных заявок для работы без сети** — `GET /active-orders`. Одним ответом отдаются **все** активные заявки пользователя, и ровно то, чем без сети пользуются: код подтверждения и содержимое QR, позиция (название, артикул, бренд), количество, цена по заявке и итог, способ получения, поставщик (название, город, район), главная дата карточки, сроки, признаки `awaitsReceipt` (PRODUCT 6.7 «предстоит получение») и `needsAnswer`, а **после принятия** — точка выдачи по D-026: адрес, район, город, часовой пояс, часы работы, ближайшие нерабочие даты и телефон. Каталога, цен, наличия, фотографий, гаража и хода заявки в копии нет. Ответ несёт `serverTime` (время базы) для баннера «Обновлено в {время}», помечен `Cache-Control: private, no-store` и рассчитан на полную замену копии: без курсоров и фильтров, с пределом-настройкой `active_orders_copy_limit` (при превышении — ближайшие по сроку, `total`/`limit`/`truncated`). Заявка, у которой срок уже прошёл, истекает при чтении и в копию не попадает. Порядок карточек — M-ORD-02: «Можно забирать» → по дате. Пользователь без клубного доступа видит **свои** заявки и коды целиком: заявка оформлена, когда доступ был, и код — единственный способ забрать товар.

**История по месяцам** — `GET /order-history`. Завершённые заявки страницами, сгруппированные в месяцы **во времени Алматы** (`timeZone` в ответе), новые сверху; в записи — статус, дата завершения, позиция, количество, сумма, поставщик, способ получения, `givenOut` и признаки кнопок `canRepeat` и `canReview`. Страница идёт по моменту завершения, поэтому заявка, завершившаяся во время листания, не вытесняет и не дублирует уже показанные. `total: 0` — различимое пустое состояние.

**Повтор заказа** — `GET /orders/{orderId}/repeat`. Отвечает, чем можно повторить прямо сейчас: тем же предложением того же поставщика с **текущей** ценой (`priceChanged` и прежняя цена в `previous`), либо позицией для открытия карточки каталога (`offer_withdrawn`, `supplier_unavailable`), либо понятным отказом (`item_unavailable`, `club_access_required`, `kind_not_supported`). Сам заказ оформляется прежним `POST /orders` — второго пути создания не появилось.

Кроме того: **одно место** решает, учитывается ли заявка в статистике поставщика (`countsInStatistics` и SQL-двойник `inSupplierStatistics()`); тестовая заявка сотрудника не учитывается ни в дисциплине, ни в сигнале «частые закрытия администратором», а счётчики вкладок кабинета её по-прежнему считают — это очередь работы, а не суждение о компании. Закрыт долг TASK-022: ограничение частоты маршрутов сессии объявляется в контракте и считается тем же guard'ом, что и у открытых маршрутов.

## Changes

**Контракт (`packages/contracts`)**

- `src/orders.ts` — `activeOrderSchema`, `activeOrderMainDateSchema`, `activeOrdersResponseSchema`; `userHistoryOrderSchema`, `userHistoryMonthSchema`, `userOrderHistoryQuerySchema`, `userOrderHistoryPageSchema`; `repeatOfferSchema`, `repeatBlockedReasonSchema`, `repeatUnavailableReasonSchema`, `repeatOrderResponseSchema`.
- `src/routes.ts` — маршруты `getActiveOrders` (`GET /active-orders`), `getOrderHistory` (`GET /order-history`), `getOrderRepeat` (`GET /orders/{orderId}/repeat`). В `ApiRouteDefinition.rateLimit` поле `limit` стало необязательным, добавлены `perAccount` для маршрутов сессии и `perMember`; `defineRoute` проверяет согласованность. Пределы объявлены у `acceptSupplierOrder`, `markSupplierOrderReady`, `declineSupplierOrder` (`order_actions_per_member`) и `searchOfferItems` (`offer_item_search_per_member`).
- `src/login-code.ts` — имя предела `active_orders_per_account`.
- `apps/api/openapi.json` перегенерирован.

**Домен (`packages/domain`)**

- `src/order/order-machine.ts` — `awaitingReceiptOrderStatuses` и `orderAwaitsReceipt`; документировано, что `activeOrderStatuses` остаётся единственным определением «активной заявки».
- `src/order/order-repeat.ts` — чистая `orderRepeatDecision` (+ тесты).
- `src/order/order-statistics.ts` — `countsInStatistics` (+ тесты); в комментарии явно названы потребители TASK-050 и TASK-034.

**Сервер (`apps/api`)**

- `src/modules/orders/orders.service.ts` — `activeCopy`, `historyPage`, `repeat`, `freshMany`; `DEADLINE_AT`, `inCardOrder`; убран рукописный счётчик `order_actions_per_member`.
- `src/modules/orders/order-views.ts` — `activeCopyEntries`, `historyMonths`, батчевый `pickupPointsOf`; `itemOf` экспортирован.
- `src/modules/orders/order-repeat.ts` — сбор фактов и ответ для «Повторить».
- `src/modules/orders/orders.controller.ts` — три обработчика; `Cache-Control: private, no-store` у копии; действия поставщика привязаны `RateLimitedRoute`.
- `src/modules/orders/schema.ts` — `inSupplierStatistics()`; `order-transitions.ts` и `order-discipline.ts` берут единое решение.
- `src/rate-limit/` (переименован из `src/public-rate-limit/`) — `RouteRateLimitGuard` считает по адресу, учётной записи или сотруднику; `RateLimitedRoute` сам ставит нужный guard сессии.
- `src/modules/identity/session/session.guard.ts` — `authenticatedSessionOf` для guard'ов, работающих после `SessionGuard`.
- `src/modules/offers/offer-item-search.service.ts` — рукописный счётчик убран.
- `src/modules/settings/registry/registry.ts` — `active_orders_copy_limit`, `active_orders_per_account`, `active_orders_per_account_window_seconds`.

**Тесты** — `apps/api/src/modules/orders/orders.integration.test.ts` (+13 тестов, было 54 → стало 67), `packages/domain/src/order/order-repeat.test.ts`, `order-statistics.test.ts`, дополнен `order-machine.test.ts`, `packages/contracts/src/openapi.test.ts`.

**Документы** — `ARCHITECTURE.md` 0.36 (раздел 4.33, I340–I350; уточнены 6.1, 8.4, 14), `CLAUDE.md` блок 0.

Миграций задача не потребовала: всё нужное уже есть в `customer_order`.

## Technical Decisions

Значимое — в `ARCHITECTURE.md` 4.33 (I340–I350). Коротко:

- **Пути — соседи `/orders`, а не подпути** (I340). `/orders/active` и `/orders/history` совпали бы с `GET /orders/{orderId}`, где `orderId` — uuid, и правильность ответа зависела бы от порядка объявления обработчиков. В репозитории такого совпадения нет нигде (`/supplier/offer-receipt-preview` рядом с `/supplier/offers/{offerId}` — тот же приём).
- **Одно определение «активной заявки»** (I341). `activeOrderStatuses` (`created`, `accepted`, `ready`) — «заявка ещё идёт»; перечисление PRODUCT 6.7 — не второе определение, а подмножество `awaitingReceiptOrderStatuses` (`accepted`, `ready`). В копию идут все активные (M-ORD-02 офлайн показывает и «Ждём ответа поставщика», F10 открывает этот экран целиком), каждая с признаком `awaitsReceipt`.
- **Состав копии** (I342) выведен из того, что рисуют M-ORD-02/03/04 без сети, и ограничен этим; точки всех заявок читаются одним запросом.
- **Предел и время сервера** (I343): отбор по `coalesce(expires_at, respond_by)`, ленивое истечение перед сборкой копии, `serverTime` из базы (одни часы, 4.32 I336).
- **Клубный доступ не сужает собственную копию** (I344) — он требуется там, где создаётся новая заявка.
- **История — по `finished_at`** (I345): новая завершённая заявка попадает выше курсора, поэтому листание ничего не теряет и не повторяет; месяцы — `Asia/Almaty`.
- **Повтор — чистая функция и цена сегодняшнего дня** (I347); порядок проверок «доступ → вид → витрина».
- **Одно место статистики** (I348) и явная запись, что TASK-050 и TASK-034 обязаны брать именно его.
- **Долг TASK-022** (I349): пределы маршрутов сессии — общим механизмом; руками остались только счётчик неудач перебора кода (он считает не запросы) и создание заявки (возвращает счёт отказанной).

## Verification

- `pnpm format:check` — PASS — «All matched files use Prettier code style!».
- `pnpm lint` — PASS — 12 задач, без ошибок и предупреждений.
- `pnpm typecheck` — PASS — 18 задач.
- `pnpm test` — PASS — 15 задач; `@adclub/api` 40 файлов / 476 тестов, `@adclub/contracts` 17 файлов / 126 тестов, `@adclub/domain` 16 файлов / 219 тестов (после изменений — с новыми файлами домена).
- `pnpm --filter @adclub/api openapi:check` — PASS — «matches the contract and the served routes».
- `pnpm --filter @adclub/api openapi:compat --base 132b863` — PASS — «No breaking changes to report… Contract is backward compatible».
- Интеграционные тесты заявок (файл задачи) — PASS — `npx vitest run --config vitest.integration.config.ts src/modules/orders/orders.integration.test.ts`: **67 тестов** (было 54).
- Интеграционные тесты, затронутые переносом лимитов, последовательно — PASS — `--no-file-parallelism` по `offers`, `showcase`, `suppliers`, `compatibility`, `jobs`: **5 файлов, 119 тестов**.
- `pnpm test:integration` (весь набор, локально) — FAIL дважды по инфраструктурной причине, **не связанной с изменением**: первый прогон — `Query read timeout` в `beforeEach` (`DevCatalogSeed`) файла заявок, второй — `Connection terminated unexpectedly` в `jobs.integration.test.ts` после теста «keeps a worker alive while PostgreSQL is away». Оба раза 522 из 523 тестов зелёные, падал **каждый раз другой** файл; машина поднимает 21 файл × (PostgreSQL + Redis) одновременно. Те же файлы по отдельности и последовательно проходят (см. две строки выше). Авторитетная проверка — CI, где набор идёт тем же `pnpm test:integration`.
- Набор фотографий (файл, упавший в CI) локально — PASS — `npx vitest run --config vitest.integration.config.ts src/modules/catalog/catalog-photos.integration.test.ts`: 31 тест.
- CI на `main` — **не зелёный с первой попытки**, подробности в AC-8 и «Errors & Fixes».

## UAT / E2E

Сценарии пройдены интеграционными тестами на настоящих PostgreSQL и Redis (Testcontainers), по HTTP через supertest, а не только юнит-проверками:

- пользователь оформляет заявку → копия содержит её с кодом, QR, главной датой и `serverTime`; поставщик принимает → в той же записи появляются адрес точки, часы, нерабочие даты и телефон; заявку выдают по коду → она уходит из копии и появляется в истории текущего месяца с суммой и `canRepeat`;
- заявка с прошедшим сроком в копию не попадает, и чтение само применило истечение (в базе `response_expired`, в журнале `expire_no_response`);
- предел копии — настройкой: при `active_orders_copy_limit = 2` из четырёх заявок отданы две ближайшие по сроку, `truncated: true`, `total: 4`;
- порядок карточек: «Можно забирать» первой, дальше по дате;
- гость — 401, кабинет и админка — 403, чужая копия пуста, чужой повтор — 404; после отзыва клубного доступа пользователь по-прежнему видит свою заявку, код и адрес точки;
- предел частоты копии (429 с `Retry-After` и именем предела, у другой учётной записи свой счёт), и копия отдаётся при остановленном Redis;
- история на границе года и суток: заявки, завершённые в 23:30 31 декабря и в 02:00 1 января по Алматы, попали в разные месяцы; завершённая в 00:30 — в свой день;
- листание истории по две записи с завершением шестой заявки между страницами: ни пропусков, ни повторов; испорченный курсор — 400;
- пустая история (`total: 0`, `months: []`) и тестовая заявка сотрудника (`isTest: true`, `canReview: false`);
- повтор: текущая цена и `priceChanged` после изменения цены, оформление той же ценой через `POST /orders`; после снятия предложения — `catalog/offer_withdrawn`, при паузе поставщика — `catalog/supplier_unavailable`, после архива позиции — `unavailable/item_unavailable`, без клубного доступа — `unavailable/club_access_required`;
- две тестовые заявки сотрудника, закрытые администратором, сигнала не дают; две обычные — дают, а счётчик вкладки «Завершённые» считает все четыре.

Ручного прогона в dev-окружении (curl по командам CLAUDE.md) не выполнялось — сценарии выше покрыты автоматически на настоящих контейнерах. E2E в браузере и на устройстве неприменимы: клиентской части задача не касается.

## Acceptance Criteria

- **AC-1 — PASS** — маршрут `GET /active-orders` (`packages/contracts/src/routes.ts`, `apps/api/src/modules/orders/orders.controller.ts:active`, `orders.service.ts:activeCopy`) отдаёт все активные заявки с кодом, QR, позицией, поставщиком, точкой выдачи по D-026 и главной датой, плюс `serverTime`. Тесты «holds every active order with the code, the QR and the way to the supplier, and the time of the server» и «leaves out an order whose deadline has just passed, before the sweeper comes» (второй проверяет и то, что чтение перевело заявку в `response_expired`).
- **AC-2 — PASS** — гость получает 401, кабинет и админка — 403, чужая копия пуста (тест «keeps the copy to its owner, and keeps it for a user whose club access ended»); тот же тест проверяет пользователя без клубного доступа — ответ описан в ARCHITECTURE I344 и содержит его собственные код и адрес. Проверка «поле отсутствует для роли» по сырому ответу: в записи копии нет `terms`, `history`, `version`, `comment`, `givenOut`, а до принятия нет `pickupPoint`. Код и QR поставщику и администратору не приходят нигде — прежние тесты «the confirmation code» и «the code and the QR after TASK-022» (67 тестов файла зелёные); новые ответы истории и повтора проверены на отсутствие кода и префикса QR.
- **AC-3 — PASS** — `GET /order-history` отдаёт месяцы во времени Алматы с суммой, поставщиком и признаками кнопок (тест «groups by months of Almaty time, over a year's edge and just after midnight»); листание с завершением шестой заявки между страницами не теряет и не повторяет записи (тест «pages without losing or repeating a record when another order finishes meanwhile»).
- **AC-4 — PASS** — тесты «answers with the price of today, and the order goes through POST /orders» (актуальная цена, `priceChanged`, оформление тем же `POST /orders`), «sends to the catalog when the offer is gone, and refuses when the item is» (снято, пауза, архив) и «asks for club access before anything else». Случай «услуга» (`kind_not_supported`) недостижим по HTTP, пока проверка базы `customer_order_kind_check` разрешает только `stock`, — он покрыт юнит-таблицей `packages/domain/src/order/order-repeat.test.ts` («refuses a kind the server can't create yet»).
- **AC-5 — PASS** — `countsInStatistics` (`packages/domain/src/order/order-statistics.ts`) и SQL-двойник `inSupplierStatistics()` (`apps/api/src/modules/orders/schema.ts`); их берут дисциплина и сигнал `frequent_admin_closes`. Тест «leaves test orders out of the signal about closes by the administrator» + юнит-тест `order-statistics.test.ts`. Для TASK-050 и TASK-034 решение описано в комментарии функции и в ARCHITECTURE I348.
- **AC-6 — PASS** — предел `active_orders_copy_limit` (настройка, группа «Заявки»); поведение описано в ARCHITECTURE I343 и проверено тестом «gives at most the setting's worth of orders, the nearest deadlines first» (`limit: 2`, `total: 4`, `truncated: true`, отданы две ближайшие по сроку).
- **AC-7 — PASS** — `openapi:check` и `openapi:compat --base 132b863` зелёные («Contract is backward compatible»); существующие тесты не ослаблены (ни один assertion не снят, ни один тест не пропущен; файл заявок вырос с 54 до 67 тестов). `pnpm test` зелёный. `pnpm test:integration` — зелёный в CI (AC-8); локально дважды падал один файл по инфраструктурной причине, каждый раз другой, — подробности в «Verification».
- **AC-8 — FAIL** — коммиты по D-024 сделаны (состав ниже), но **CI с первой попытки красный**, и это моя ошибка.
  - Прогон `36151916307` (коммит `4922724`) — failure на шаге Typecheck: в коммит реализации попал переименованный модуль лимитов со **старым** содержимым. Причина — `git add` с двумя путями, один из которых уже удалён переименованием: git отклоняет такой вызов целиком, и переписанные `apps/api/src/rate-limit/index.ts` и `route-rate-limit.guard.ts` остались в рабочем дереве. Локально всё проходило именно потому, что проверялось рабочее дерево. Исправлено коммитом `8669429`.
  - Прогон `36152424612` (коммит `8669429`) — Typecheck, Lint, Unit-тесты и проверки контракта прошли; failure на шаге Integration test, один тест `catalog-photos.integration.test.ts > asks for the page a picture found on the internet came from`: загрузка получила 503 «The file storage is temporarily unavailable». Это заведомо чужой к задаче файл и известный долг T-8 (замороженный образ MinIO `bitnamilegacy`); локально тот же файл проходит целиком (31 тест). Перезапустить прогон правами моего токена нельзя («Must have admin rights to Repository»), поэтому проверка повторяется прогоном коммита с отчётом — его номер и статус ниже.
  - Прогон `36153651818` (коммит с отчётом `7f14dae`) — та же картина: всё зелёное, кроме одного теста фотографий (`stores the same picture only once for one item (AC-2)`, снова 503 от хранилища), 522 из 523.
  - Прогон `36155245393` (коммит `7516b25`) — **success**: весь набор, включая фотографии, зелёный. Два подряд падения фотографий были случайными; локально этот файл проходил целиком оба раза (31 тест). Итоговое состояние `main` — зелёное, но AC-8 требует зелёного **с первой попытки**, и этого не было.
- **AC-9 — PASS** — `ARCHITECTURE.md` 0.36, раздел 4.33 (I340–I350), уточнения 6.1, 8.4, 14.

**Состав коммитов (D-024):**

1. `a1c7e1b` — `Update project plan and state, add TASK-023 (Product Owner edits)` — правки Product Owner отдельным первым коммитом: `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-023.md`.
2. `9a7bad1` — `Keep active orders for offline, group the history and repeat an order` — реализация: контракт, домен, сервер, тесты, `openapi.json` (34 файла).
3. `4922724` — `Describe the offline copy, the history and the repeat` — `ARCHITECTURE.md`, `CLAUDE.md`.
4. `8669429` — `Commit the rewritten rate limit guard, not only its rename` — `apps/api/src/rate-limit/index.ts`, `apps/api/src/rate-limit/route-rate-limit.guard.ts` (исправление состава коммита 2, см. «Errors & Fixes»).
5. `7f14dae` — `Add the TASK-023 report` — `tasks/TASK-023-REPORT.md`.
6. `7516b25` — `Say in the log why the storage refused a photo` — `apps/api/src/modules/catalog/photo-storage.ts` (вне задачи, см. «Errors & Fixes»).
7. правка отчёта с номерами прогонов CI — `tasks/TASK-023-REPORT.md`.

## Errors & Fixes

- **Тест контракта перечисляет все пути OpenAPI** — после добавления трёх маршрутов `packages/contracts/src/openapi.test.ts` падал; список дополнен.
- **Тест реестра настроек сверяется с таблицей ARCHITECTURE 14** — три новые настройки внесены в таблицу, иначе `registry.test.ts` красный. Это ровно то, для чего тест написан.
- **Нерабочие даты читались без границы** — батчевый `pickupPointsOf` сначала выбирал все даты точки и отсекал прошедшие в коде; добавлено условие `closed_on >= current_date - 2` (запас на любой часовой пояс), точная отсечка «от сегодня» осталась в поясе точки.
- **Состав коммита собран неверно** (главная ошибка задачи). `git add apps/api/src/rate-limit apps/api/src/public-rate-limit` — второй путь переименование уже удалило, git отклонил вызов целиком, и два файла переписанного модуля лимитов ушли в коммит со старым содержимым (`git status` показывал их как `RM` — переименование в индексе плюс незастейдженная правка, и я прочитал это как «всё застейджено»). CI поймал это на Typecheck. Исправлено отдельным коммитом `8669429`; урок — сверять `git diff --cached` по содержимому, а не только `--stat`, когда в коммите есть переименования.
- **Набор фотографий дважды упал в CI** (`catalog-photos.integration.test.ts`, разный тест каждый раз, 503 «The file storage is temporarily unavailable»). Файл к задаче не относится, локально проходит целиком; следующий прогон зелёный — падения случайные, корень — долг T-8 (замороженный образ MinIO). По ходу выяснилось, что `PhotoStorage.put` **глотал причину** (`catch {}`): «хранилище временно недоступно» без единого следа в логе — ни в CI, ни у оператора. Причина теперь пишется в лог рядом с ключом (ключ называет позицию справочника, не человека); отдельным коммитом `7516b25`, вне задачи — как I339 в TASK-022.
- **Локальные прогоны полного интеграционного набора** падали по одному файлу (разному каждый раз) с `Query read timeout` и `Connection terminated unexpectedly`. Причина — насыщение машины 21 параллельным файлом с собственными контейнерами; исправлений не потребовалось, затронутые файлы прогнаны последовательно и зелёные.

## Deviations

- **Признак «закрыта администратором» пользователю не отдаётся.** Требование 2 задачи перечисляет среди признаков записи истории «закрыта ли администратором или поздно (пользователю — без причины)». Это расходится со SCREENS M-ORD-03 («Правила»: «позднее закрытие и закрытие администратором пользователь видит как обычное „Получено“») и с принятым решением D-043 / ARCHITECTURE 4.32 I329 («пользователь видит обычное „выдана“ без способа и без причины»). Сделан безопасный минимум: запись истории несёт `givenOut {at, late}` — поле, которое пользователь уже получает с TASK-022 и которое не раскрывает ни способа, ни причины; `closedByAdmin` в ответ пользователю не добавлен. Решение зафиксировано в ARCHITECTURE I346. Если Product Owner хочет показать пользователю и это, нужно менять SCREENS M-ORD-03 и D-043.
- **`canReview` пока не вычитает заявки с отзывом** — отзывов в системе нет (TASK-049). Сейчас это «выдана и не тестовая»; место для вычитания названо в коде и в I346.
- **`kind_not_supported` недостижим по HTTP** — проверка базы `customer_order_kind_check` разрешает только `kind = 'stock'`, поэтому заявку на услугу нельзя ни создать, ни вставить. Ветка реализована, покрыта юнит-тестом домена и станет достижимой в EPIC-13.

## Known Issues / Risks

- Миграций нет, ручных действий при выкладке не требуется.
- Ключи Redis для перенесённых пределов изменились (`offer-item-search:<id>` → `route:offer_item_search_per_member:member:<id>`, `order-action:<id>` → `route:order_actions_per_member:member:<id>`): существующие счётчики обнулятся один раз при выкладке. Последствий, кроме одного «щедрого» окна, нет.
- `GET /active-orders` при пределе по умолчанию (50) читает до 61 строки заявок и точки выдачи одним запросом. Замера на «десятках активных заявок» под нагрузкой не делалось — предел и отсутствие джойнов каталога держат ответ предсказуемым, но профиля нет.
- Порядок карточек копии считается в приложении (после отбора по сроку в SQL). Пока предел — десятки записей, это дешевле второго запроса; при росте предела стоит перенести сортировку в SQL.
- «Нужен ваш ответ» (`needsAnswer`) у заявок на товар в наличии всегда `false` — поле существует ради EPIC-13 и клиента, который уже сейчас может на него опираться.
- В dev-базе после ручных проверок прошлых задач остаются компании и заявки прошлых прогонов (долг из PROJECT_STATE, TASK-022) — на эту задачу не влияет.

## Remaining Work

- None по функциональности. `main` зелёный (прогон `36155245393`). Осталось только то, что вне задачи: долг **T-8** — набор фотографий изредка падает на 503 от MinIO (замороженный образ `bitnamilegacy`); теперь причина будет видна в логе прогона, и по ней можно выбрать постоянный источник S3-сервера для dev и тестов.

## Future Improvements

- Перенести сортировку карточек копии в SQL, если предел `active_orders_copy_limit` когда-нибудь станет большим.
- `GET /orders?tab=history` и `GET /order-history` теперь дублируют друг друга по смыслу: когда экраны EPIC-10 перейдут на историю по месяцам, первую вкладку можно свернуть до «Активные».
- Массовый `repeat` для нескольких заявок сразу (экран истории показывает «Повторить» у каждой записи, и клиент делает по запросу на кнопку) — если окажется, что экран просит их пачкой.
- Пределы перебора кода (4.32 I325) остались рукописными осознанно; если появится второй счётчик «неудач», его стоит вынести в общий механизм отдельным видом ведра.

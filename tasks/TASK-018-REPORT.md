# TASK REPORT — TASK-018

## Status
COMPLETED

## Result
- **Поиск позиции для поставщика (S-OFF-02)** — `GET /supplier/catalog/items/search`: только по запросу не короче трёх букв или цифр; артикул в любом написании (пробелы, дефисы, регистр не важны, по части) и название на любом из трёх языков; точный артикул первым; только активные запчасти и товары в видимых подкатегориях; страница до 20, не дальше первых 100 совпадений запроса (дальше — 400 «уточните запрос»), общего числа ответ не даёт — справочник целиком получить нельзя. В каждом результате — категория и узел, бренд, артикул, название на языке запроса, миниатюра фото и «уже в ваших предложениях» (`offer {id, status}` своей компании). Лимит на сотрудника — настройка (60 в минуту), сверх — 429 с `Retry-After`.
- **Предложение на товар (S-OFF-03)** — `POST /supplier/offers`: цена в целых тенге в пределах настроек, наличие (в наличии / под заказ), срок в рабочих днях (у «под заказ» больше 0), самовывоз и/или доставка, гарантия (месяцы или текст), свои артикул и название. Самовывоз без адреса точки — 409 `OFFER_PICKUP_NEEDS_ADDRESS` с подсказкой заполнить карточку. Одна позиция — одно предложение у точки (держит база; при одновременном выставлении двумя сотрудниками проходит одно, второе — 409 `OFFER_EXISTS` со ссылкой на существующее). Услуги — 409 `OFFER_NOT_APPLICABLE` (TASK-019).
- **Правка из списка** — `PATCH /supplier/offers/{id}` по полю (или нескольким) с версией; чужая версия — 409 `OFFER_VERSION_CONFLICT`; каждое изменение — в журнал с автором-сотрудником; сохранение тех же значений версию не поднимает. **Снятие и возврат** — `…/withdraw`, `…/return`: снятое не удаляется и видно на вкладке «Снятые»; ответ на возврат несёт `checkPrice: true`. Предложение на позицию, архивированную администратором, остаётся у поставщика, скрыто с причиной `item_unavailable` и в продажу не возвращается (409 `OFFER_ITEM_UNAVAILABLE`).
- **«Мои предложения» (S-OFF-01)** — `GET /supplier/offers`: вкладки «В продаже» / «Снятые» со счётчиками, поиск по названию, артикулу и своему артикулу, отборы «в наличии / под заказ», «без фото», страницы; в строке — цена, наличие, срок, самовывоз/доставка, гарантия, **признак витрины с причинами** и **дата получения** при подтверждении сейчас.
- **Дата получения** — одна чистая функция `receiptDate` в `@adclub/domain` по правилам требования 4 (подтверждены Product Owner); предпросмотр «Клиент увидит» — поле `receipt` каждого предложения и маршрут `GET /supplier/offer-receipt-preview?leadDays=` для несохранённой формы. Без часов работы или без рабочего дня 60 дней подряд дата не считается (`unavailable`).
- **Видимость на витрине** — одно серверное правило (`offerShowcase`, решение — `offerVisibility` в домене; SQL-двойник `shownOffers()` для TASK-020): предложение активно, поставщик не на паузе и не заблокирован, позиция активна, подкатегория и узел видимы, у точки есть город. Пауза и блокировка скрывают, не меняя предложений; после снятия паузы предложения снова видны.
- **Снимок предложения** для заявок — `OfferSnapshots.take(tx, offerId, at)` и схема `offerSnapshotSchema`; не меняется после правки и снятия предложения.
- **Администратор** — `GET /admin/suppliers/{id}/offers`, только чтение, те же вкладки, отборы и признак витрины.

## Changes
Состав коммитов — в разделе «Коммиты» ниже.
- `packages/domain/src/offer/` — `receipt-date.ts` (`receiptDate` и календарные помощники) и `offer-visibility.ts` (`offerVisibility`) с тестами (таблица из 26 случаев даты получения, правило витрины); экспорт в `index.ts`.
- `packages/contracts/src/offers.ts` — схемы предложений, поиска, списка, предпросмотра даты, ошибок, снимка; `routes.ts` — 9 маршрутов; `error.ts` — 6 кодов `OFFER_*`; `login-code.ts` — лимит `offer_item_search_per_member`; `audit.ts` — `offer.created|changed|withdrawn|returned`, сущность `offer`; `settings.ts` — единица `kzt`; `openapi.ts`, `index.ts`; тесты `offers.test.ts`, `openapi.test.ts`. `apps/api/openapi.json` перегенерирован.
- `infra/migrations/1790300000000_create-offers.sql` — таблица `offer` с проверками и составными внешними ключами, ключ `supplier_location (id, supplier_id)`; обратима.
- `apps/api/src/modules/offers/` (новый модуль) — `offers.service.ts`, `offer-item-search.service.ts`, `offer-showcase.ts`, `offer-receipt.ts`, `offer-items.ts`, `offer-snapshots.ts`, `offer-errors.ts`, `offers.controller.ts`, `offers.module.ts`, `schema.ts`, `index.ts`, `offers.integration.test.ts` (29 тестов).
- `apps/api/src/app.module.ts` (один экземпляр модуля справочника для `OffersModule`), `modules/catalog/index.ts` (экспорт текстовых помощников), `modules/settings/registry/registry.ts` (группа «Предложения поставщиков»), `orm-tables.ts`, `testing/database.ts`; тесты `registry.test.ts`, `settings.integration.test.ts`, `database/schema-drift.test.ts` — добавлены группа и таблица.
- `ARCHITECTURE.md` 0.31 — раздел 4.28 (I271–I282), уточнения 5.5, 13.2, 14, версия и история; `CLAUDE.md`, блок 0 — модуль, «Предложения поставщиков в dev», тесты.

## Technical Decisions
Все внесены в ARCHITECTURE.md 4.28 (I271–I282). Главное:
- **Одно предложение на позицию у точки** — уникальный ключ для любого статуса и `INSERT … ON CONFLICT DO NOTHING`: одновременный второй запрос ждёт первый и отвечает 409 со ссылкой (I272, I273).
- **Поставщик видит справочник как пользователь**: черновик, архивная, скрытая и несуществующая позиция — одинаковый 404; услуга — отдельный 409 (I273).
- **Поиск без выгрузки справочника**: минимум 3 буквы/цифры, страница ≤ 20, не дальше 100 совпадений, без общего числа, лимит на сотрудника в Redis; при недоступном Redis поиск обслуживается (это чтение), пределы страниц действуют всегда (I275).
- **Дата получения**: правила Product Owner; дополнительно принято — **без заданных часов дата не считается** (`hours_not_set`), а не «работает всегда»; срок 0 сравнивается с концом последнего интервала дня, перерыв не важен; 60 дней — подряд без рабочего дня после дня подтверждения (I277).
- **Правило витрины** — чистая доменная функция + SQL-двойник, согласованность проверена тестом; ничего не хранится (I278).
- **Снимок** держит строку предложения `FOR SHARE` в транзакции заявки: правка ждёт, заявка получает условия целиком (I279).
- **Модуль справочника** создаётся в `AppModule` один раз и передаётся в `OffersModule` — второго экземпляра провайдеров нет (I271).

## Verification
- `pnpm format:check` — PASS — «All matched files use Prettier code style!»
- `pnpm lint` — PASS — 12/12 задач.
- `pnpm typecheck` — PASS — 18/18 задач.
- `pnpm test` — PASS — 15/15 задач: `@adclub/domain` 127 (в т. ч. 32 теста даты получения — таблица из 26 случаев — и 12 тестов правила витрины), `@adclub/contracts` 110 (в т. ч. `offers.test.ts` — 4), `@adclub/api` 475, `@adclub/api-client` 28, `@adclub/mobile` 68, `@adclub/ui` 28, `@adclub/ui-core` 47, `@adclub/i18n` 8, `@adclub/config` 9.
- `pnpm test:integration` — PASS — 19 файлов, 427 тестов (Testcontainers: PostgreSQL 16, Redis 7), в т. ч. новый `offers.integration.test.ts` — 29 тестов; `database.integration.test.ts` — правила `offer` в базе и откат новой миграции с сохранением поставщиков и позиций; перехват вывода проверил отсутствие токенов, секретов, кодов и номеров в логах всех файлов. Первый полный прогон упал в двух существующих перечнях (список миграций и откаты в `database.integration.test.ts`, список админских маршрутов в `access.integration.test.ts`) — они дополнены новой миграцией и маршрутом, откат теста TASK-017 переведён на существующий помощник `walkDownPast` (средний `migrate up` поднимает и новую миграцию); повторный полный прогон — зелёный.
- `pnpm build` — PASS — 11/11 задач (пакеты, API, веб-приложения, JS-бандл мобильного).
- `pnpm --filter @adclub/api openapi:check` — PASS — «openapi.json matches the contract and the served routes».
- `pnpm --filter @adclub/api openapi:compat --base HEAD` (до коммитов задачи) — PASS — «No breaking changes… Contract is backward compatible», трейлер не нужен.
- `pnpm --filter api migrate` на dev-базе — PASS — `1790300000000_create-offers` применена; откат проверен интеграционным тестом цикла миграций.
- CI на `main` — см. «Коммиты».

## UAT / E2E
В dev (Windows, Docker Compose dev, API `pnpm --filter api dev` — запущен на порту 3100, потому что порт 3000 на машине занят чужим процессом другого проекта; база после `migrate`, `dev:catalog:seed`, `dev:suppliers:seed`), запросами curl от сотрудника «Автомаркета» `+77055550101` (сессия кабинета по коду из `/dev/login-codes`) и от dev-администратора (заведён `admin:grant`, TOTP настроен запросами):
1. Поиск `q=04465 0k090` → одна позиция `04465-0K090`, бренд Geely, «Колодки тормозные передние», категория «Тормозные колодки», `alreadyYours: null`.
2. Выставление 12 500 ₸, в наличии, самовывоз → 201, `version 1`, `showcase {visible: true, reasons: []}`, `receipt {confirmedOn: 2026-09-22, date: 2026-09-22, timeZone: Asia/Almaty}` (подтверждение в 01:22 по Алматы во вторник, точка работает). Предпросмотр `leadDays=0` → 2026-09-22, `leadDays=3` → 2026-09-25.
3. Второе предложение на ту же позицию → 409 `OFFER_EXISTS`, `details.existingOfferId` = id первого; повторный поиск — `alreadyYours {id, status: active}`.
4. Правка цены из списка → `price 13000, version 2`; журнал `GET /admin/audit-log?entityType=offer&entityId=…` — `offer.changed` (`before {price: 12500}`, `after {price: 13000, version: 2}`), роль `supplier`, `supplierMemberId` сотрудника; так же `offer.created`, `offer.withdrawn`, `offer.returned`.
5. Снятие → `withdrawn`, `reasons [offer_withdrawn]`; вкладка «Снятые» — это предложение, `counts {onSale: 0, withdrawn: 1}`; возврат → `checkPrice: true`, `active`, `version 4`, видно.
6. Пауза администратором → `showcase {visible: false, reasons: [supplier_paused]}`, статус и версия предложения прежние (`active`, 4); то же в `GET /admin/suppliers/{id}/offers`; снятие паузы → `visible: true`. PATCH предложения сессией админки → 403 `FORBIDDEN`.
7. Пустой запрос поиска → 400 «Type at least 3 letters or digits»; одна буква → 400; запросы подряд → 429 `RATE_LIMITED` (`offer_item_search_per_member`, `Retry-After: 53`) на 59-м (часть лимита 60 израсходована запросами выше).

Экранов нет (EPIC-11), браузерные сценарии не проходились.

## Acceptance Criteria
- **AC-1 — PASS** — `offers.integration.test.ts`: «is put on an item…» (поля, `version 1`, журнал `offer.created` с `actor_member_id` сотрудника), «checks its fields» (срок 0 у «под заказ», ни самовывоза, ни доставки, две гарантии, цена 0 и дробная, пределы настроек `offer_price_max_kzt`/`offer_lead_days_max`), «takes pickup only with the point's address», «is put only on an active part or product…» (услуга — 409 `OFFER_NOT_APPLICABLE`, архивная и несуществующая — 404), «is one per item of a point…» и «…under concurrency» (три раунда одновременных созданий двумя сотрудниками: одно 201 и одно 409 `OFFER_EXISTS` со ссылкой, в базе одна строка), «change a field with the version…» (версия 2, журнал «было/стало» с автором, чужая версия — 409), «of two simultaneous price changes…», «keep the rules…» (сохранение тех же значений без версии и журнала; `itemId`/`status`/`supplierId` — 400), «withdraw and return…» (`checkPrice: true`, вкладка «Снятые», повторное снятие — 409 `OFFER_STATE`), «an offer on an item archived later…»; `database.integration.test.ts` — уникальный ключ и CHECK в самой базе. В dev — сценарии 2–5.
- **AC-2 — PASS** — «finds the pads by an article in another spelling…», «refuses an empty query, one letter and anything past the first 100 matches», «pages by offset and stops at the limit of matches», «shows only active goods of visible subcategories» (услуга, архивная позиция, скрытая подкатегория не находятся), «marks items already among the company's offers, not another company's», «limits searches per employee (429 with Retry-After)…»; `offers.test.ts` — схема запроса. В dev — сценарии 1, 3, 7.
- **AC-3 — PASS** — «filter by availability, the query… and photo; page by cursor» (вкладки, `counts`, отборы, поиск по артикулу, названию и своему артикулу, «без фото», страницы без повторов), «names in the language of the request», признак витрины с причинами — в тестах «withdraw and return…», «the showcase». В dev — сценарий 5.
- **AC-4 — PASS** — `packages/domain/src/offer/receipt-date.test.ts`: выходные, праздник подряд с выходными (Наурыз), конец рабочего дня и минута до него, перерыв, круглосуточно (и нерабочая дата у круглосуточной), 31 декабря и смена года, часовой пояс (тот же момент в Алматы и Лондоне), 59/60 закрытых дней, без часов; интеграционный «the preview follows the point's schedule…» сверяет маршрут предпросмотра с доменной функцией, нерабочую дату и `hours_not_set`. В dev — сценарий 2.
- **AC-5 — PASS** — «doesn't change after the offer is changed and withdrawn» (снимок равен своей копии после правки цены, доставки и снятия; новый снимок — версия 3 и новые условия) и «a change of the offer waits for the order's transaction holding the snapshot».
- **AC-6 — PASS** — доменные тесты `offer-visibility.test.ts` (каждая причина, все сразу, согласие с `supplierVisibleOnShowcase`); интеграционные «a pause and a block hide the offers without changing them…» (статус, версия и `updated_at` предложения до и во время паузы с блокировкой совпадают; после снятия — `visible: true`), «an archived item and a hidden category hide the offer», «the SQL condition agrees with the rule on every offer». В dev — сценарий 6.
- **AC-7 — PASS** — «the administrator sees a supplier's offers read only…» (список со вкладкой и признаком витрины, неизвестный поставщик — 404, сессия админки на маршрутах кабинета — 403). В dev — сценарий 6.
- **AC-8 — PASS** — «another company's offer is as missing as one that doesn't exist» (просмотр, правка, снятие, возврат — 404, строка не изменилась, в чужом списке 0), «cabinet routes take only a cabinet session; admin routes only an admin one» (мобильная сессия — 403, без токена — 401, кабинет на админском маршруте — 403); `access.integration.test.ts` — список админских маршрутов.
- **AC-9 — PASS** — `openapi:check`, `openapi:compat` (без ломающих изменений, без трейлера), `@adclub/api-client` получил маршруты из `apiRoutes` (тесты клиента зелёные); миграция обратима (тест цикла миграций); `offer` — в `orm-tables.ts` и в сверке схемы (`schema-drift.test.ts`, `database.integration.test.ts`); существующие тесты не ослаблены — дополнены только перечни миграций, маршрутов, таблиц и групп настроек, один откат переведён на `walkDownPast`; перехват вывода всех интеграционных файлов чист.
- **AC-10 — PASS** — коммиты по D-024 с составом ниже; CI коммита `669011e` — #35653194640 `success` с первой попытки; CI коммита отчёта — в следующем коммите.
- **AC-11 — PASS** — ARCHITECTURE.md 0.31: раздел 4.28 (I271–I282), 5.5 (`offer`), 13.2 (расчёт даты), 14 (группа «Предложения поставщиков»), версия, дата, история (тест реестра настроек сверяет ключи раздела 14 — зелёный); CLAUDE.md, блок 0 — модуль `offers`, «Предложения поставщиков в dev», тесты.

## Errors & Fixes
- В первом прогоне интеграционного теста тестовая вставка фото нарушала проверку контрольной суммы (`item_photo_checksum_check`) — ошибка теста, исправлена (64 шестнадцатеричных знака).
- Два случая таблицы даты получения сначала были ошибочны в самом тесте (круглосуточная точка в 19:00 ещё открыта — срок 0 даёт тот же день); случаи переведены на срок 1, функция не менялась.
- Единица `days` у настроек — длительность: `offer_lead_days_max` объявлена через `define.duration`.

## Deviations
- Маршрут предпросмотра — `GET /supplier/offer-receipt-preview`, а не под `/supplier/offers/…`: иначе он спорил бы с `/supplier/offers/{offerId}` (I271). Кроме маршрута, дата есть в каждом предложении.
- Требование 4 не говорит, что делать, если у точки не заданы часы работы: принято «дату не рассчитывать» (`hours_not_set`), как и при отсутствии рабочих дней, — вместо допущения «работает каждый день». Прошу подтвердить при приёмке.
- Требование 6 не включает часы работы и адрес точки в условия видимости — они и не включены: предложение без часов видно, но без даты; предложение с самовывозом остаётся видимым, если администратор позже очистит адрес точки.
- Тип поставщика (`goods`/`services`/`both`) при выставлении не проверяется: задача этого не требует; поставщик «только услуги» технически может выставить предложение на товар. Если нужно запрещать — одно условие в `OffersService.create`.

## Known Issues / Risks
- Статус `suspended` есть в модели и контракте, но ничем не ставится (EPIC-14).
- Поиск позиции — `LIKE` и `strpos` по таблицам, без индекса поиска: для справочника MVP достаточно, полнотекстовый поиск — EPIC-15.
- Лимит поиска при недоступном Redis не действует (осознанно, как у открытых чтений); пределы страниц действуют.
- «Уже в ваших» и выбор точки рассчитаны на одну точку поставщика (MVP); несколько точек — BACKLOG.
- Для прохождения сценариев в dev изменены dev-настройки `login_code_resend_interval_seconds` и `login_code_requests_per_phone` и заведён dev-администратор `+77019990018` — только в локальной dev-базе.

## Remaining Work
None.

## Future Improvements
- Запрет предложений на товары для поставщика типа «только услуги» (решение Product Owner).
- Предупреждение в кабинете, когда у точки не заданы часы работы и поэтому дата получения не показывается.
- Индекс для поиска по названиям (`pg_trgm`) при росте справочника.

## Коммиты
Все коммиты — в `main`, файлы добавлены явно (`git add <путь>`), состав проверен `git diff --cached --stat`.

1. `08cef59` — Update project plan and state, add TASK-018 (Product Owner edits): `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-018.md`.
2. `ce431fa` — Add the receipt date and the showcase rule of offers to the domain: `packages/domain/src/offer/receipt-date.ts`, `receipt-date.test.ts`, `offer-visibility.ts`, `offer-visibility.test.ts`, `packages/domain/src/index.ts`.
3. `a28bddd` — Add the contract of supplier offers: `packages/contracts/src/offers.ts`, `offers.test.ts`, `audit.ts`, `error.ts`, `index.ts`, `login-code.ts`, `openapi.ts`, `openapi.test.ts`, `routes.ts`, `settings.ts`.
4. `be75dcf` — Let suppliers put offers on catalog goods: search, changes, showcase, receipt date, snapshot: `infra/migrations/1790300000000_create-offers.sql`, `apps/api/src/modules/offers/*` (12 файлов), `apps/api/src/app.module.ts`, `modules/catalog/index.ts`, `modules/settings/registry/registry.ts`, `registry.test.ts`, `settings.integration.test.ts`, `orm-tables.ts`, `testing/database.ts`, `database/schema-drift.test.ts`, `database/database.integration.test.ts`, `modules/identity/access.integration.test.ts`, `apps/api/openapi.json`.
5. `669011e` — Describe supplier offers in the architecture and the development guide: `ARCHITECTURE.md`, `CLAUDE.md`.
6. Add the TASK-018 report: `tasks/TASK-018-REPORT.md`.

**CI на `main`:**
- коммиты 1–5 отправлены одним пушем (`cca3996..669011e`); прогон CI последнего из них `669011e` — [#35653194640](https://github.com/ihantrader/adclub.kz/actions/runs/35653194640): `completed / success`, попытка 1 (зелёный с первой попытки; `gh run view 35653194640 --json status,conclusion,attempt`).
- прогон CI коммита с этим отчётом — записан следующим коммитом «Record the CI run of the TASK-018 report commit» (как в TASK-017).

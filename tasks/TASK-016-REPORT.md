# TASK REPORT — TASK-016

## Status
COMPLETED

## Result
- **Справочник городов.** Администратор ведёт города (названия kk/ru/en вручную, часовой пояс, порядок, архив вместо удаления, версии, журнал). Клиенты без входа получают активные города на языке запроса с городом по умолчанию (`GET /cities`, кэш 60 с). Город компаний TASK-006 (текст) перенесён обратимой миграцией: известные названия — к городу справочника с кодом и тремя названиями, прочие — отдельными городами `migrated-<n>`; ни одна компания не потеряла город, `down` возвращает текст. Настройка `default_city` теперь код города справочника, прежнее значение-название продолжает работать.
- **Публичная заявка на подключение** (`POST /supplier-leads`, без входа): БИН с контрольной суммой (подходит и ИИН ИП), казахстанский мобильный номер, согласие со временем и версией текста, язык формы; одинаковый ответ 202 при новом, повторном и уже заведённом БИН; поле-ловушка; ограничение частоты по адресу (сеть IPv6 /64) и по номеру; повтор той же заявки за 10 минут не создаёт вторую; номер и БИН в журнале приложения только маской.
- **Воронка:** `new → contacted → meeting → contract_signed → onboarded`, отказ с причиной и возврат из отказа с причиной; переходы на сервере; ручные заявки, заметки, связанные заявки одного БИН, список с отборами (статус, город, тип, источник, период, БИН, название), счётчиками по статусам и страницами; каждое действие — в журнале действий.
- **Заведение поставщика** — из заявки с подписанным договором или вручную, одной транзакцией: поставщик, точка выдачи (город, адрес, район), первый сотрудник (учётная запись создаётся при необходимости, путь членства TASK-006), приглашение в очередь, заявка «заведён». Два поставщика с одним БИН невозможны (409 со ссылкой на существующего). Приглашение (W-08) отправляет worker через тестовый канал; в dev текст виден на `/dev/supplier-invitations`; повторная отправка ограничена по частоте.
- **Карточка поставщика:** профиль, точка выдачи с районом, часы по дням недели (перерыв, выходные, круглосуточно), нерабочие даты; правка с версиями и журналом. Поставщик видит свою карточку (`GET /supplier/company`, поле `company`) и меняет только часы и нерабочие даты (`PUT /supplier/company/schedule`); адрес и прочее — только администратор.
- **Статусы:** «проверенный партнёр» (с датой договора; снятие с причиной), пауза (оплата / решение администратора) и блокировка (с причиной) — независимы, не закрывают вход в кабинет; единый признак витрины `visibleOnShowcase` (`status = 'active'`, база держит `status` согласованным с паузой и блокировкой).
- **Список поставщиков** с отборами по состоянию, городу, типу, поиском по названию и БИН, страницами.
- **Общее ограничение частоты открытых маршрутов:** маршрут контракта объявляет `rateLimit`, сервер не привяжет его без guard'а; 429 с `Retry-After`; учёт `TRUST_PROXY` и сети IPv6. Применено к форме заявки (без Redis — 503) и к `POST /catalog/compatibility/check` (без Redis — обслуживается); режим «вся подкатегория» проверки совместимости отвечает страницами до 500 позиций.

## Changes
- `packages/domain`: `company/kz-bin.ts` (`checkKzBin`, `kzBinCheckDigit`, `maskBin`), `supplier/supplier-lead.ts` (статусы и переходы воронки), `supplier/supplier-state.ts` (состояние и признак витрины) + тесты.
- `packages/contracts`: `suppliers.ts` (города, заявки, воронка, поставщики, расписание, статусы, ошибки) + `suppliers.test.ts`; `routes.ts` (23 маршрута, поле `rateLimit`), `openapi.ts` (`x-rate-limit`, тег `public`), `error.ts` (8 кодов), `login-code.ts` (4 имени лимитов), `audit.ts` (действия и сущности), `access.ts` (`company` в ответе `GET /supplier/company`), `compatibility.ts` (`limit`, `cursor`, `nextCursor`), `settings.ts` (`reference`); `apps/api/openapi.json` перегенерирован.
- `infra/migrations/1790200000000_create-suppliers.sql` — `city` (с переносом городов компаний), колонки `supplier`, `supplier_location`, `supplier_closed_date`, `supplier_lead`, `supplier_lead_note`, `supplier_invitation`; обратима.
- `apps/api/src/modules/suppliers/*` — новый модуль (сервисы городов, формы, воронки, поставщиков, приглашений; контроллеры; dev-заполнение; интеграционный тест).
- `apps/api/src/public-rate-limit/*` — `PublicRateLimitGuard`, `RateLimitedRoute`; `common/contract/api-route.decorator.ts` — метка `RateLimitGuardMark` и отказ привязать маршрут с лимитом без неё; `redis/rate-limit-subject.ts` — перенесён из модуля входа.
- `apps/api/src/modules/compatibility` — страницы проверки подкатегории, маршрут проверки под лимитом.
- `apps/api/src/modules/identity` — описание `supplier` по новой схеме, город компании из справочника (`supplierCityName`), маршруты карточки кабинета переехали в модуль поставщиков, `addMember` с `addedBy`, `dev:supplier:create` находит или добавляет город.
- `apps/api/src/modules/settings` — группы «Поставщики» и «Открытые маршруты», `default_city` с проверкой по справочнику (`reference: "city"`).
- Подключение: `app.module.ts`, `worker.module.ts`, `operator.ts` (`dev:suppliers:seed`), `background-jobs.ts`, `orm-tables.ts`, `testing/database.ts`, `openapi/check-served-routes.ts`, `catalog/index.ts` (`escapeLike`).
- Тесты, дополненные под новые маршруты, схему и списки: `database.integration`, `schema-drift`, `access.integration`, `session.integration`, `sign-in-data-cleanup.integration`, `compatibility.integration`, `settings.integration`, `registry.test`, `api-route.decorator.test`, `openapi.test`.
- `ARCHITECTURE.md` 0.29 — 4.26 (I244–I258), 5.5, 5.12, 13.2, 14, версия и история; `CLAUDE.md`, блок 0.

## Technical Decisions
Все внесены в ARCHITECTURE.md 4.26 (I244–I258). Главное:
- **`supplier` описан в `identity/schema.ts`** (а не переехал в модуль поставщиков, как предполагал 4.8 I68): на него ссылаются членство и сессия, обратный импорт дал бы цикл (I244).
- **Перенос городов** — каждый различный текст становится городом справочника; `down` возвращает русское название города (регистр/пробелы нормализуются) (I246).
- **`default_city` остаётся строкой**: код города, для совместимости — название; проверка изменения по базе (I247).
- **Форма** проверяет ловушку раньше всех проверок, лимит по адресу — до разбора тела, по номеру — в сервисе; наличие компании до ответа не читается (I248).
- **Переходы воронки** — свободно между рабочими статусами, отказ и возврат с причиной, `onboarded` только заведением из `contract_signed` (I250).
- **Часы работы — на точке выдачи** (`weekly_hours` jsonb, 7 дней × до 3 интервалов, без перехода через полночь), а не на поставщике (I253).
- **`status` поставщика производный** от паузы и блокировки (CHECK в базе) — единый признак витрины (I254).
- **Лимит открытых маршрутов** объявляется в контракте; без Redis форма — 503, чтения — обслуживаются. Остальные открытые чтения (справочник, автомобили, города) лимитом не закрыты — кэш 60 с и прокси (TASK-055); включение — одно поле контракта (I255).
- **Подкатегория проверки совместимости — страницами** по 500 (I256).

## Verification
- `pnpm format:check` — PASS.
- `pnpm lint` — PASS (12/12 задач).
- `pnpm typecheck` — PASS (18/18).
- `pnpm build` — PASS (11/11, включая JS-бандл мобильного).
- `pnpm test` — PASS: domain 80, contracts 102, api 475, api-client 28, ui-core 47, ui 28, mobile 68, i18n 8, config 9 (15/15 задач).
- `pnpm test:integration` — PASS: 17 файлов, 376 тестов (финальный полный прогон после исправлений; до них — 10 падений, см. «Errors & Fixes»). Новые: `suppliers.integration.test.ts` — 25 тестов; тест цикла миграций — перенос города и откат.
- `pnpm --filter @adclub/api openapi:check` — PASS («matches the contract and the served routes»).
- `pnpm --filter @adclub/api openapi:compat --base HEAD` — PASS («Contract is backward compatible with HEAD», без трейлера).
- Миграция на dev-базе с реальными данными (25 компаний, города «Алматы»/«Астана»): `migrate` → 2 города `migrated`, 25 точек выдачи; `migrate:down` — контрольная сумма `md5(id + city)` компаний совпала с исходной; `migrate` снова — PASS.
- Перехват вывода интеграционных тестов (`output-capture.ts`) — PASS: БИН и номера из формы зарегистрированы как коды и в журнале не встречаются.

## UAT / E2E
В dev (Docker Compose, API `pnpm dev`, worker `pnpm --filter api worker`), запросами к API скриптом (администратор — вход по коду из `/dev/login-codes` и TOTP):
1. Заявка с публичной формы → 202 `{"status":"received"}` → в воронке одна заявка `new`.
2. Та же заявка с тем же БИН (другой номер) → тот же ответ 202 → в воронке 2 заявки, у каждой `sameBinLeads: 1`.
3. Неверный БИН → 400 `[{"path":"bin","message":"Not a valid БИН: the check digit doesn't match"}]`; заполненное поле-ловушка → 202, заявок с этим БИН — 0; 12 заявок подряд с одного адреса → 202 ×3, затем 429 с `Retry-After` (лимит 10 в час; в dev без `TRUST_PROXY` все запросы — с 127.0.0.1, 7 обращений того часа уже были сделаны ручными проверками).
4. Заявка → `contacted` → `meeting` → `contract_signed` (200 ×3) → заведение 201: заявка `onboarded`, точка «ул. Райымбека, 200 / Жетысуский район», сотрудник «Марат», приглашение `queued`; через 5 с на `/dev/supplier-invitations` — `sent`, канал `test`, текст «Марат, вас добавили в кабинет поставщика «Детали Юг». Войти: http://localhost:5175».
5. Сотрудник входит в кабинет по коду → `GET /supplier/company` 200 с карточкой (часы `null`) → `PUT /supplier/company/schedule` 200, часы сохранены → `PATCH /admin/suppliers/{id}` адреса из кабинета → 403 `FORBIDDEN`.
6. Пауза (`admin`, «Проверка документов») → `state: paused`, `visibleOnShowcase: false`; сотрудник снова входит по коду (200) и видит карточку (200, `paused`).
7. 125 проверок совместимости подряд → 200 ×120, 429 ×5 (первый отказ — №121, `compatibility_check_per_ip`, `Retry-After: 60`).
Также: `dev:suppliers:seed` — первый запуск создал 16 городов (2 уже были от миграции), поставщика и 2 заявки; повтор — `created` по нулям.

## Acceptance Criteria
- **AC-1 — PASS.** Справочник и клиентский список: тесты «lists active cities…», «is kept by the administrator…», «points the setting default_city…» (`suppliers.integration.test.ts`); перенос компаний без потери: «moves the city text of companies into the directory and back» (`database.integration.test.ts`: «алматы», «Almaty», «Неизвестград», « неизвестград », «Өскемен», пауза и блокировка — вверх и обратно) и dev-база (контрольная сумма совпала).
- **AC-2 — PASS.** Тесты формы: БИН (формат, контрольная сумма, буквы), городской и иностранный номер, согласие, длины, архивный/несуществующий город; одинаковый ответ (новый, повторный, заведённый БИН); ловушка (и с битым БИН); двойная отправка; лимиты по адресу (IPv6 /64, мусорный запрос засчитан) и номеру с `Retry-After`; 100 запросов → 10 принято, 90 × 429; маски `bin=********…`, `phone=+7***4321` в журнале и отсутствие полных значений в выводе и в журнале действий.
- **AC-3 — PASS.** Тесты «moves along the funnel on the server…» (`onboarded` вручную — 409, тот же статус — 409, причина обязательна для отказа и возврата, версия, журнал с причинами), «adds a request by hand, keeps notes and links requests with one БИН», «lists requests newest first with filters, counts per status and pages».
- **AC-4 — PASS.** «creates the supplier, its point, the first employee and the invitation in one step» (worker отправил через тестовый канал, dev-страница, вход сотрудника), «never creates a second supplier with one БИН, and leaves nothing behind» (409 с `existingSupplierId`, ни учётной записи, ни приглашения; гонка двух заведений — 201 и 409), «adds a first employee who works for another company or is an administrator», «sends the invitation again only after the interval and within the daily limit».
- **AC-5 — PASS.** «is changed by the administrator with versions and the journal; the city moves the point», «keeps hours by day of the week and days off; the supplier changes those and nothing else» (перерыв, круглосуточно, выходной, прошедшая и повторённая дата — 400, прошедшая дата остаётся историей, журнал с акторами `admin` и `supplier`, адрес из кабинета — 403).
- **AC-6 — PASS.** «verified partner with the contract date, pause and blocking with reasons; the cabinet stays open» (дата в будущем — 400, пауза `billing`, блокировка, снятие паузы оставляет блокировку, 409 на пустое снятие, вход и сессия кабинета работают при паузе и блокировке, `visibleOnShowcase`, CHECK базы отклоняет рассогласованный `status`); `access.integration` «keeps a paused or blocked company's cabinet open».
- **AC-7 — PASS.** «lists suppliers by state, city and type, and finds them by name or БИН» (все отборы, поиск кириллицей и цифрами БИН, страницы).
- **AC-8 — PASS.** «limits the compatibility check per address with Retry-After, and bounds a subcategory by pages», «without Redis: refuses the request form, keeps serving the reads» (форма — 503 `retryable`, проверка совместимости, `/cities`, `/catalog/categories` — 200; после восстановления форма снова 202), лимиты формы — AC-2; перф-тест совместимости обходит 5 000 позиций страницами по 500 без повторов; `api-route.decorator.test` — маршрут с лимитом не привязывается без guard'а.
- **AC-9 — PASS.** «serves the admin routes to the admin context only…»: 21 админский маршрут — мобильная сессия и кабинет 403 `FORBIDDEN`, без токена 401; 3 маршрута кабинета — мобильная и админка 403, без токена 401; чужая карточка — 404; города и форма — без входа и с любой сессией.
- **AC-10 — PASS.** «fills cities and the example supplier once; a second run creates nothing» (18/1/2, повтор — 0 созданных, 18/1/2 существующих) и ручной запуск в dev.
- **AC-11 — PASS.** `openapi:check`, `openapi:compat --base HEAD` (без трейлера); миграция обратима (тест цикла и dev-база); новые таблицы в `orm-tables.ts`, сверка схемы — PASS; существующие тесты изменены только там, где изменились контракт или схема (полные списки маршрутов, групп, задач; ответ `GET /supplier/company` — проверка `supplier` осталась точной, добавлена проверка `company`; прямой SQL по старой схеме — `city_id`, пауза и блокировка колонками; перф-тест совместимости — страницами), проверки не ослаблены; перехват вывода чист.
- **AC-12 — PASS.** Коммиты — раздел «Commits»; CI — раздел «CI».
- **AC-13 — PASS.** ARCHITECTURE.md 0.29: 4.26 (I244–I258), 5.5, 5.12, 13.2, 14, версия, история; CLAUDE.md, блок 0: структура, «Города и поставщики в dev» (заявка, воронка, заведение, приглашение, пауза, лимиты), тесты.

## Commits
По D-024, в `main`, файлы добавлялись поимённо:

1. `7635669` — Update project plan and state, add TASK-016 (Product Owner edits): `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-016.md`.
2. `453027a` — Check a BIN and the funnel rules of suppliers in the domain package: `packages/domain/src/index.ts`, `packages/domain/src/company/{kz-bin.ts, kz-bin.test.ts}`, `packages/domain/src/supplier/{supplier-lead.ts, supplier-state.ts, supplier.test.ts}`.
3. `a4acc0b` — Add the contract of cities, supplier leads and suppliers: `packages/contracts/src/{access.ts, audit.ts, compatibility.ts, error.ts, index.ts, login-code.ts, openapi.ts, openapi.test.ts, routes.ts, settings.ts, suppliers.ts, suppliers.test.ts}`, `apps/api/openapi.json`.
4. `b89c146` — Take connection requests, keep the funnel, cities and supplier cards, and limit open routes (55 файлов): миграция `infra/migrations/1790200000000_create-suppliers.sql`, модуль `apps/api/src/modules/suppliers/*` (16 файлов), `apps/api/src/public-rate-limit/*`, перенос `rate-limit-subject(.test).ts` в `apps/api/src/redis/` и `redis/index.ts`, `common/contract/*` (метка guard'а и тест), `modules/identity/*` (схема `supplier`, город из справочника, перенос маршрутов карточки, `addMember`, импорты, тесты `access`, `session`, `sign-in-data-cleanup`), `modules/compatibility/*` (страницы, лимит, перф-тест), `modules/settings/*` (группы, `default_city`, тесты), `modules/catalog/index.ts`, подключение (`app.module.ts`, `worker.module.ts`, `operator.ts`, `background-jobs.ts`, `orm-tables.ts`, `testing/database.ts`, `openapi/check-served-routes.ts`), `database/{database.integration.test.ts, schema-drift.test.ts}`.
5. `b3fc87d` — Describe suppliers and the open route limits in the architecture and the development guide: `ARCHITECTURE.md`, `CLAUDE.md`.
6. Коммит этого отчёта — `tasks/TASK-016-REPORT.md` («Add the TASK-016 report»); запись номера его CI-прогона — отдельный коммит «Record the CI run of the TASK-016 report commit» (тот же файл).

Все коммиты — локальная пересборка до пуша: в первой попытке уже проиндексированные переименования `rate-limit-subject` попали в коммит домена; коммиты были сброшены (`git reset --soft`, не запушены) и собраны заново с поимённым составом.

## CI
CI на `main`: прогон **#88** (id 35628176190) коммита `588d6a1` «Add the TASK-016 report» (последний коммит пуша с кодом, документацией и отчётом) — `completed / success`, попытка 1 (по `gh run view`). Коммит с этой записью — отдельный, его прогон проверен так же (см. ответ в сессии).

## Errors & Fixes
- **Подзапросы с неквалифицированными колонками** (`sameBinLeads`, `existingSupplierId`): drizzle пишет колонку однотабличного запроса без имени таблицы, и внутри подзапроса она означала строку подзапроса — 500 «more than one row returned by a subquery». Найдено интеграционным тестом; колонки внешней таблицы названы полностью (`supplier_lead.bin`), так же — `supplierCityName` (`supplier.city_id`).
- **Выбор написания перенесённого города** по `min()` зависел от сортировки локали («неизвестград» вместо «Неизвестград»): берётся написание компании, созданной первой.
- **Первый полный интеграционный прогон — 10 падений**, все — следствия аддитивных изменений: точные списки админских маршрутов, групп настроек, фоновых задач; точное сравнение ответа `GET /supplier/company`; прямой SQL по старой схеме `supplier` (`city`, `status`); перф-тест ожидал всю подкатегорию одним ответом. Тесты обновлены под новый контракт и схему (см. AC-11); после этого — PASS.
- Серверная команда не содержит Redis: публичная форма вынесена в отдельный сервис (`SupplierLeadForm`), который есть только в API-процессе; воронка и заведение работают и из серверной команды (dev-заполнение).
- Python-правки на Windows записали CRLF — исправлено до коммитов, `format:check` PASS.

## Deviations
- **Таблица `supplier` описана в `identity/schema.ts`**, а не перенесена в модуль поставщиков, как ожидал ARCHITECTURE 4.8 I68 (I244) — чтобы избежать циклического импорта; логика — в модуле поставщиков.
- **Часы работы хранятся на точке выдачи**, а не на поставщике, как в черновике 5.5 (`working_days`, `working_hours`) — у каждой будущей точки свои часы; для поставщика с одной точкой разницы нет (I253). 5.5 уточнён.
- **Проверка совместимости подкатегории без `limit` теперь отдаёт не больше 500 позиций** (по требованию задачи и замечанию приёмки TASK-015): контракт аддитивный, но клиент, рассчитывающий на весь список одним ответом, должен идти по `nextCursor`. Клиентов этого маршрута пока нет.
- **Даты «пауза» и «блокировка» существующих компаний** (если статус был выставлен до TASK-016) при переносе — время последнего изменения строки, причина блокировки — «Заблокирован до TASK-016». В dev таких компаний нет.
- Решение «поставщик правит только часы и нерабочие даты» принято, как предлагала задача; если нужно пересмотреть — ограничение в одном маршруте кабинета.

## Known Issues / Risks
- **Приглашение — только тестовый канал** (реальная отправка — TASK-026); текст W-08 на русском, шаблоны kk/ru — с TASK-026. Ссылка «Войти» — первый из `SUPPLIER_WEB_ORIGINS`; без него текст без ссылки.
- **Лимиты по адресу и CGNAT:** много абонентов мобильного оператора за одним IPv4; лимиты — настройки. За обратным прокси обязателен `TRUST_PROXY` (TASK-055), иначе все клиенты — один адрес (в dev это видно сразу).
- **Остальные открытые маршруты чтения** (справочник, автомобили, города) без лимита в приложении — защита кэшем и прокси (I255).
- Откат миграции нормализует написание города компаний (регистр, пробелы) к русскому названию города справочника и удаляет данные новых таблиц (заявки, города, часы) — это откат схемы, а не данных.
- Казахские названия городов в dev-заполнении не проверены носителем языка; БИН в примерах выдуманы.
- Автоматическое снятие паузы по оплате — EPIC-14; учёт паузы и блокировки на витрине — EPIC-07 (признак готов); неотмена текущих заявок при паузе — обязанность EPIC-08.

## Remaining Work
None.

## Future Improvements
- Координаты и регион города (геолокация, ARCHITECTURE 9.8) — колонки `city`.
- Объединение перенесённых городов-дублей одной командой администратора (перенос поставщиков и архив).
- Лимит на открытые чтения справочника в приложении, если прокси окажется недостаточно (одно поле контракта).
- Расчёт даты получения по часам и нерабочим датам точки (ARCHITECTURE 13.2) — вместе с заявками EPIC-08.

# TASK REPORT — TASK-020.A

## Status
COMPLETED

## Result
- **Гарантия не раскрывает поставщика.** Без клубного доступа поля `warrantyText` в предложении карточки нет вовсе (гарантия видна сроком `warrantyMonths`); с доступом — текст. При создании и правке предложения текст гарантии с телефоном, ссылкой (домен, `www.`, `@ник`) или e-mail отклоняется: 400 `OFFER_WARRANTY_CONTACTS` с `details.found` и объяснением правила; сам текст в ошибку не попадает.
- **Одно правило витрины.** Единственная причина, по которой нельзя получить дату, — `scheduleFact` даты получения (`@adclub/domain`): часы не заданы, либо ни один из 60 дней после сегодня не рабочий (дни недели без интервалов или нерабочие даты на весь горизонт). Его берут правило `offerVisibility`, SQL-двойник `shownOffers(at)` и выдача каталога — предложение видно везде или скрыто везде, а поставщик видит `no_working_day` в «Моих предложениях».
- **Устойчивые страницы «Рекомендуемых».** Курсор несёт рамку первой страницы (самую низкую цену списка и веса): уход самого дешёвого предложения и смена весов между страницами больше не сдвигают другие позиции через курсор.
- **Каталог ограничен по частоте.** Список подкатегории и карточка: гость — по адресу (`catalog_read_per_ip`, 300 в минуту, IPv6 — сеть /64, `TRUST_PROXY`), запрос с сессией — по учётной записи с любого адреса (`catalog_read_per_account`, 120 в минуту); сверх — 429 с `Retry-After`; без Redis каталог читается без лимита.
- **Мелочи.** «Услуги только в выбранном городе» — одна функция `offersInReach` для списка, карточки и аналогов. Замена выдачи клубного доступа закрывает прежнюю с причиной «Заменена новой выдачей <id>».

## Changes
- `packages/domain/src/offer/receipt-date.ts` — `scheduleFact(at, schedule)`; `receiptDate` сначала спрашивает его; прежний отказ «60 дней подряд без работы где угодно на пути» (зависел от срока) заменён горизонтом после сегодня. `offer-visibility.ts` — факт расписания = `ScheduleFact` (прежняя `scheduleFact(weeklyHours)` удалена). Новый `warranty-text.ts` — `warrantyTextContacts`. Тесты — таблицы случаев.
- `packages/contracts` — `ShowcaseOffer.warrantyText` необязательное; код `OFFER_WARRANTY_CONTACTS` и `offerWarrantyContactsDetailsSchema`; имена лимитов `catalog_read_per_ip`, `catalog_read_per_account`; поле `perAccount` в `rateLimit` маршрута (только с `auth: "optional"`, проверяет `defineRoute`); лимит у `getShowcaseItems`, `getShowcaseItem`. `apps/api/openapi.json` перегенерирован.
- `apps/api/src/modules/offers` — проверка гарантии в `checkTerms` (на предложение, каким оно станет); `offer-showcase.ts` — правило с расписаниями точек и нерабочими датами, SQL-двойник `shownOffers(at)` с горизонтом (некоррелированный подзапрос по точкам); `offer-errors.ts` — `warrantyContacts`.
- `apps/api/src/modules/showcase` — `clubOnlyOfferFields` (`showcase-visibility.ts`), `offersInReach` (`showcase-offers.ts`), рамка «Рекомендуемых» в курсоре (`showcase-ranking.ts`), маршруты через `RateLimitedRoute` (`showcase.controller.ts`), аналоги через `offersInReach` (`showcase.service.ts`).
- `apps/api/src/public-rate-limit` — счёт по учётной записи (`perAccount`), `RateLimitedRoute` ставит `OptionalSessionGuard` первым для `auth: "optional"`; предупреждение «без Redis» — раз в минуту на каждый лимит (было — одно на все). `identity/session/session.guard.ts` — `optionalSessionOf`.
- `apps/api/src/modules/settings/registry/registry.ts` — четыре настройки лимита каталога (группа «Открытые маршруты»).
- `apps/api/src/modules/club-access/club-access-grants.service.ts` — `replacedReason`, id новой выдачи известен до вставки.
- Тесты: `showcase.integration.test.ts` (Redis за TCP-прокси; новый блок TASK-020.A из 5 тестов; уточнены два прежних ожидания — у гостя поля `warrantyText` теперь нет; причина замены выдачи), `offers.integration.test.ts` (гарантия; нерабочие даты на весь горизонт и открытие дня; горизонт в сверке правила и SQL-двойника).
- `ARCHITECTURE.md` 0.33 — раздел 4.30 (I299–I305), уточнены 4.26 I255, 4.28 I278, 4.29 I287/I289/I293/I294/I295, 5.10, 8.4, 14. `CLAUDE.md` блок 0 — «Доводка каталога в dev», `RateLimitedRoute` и `perAccount`, состав тестов.

## Technical Decisions
Все внесены в ARCHITECTURE.md, раздел 4.30:
- I299 — текст гарантии только с клубным доступом + проверка на контакты при сохранении; название компании не проверяется (зритель с доступом его и так видит), контакты — проверяются (D-026: до принятия заявки их не видит никто). Уже сохранённые тексты не трогаются; следующее сохранение такого предложения (любого поля) отклоняется, пока текст не исправлен; снятие и возврат — не отклоняются.
- I300 — горизонт «60 дней после сегодня» как единственный факт для правила, SQL-двойника и даты; момент один на запрос.
- I301 — рамка первой страницы в курсоре «Рекомендуемых» (вместо изменения формулы оценки: абсолютная цена меняла бы смысл «Рекомендуемых», а смена весов всё равно двигала бы порядок).
- I302 — `perAccount`: сессия считается по учётной записи вместо адреса.
- I303, I304, I305 — одна функция для услуг, причина замены, контракт.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS (после исправления: в регэкспе нормализации пробелов оказались буквальные невидимые символы — заменены на `\u`-экраны)
- `pnpm typecheck` — PASS
- `pnpm test` (unit, все пакеты) — PASS; `@adclub/domain` — 166 тестов (новые: `warranty-text.test.ts` — 29 случаев, горизонт в `receipt-date.test.ts`, факт расписания в `offer-visibility.test.ts`); первый прогон падал на сверке настроек с ARCHITECTURE 14 — исправлено документом
- `pnpm build` — PASS
- `pnpm --filter @adclub/api openapi:check` — PASS
- `pnpm --filter @adclub/api openapi:compat --base HEAD` — ожидаемо 1 error `response-property-became-optional` (`offers/items/warrantyText`); коммит контракта несёт трейлер `Contract-Breaking-Change`, в CI проверка проходит по трейлеру
- `pnpm test:integration` — PASS, 20/20 файлов, 454/454 теста — но не одним прогоном. Первый полный прогон (`pnpm test:integration`) сорвался, потому что Docker Desktop перезапустился во время прогона: контейнеры «Up 6 minutes», Testcontainers — «Could not find a working container runtime strategy», Postgres — «in recovery mode». Второй прогон (`--maxWorkers=4`): 14 файлов PASS, 6 упали на сбоях среды — docker-modem «HTTP code 500 server error», таймауты хуков при старте контейнеров, «Client has encountered a connection error». Эти 6 файлов (session, login-code, offers, translation, suppliers, catalog-photos) перезапущены с `--maxWorkers=2`: 6/6, 212/212 PASS. До этого `showcase` + `offers` отдельно: 55/55 PASS, `showcase` ещё раз отдельно: 24/24 PASS. Полный прогон одним заходом — в CI (Linux): run 35876903839, success.
- CI на `main` — см. AC-7

## UAT / E2E
Dev (Docker Compose, `pnpm dev`, dev-база с сидами и данными прошлых задач; скрипты на HTTP API):
1. Поставщик «Автомаркет» (`+77055550101`) сохраняет гарантию «Автомаркет, +7 705 555 01 01» → 400 `OFFER_WARRANTY_CONTACTS`, `details.found: ["phone"]`, сообщение с объяснением; «12 месяцев по чеку» → 200, версия 5.
2. Карточка колодок `04465-0K090`: гость — ключи предложения без `warrantyText`, `warrantyMonths` есть, поставщик `hidden/auth_required`; пользователь `+77471112233` с клубным доступом — `warrantyText: "12 месяцев по чеку"`, поставщик «Автомаркет».
3. Поставщик закрывает нерабочими датами 62 дня (2026-09-23…2026-11-23) → в «Моих предложениях» `showcase: {visible: false, reasons: ["no_working_day"]}`, `receipt.unavailable: "no_working_day"`; в карточке 4 предложения вместо 5 (у позиции есть предложения других dev-поставщиков); даты убраны → `visible: true`, дата получения 2026-09-23, в карточке снова 5.
4. «Рекомендуемые» (веса `price 1, receipt 0.1`, страницы по 2) в «Моторных маслах»: у единственного предложения позиции «Shell Helix HX8 5W-30, 4 л» цена 800 ₸ (самое дешёвое) → первая страница [HX8 4 л, HX8 1 л] → предложение снято → страницы 2–3 [Mobil Super, Helix Ultra], [Mobil 1 ESP, HX8 ACEA C3]: каждая позиция ровно один раз, все позиции списка показаны. **Замечено:** в первом прогоне снималось самое дешёвое предложение позиции, у которой было и второе предложение (другого поставщика); эта позиция законно получила новый ключ и встретилась ещё раз на следующей странице — остальные позиции по разу. Это свойство любого постраничного вывода по ключу без состояния на сервере (так же у «Дешевле»), описано в ARCHITECTURE 4.30 I301 вместе с правилом для клиента — не показывать позицию с уже показанным id повторно.
5. `catalog_read_per_ip = 5`: шесть запросов списка гостем → 200×5, 429; карточка с того же адреса → 429, `Retry-After: 60`, `details.limit: "catalog_read_per_ip"`; пользователь с сессией с того же адреса → 5×200. Умолчания (300/120): 40 запросов гостя подряд (список и карточка) → все 200.
6. Замена выдачи клубного доступа серверной командой → прежняя `replaced` с причиной «Заменена новой выдачей 975ad799-…».

После проверки dev-стенд возвращён: изменённые настройки сброшены или возвращены к прежним dev-значениям, созданные для прогона предложения на масла сняты, цена чужого предложения восстановлена, текст гарантии колодок очищен; выдача клубного доступа `+77471112233` оставлена (до 2026-12-31).

## Acceptance Criteria
- **AC-1 — PASS.** «Поле отсутствует для роли»: `showcase.integration.test.ts` — «gives the warranty text only with club access…» (гость и пользователь без доступа — ключа `warrantyText` нет, текста нет в теле; с доступом — `[null → "12 месяцев по чеку", 6 → null]`) и уточнённый тест политики видимости (набор ключей пользователя = гостя, с доступом — плюс `warrantyText`). Отказы: `offers.integration.test.ts` — «keeps contacts out of the warranty text…» (телефон в двух написаниях, домен, `@ник`, e-mail → 400 с `details.found`, предложение не создано; правка на текст с номером → 400; сохранённый до проверки текст блокирует правку цены, версия и цена не меняются; очищенный — сохраняется). Юнит — `warranty-text.test.ts` (11 пропусков, 18 находок). Dev — сценарии 1–2.
- **AC-2 — PASS.** `showcase.integration.test.ts` — «one showcase rule: the rule, its SQL twin and the catalog agree…»: на одних данных (горизонт закрыт, один день открыт, всё открыто, без часов, без рабочих дней) множества видимых по `offerShowcase`, `shownOffers(now)` и ответам карточек совпадают, список — те же счётчики, поставщик видит `no_working_day`. `offers.integration.test.ts` — горизонт в сверке правила и двойника, «closed dates over the whole horizon hide the offer with its reason; opening a day shows it». Юнит — горизонт в `receipt-date.test.ts` (факт и дата совпадают на всех сроках и часах). Dev — сценарий 3.
- **AC-3 — PASS.** `showcase.integration.test.ts` — «pages «Рекомендуемые» without skipping or repeating when offers and weights change between pages»: данные подобраны так, что без рамки уход самого дешёвого предложения после первой страницы пропускал бы позицию (проверено порядком нового списка); смена весов и новая позиция между страницами — каждая позиция ровно один раз; испорченная рамка — 400. Прежний тест страниц трёх сортировок проходит. Dev — сценарий 4 (с оговоркой о позиции, у которой изменились её собственные предложения, — см. UAT и Known Issues).
- **AC-4 — PASS.** «limits the catalog: a guest by address (IPv6 by /64), a session by its account; served without Redis»: общий счётчик списка и карточки по адресу, 429 с `Retry-After`, другой адрес свободен; две сессии за исчерпанным адресом — по учётной записи, лимит учётной записи с любого адреса, вторая учётная запись не затронута; сеть IPv6 /64 — один счётчик, соседняя сеть — свой; 40 запросов при умолчаниях — 200; Redis остановлен (TCP-прокси) — гость и сессия получают 200, после возврата Redis лимит снова действует, в журнале «Served without the limit» для обоих лимитов. Размеры — настройки. Dev — сценарий 5.
- **AC-5 — PASS.** «keeps services outside the chosen city out of the analogs…»: услуга-аналог с предложением в Алматы видна в аналогах при городе Алматы и отсутствует при Астане и без города (как предложения самой карточки и список). Услуги сейчас не бывают ни аналогами, ни предложениями (ограничения базы до TASK-019), поэтому тест на время снимает два CHECK-ограничения и возвращает их. Замена выдачи: тест клубного доступа — прежняя выдача `replaced` с `revokeReason: "Заменена новой выдачей <id>"`, у новой — своя причина; журнал — причина каждой выдачи своя. Dev — сценарий 6.
- **AC-6 — PASS.** Контракт: одно ломающее изменение (`warrantyText` стал необязательным) — обосновано трейлером `Contract-Breaking-Change` в коммите контракта (каталог не читает ни один выпущенный клиент; поле обязано отсутствовать без клубного доступа); остальное аддитивно. Существующие тесты не ослаблены: два ожидания изменены по требованию задачи (у гостя поля `warrantyText` больше нет — проверяется отсутствие, а текст — у зрителя с доступом; причина замены выдачи и причина второй выдачи в журнале), проверок не убрано. Перехват вывода интеграционных файлов (`output-capture`) — активен и чист (файлы зелёные).
- **AC-7 — PASS.** Коммиты — только явные пути (раздел Commits), правки Product Owner — отдельным коммитом `86efa0f`. CI: `gh run view 35876903839` — коммит отчёта `55d90b3` (в пуше `e7fddf7..55d90b3` — все пять коммитов): `completed success`, attempt 1, job `ci: success`. В этот прогон входят полный `pnpm test:integration` на Linux одним заходом и `openapi:compat`, прошедший по трейлеру. CI коммита, который записывает этот прогон, — в ответе к отчёту.
- **AC-8 — PASS.** ARCHITECTURE.md 0.33: раздел 4.30 (I299–I305), история, уточнения 4.26, 4.28, 4.29, 5.10, 8.4, 14.

## Commits
- `86efa0f` Update project plan and state, add TASK-020.A and TASK-021 (Product Owner edits) — `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-020.A.md`, `tasks/TASK-021.md`.
- `ec8e32b` Add the contract of the catalog fixes: warranty text, catalog rate limits — `packages/contracts/src/{error,login-code,offers,routes,showcase}.ts`, `apps/api/openapi.json`; трейлер `Contract-Breaking-Change`.
- `236f738` Close the catalog review notes: warranty text, one showcase rule, stable pages, rate limits — `packages/domain/src/index.ts`, `packages/domain/src/offer/{offer-visibility,receipt-date,warranty-text}(.test).ts`, `apps/api/src/modules/club-access/club-access-grants.service.ts`, `apps/api/src/modules/identity/{index.ts,session/session.guard.ts}`, `apps/api/src/modules/offers/{offer-errors,offer-showcase,offers.service,offers.integration.test}.ts`, `apps/api/src/modules/settings/registry/registry.ts`, `apps/api/src/modules/showcase/{showcase-offers,showcase-ranking,showcase-visibility,showcase.controller,showcase.service,showcase.integration.test}.ts`, `apps/api/src/public-rate-limit/public-rate-limit.guard.ts`.
- `563f966` Describe the catalog fixes in the architecture and the development guide — `ARCHITECTURE.md`, `CLAUDE.md`.
- `55d90b3` Add the TASK-020.A report — `tasks/TASK-020.A-REPORT.md`.
- Record the CI run of the TASK-020.A report commit — `tasks/TASK-020.A-REPORT.md`.

## Errors & Fixes
- Прежний тест карточки ожидал `warrantyText` у гостя — ожидание приведено к требованию (поле отсутствует, текст виден с клубным доступом).
- Предупреждение «Served without the limit» было одно на guard для всех лимитов — второй лимит того же guard'а не попадал в журнал в течение минуты; теперь — раз в минуту на каждый лимит.
- В регэкспе нормализации пробелов оказались буквальные невидимые символы (ESLint `no-irregular-whitespace`) — заменены на `\u`-экраны.

## Deviations
- Правило «60 дней подряд без рабочего дня» в `receiptDate` (TASK-018) заменено на «ни одного рабочего дня в 60 днях после сегодня»: прежнее зависело от срока предложения и не выражалось правилом витрины (длинный срок через позднее закрытие давал отказ, короткий — дату). Теперь при рабочем дне в горизонте дата находится всегда, пусть далёкая. Существующие юнит-случаи TASK-018 проходят без изменений.
- «Услуги вне города в аналогах» проверены интеграционным тестом с временно снятыми ограничениями базы — иначе такие данные сейчас невозможны.

## Known Issues / Risks
- Позиция, у которой между страницами изменились её собственные предложения (сняли лучшее, осталось другое), может встретиться ещё раз ниже курсора или не встретиться — как у «Дешевле» и «Быстрее». Клиентам ленты (EPIC-10) — не показывать уже показанный id повторно (ARCHITECTURE 4.30 I301).
- Проверка гарантии ловит очевидное: номер словами, буквы вместо цифр, мессенджер без ника не ловятся (ARCHITECTURE 4.30 I299).
- Сохранённые до этой задачи тексты гарантии с контактами остаются в базе (видны только с клубным доступом) до следующего сохранения предложения; при импорте прайса (будущие задачи) такое предложение не сохранится, пока текст не исправлен.
- Пределы каталога — настройки; при росте гостевого трафика за CGNAT мобильных операторов может понадобиться их поднять.

## Remaining Work
None.

## Future Improvements
- Экран поставщика с объяснением `OFFER_WARRANTY_CONTACTS` по `details.found` (кабинет, EPIC-09) и массовая проверка сохранённых текстов (отчёт оператору).
- Отдельный лимит длинного окна (например, в час) для каталога поверх минутного — если выгрузка каталога всё же будет замечена.

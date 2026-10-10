# TASK REPORT — TASK-019

## Status
COMPLETED

## Result
- Поставщик-сервис выставляет предложение на услугу справочника: **одна цена для всех моделей** или **цены по моделям** (марка → модель из справочника автомобилей, одна строка на модель). У услуги нет наличия, срока, самовывоза и доставки; гарантия, свой артикул и название — как у товара. Правка — с версией, таблица цен по моделям — целиком; снятие и возврат — как у товара.
- **Тип поставщика ограничивает выставляемое**: «только товары» не выставляет и не возвращает услуги и не находит их в поиске, «только услуги» — то же для товаров (409 `OFFER_NOT_APPLICABLE` с `details {supplierType, itemType}`). Выставленное раньше несовместимое остаётся у поставщика, видно в «Моих предложениях» с причиной `supplier_type_mismatch` и не показывается клиентам.
- **Витрина услуг**: только в городе точки поставщика и только при выбранном городе (без города — `empty: city_required`), только с ценой для модели автомобиля («одна цена» — любой модели); часы точки (D-060), пауза, блокировка, тип — одним правилом `offerShowcase` / `shownOffers`.
- **Цена для автомобиля — одна функция** `servicePriceForCar` (`@adclub/domain`): ею пользуются витрина, снимок для будущей заявки и предпросмотр кабинета.
- **Кабинет**: поиск находит услуги (по типу компании), форма S-OFF-04 с переключателем «Одна цена для всех моделей / Цены по моделям», выбором марки и модели с поиском, добавлением и удалением строк, подсказкой «Клиенты с моделями без цены это предложение не увидят», «Клиент увидит» по моделям и ошибками сервера у своей строки; «Мои предложения» — отбор «Услуги», «от N ₸ · M моделей», правка цены в строке только при одной цене.
- **Приложение**: «Услуги в городе {город}» плитками на главной каталога; при «Весь Казахстан» — T-CITY-01 и «Выбрать город» (в шторке города «Весь Казахстан» неактивен); список услуг «от N ₸ для {модель} · N предложений», пустые состояния «В городе {город} пока нет этой услуги» / «Выбрать другой город»; карточка M-CAT-08 — «Услуга в городе {город}», «Цена для {модель}», поставщик по правилам видимости, «Проверенный партнёр», рейтинг, «Запись на услуги появится позже». Смена автомобиля в шапке меняет цену.
- **Админка** показывает у предложений-услуг цены по моделям (поставщик → «Предложения», позиция → «Предложения»).
- Заказать услугу пока нельзя: `POST /orders` на услугу — 409 `ORDER_KIND_NOT_SUPPORTED` (TASK-038).

## Changes
- `infra/migrations/1791000000000_service-offers.sql` — тип `service` у `offer`, нейтральные условия услуги (`offer_service_terms_check`), `price_mode`, таблица `offer_model_price`, отложенный триггер согласованности (цена = минимум строк), откат.
- `packages/domain/src/offer/service-price.ts` (+ тест) — `servicePriceForCar`, `lowestServicePrice`, `supplierOffers`; `offer-visibility.ts` — факт `supplierTypeFits`, причина `supplier_type_mismatch`.
- `packages/contracts/src/offers.ts`, `error.ts` — `pricing`, `modelPrices`, `kind`, `OfferNotApplicableDetails`, `service` в типах позиции и снимка (аддитивно); `apps/api/openapi.json` перегенерирован.
- `apps/api/src/modules/offers` — `offers.service.ts` (выставление и правка услуги, тип компании при выставлении и возврате, отбор `kind`), `offer-pricing.ts` (новый), `offer-showcase.ts` (правило и SQL-двойник с типом), `offer-item-search.service.ts` (поиск по типу), `offer-items.ts` (услуги в ответах), `offer-snapshots.ts` (цена для модели), `offer-errors.ts`, `schema.ts`.
- `apps/api/src/modules/showcase/showcase-offers.ts`, `showcase.service.ts` — `offersInReach` с моделью, пустое состояние `vehicle` для услуги без цены для модели.
- `apps/api/src/modules/orders/orders.service.ts`, `order-views.ts` — услуга не заказывается.
- `packages/ui` — `SearchSelect` и его правила перенесены из админки (`components/SearchSelect.tsx`, `components/search-select-core.ts`, стили), тексты списка — свойство `texts`; `apps/admin-web/src/search-select/*` — реэкспорт.
- `apps/supplier-web/src/offers` — `ServiceOfferEditor.tsx`, `service-offer-rules.ts` (+ тест), `OfferScreen.tsx` (общий `OfferStatePanel`, выбор редактора по типу позиции), `OfferRow.tsx`, `OffersList.tsx`, `ItemSearch.tsx`, `offer-rules.ts`; `app.css`.
- `apps/admin-web/src/catalog/catalog-words.ts` (`offerPriceText`, `offerTermsText`, причина), `ItemOffers.tsx`, `suppliers/SupplierOffers.tsx`.
- `apps/mobile/src` — `screens/catalog/CatalogHomeScreen.tsx`, `ItemListScreen.tsx`, `ItemScreen.tsx`, `parts.tsx`, `CatalogHeader.tsx`, `SubcategoriesScreen.tsx`, `screens/CitySheet.tsx`, `navigation/CatalogStack.tsx`, `routes.ts`.
- `packages/i18n` — тексты кабинета и приложения (kk/ru/en).
- Тесты: `offers.integration.test.ts` (раздел «offers on services»), `showcase.integration.test.ts` (раздел «services»), `on-order.integration.test.ts` (услуга не заказывается), `database.integration.test.ts` (цикл миграции), `schema-drift.test.ts`, `testing/expected/migrations.ts`, `testing/database.ts`, `admin-web catalog-rules.test.ts`.
- `ARCHITECTURE.md` — 4.61 (I627–I636), строки `offer` и `offer_model_price` раздела 5; `CLAUDE.md` блок 0 — «Предложения на услуги в dev».

## Technical Decisions
Внесены в `ARCHITECTURE.md` 4.61:
- I627 — услуга — тот же `offer` с нейтральными наличием/сроком/получением (правило в базе), чтобы контракт остался аддитивным.
- I628 — `price_mode` + `offer_model_price`; в `offer.price` у цен по моделям — минимум (его держит отложенный триггер), поэтому сортировки, «от N ₸» и сводки работают без изменений. Уточнено 5.5: таблица и одна цена — одно из двух, а не «строки нет — базовая цена».
- I629 — модель в архиве: цена остаётся, никто её не видит, новой цены для неё нет (решение агента по TASK).
- I631 — тип поставщика: `supplierOffers` + причина витрины `supplier_type_mismatch` в правиле и SQL-двойнике; существующий код `OFFER_NOT_APPLICABLE` расширен по смыслу (решение агента по TASK).
- I633 — заказ услуги до TASK-038 отказывается явно.
- I634 — `SearchSelect` перенесён в `@adclub/ui`, кабинет и админка используют один компонент.

## Verification
- `pnpm format:check` — PASS — «All matched files use Prettier code style!»
- `pnpm lint` — PASS — 13/13, 0 предупреждений (одно найденное — неиспользуемая переменная в `OfferScreen.tsx` — исправлено)
- `pnpm typecheck` — PASS — 20/20
- `pnpm test` — PASS — 19/19 задач: domain 25 файлов, contracts 18, ui 8, supplier-web 11, admin-web 13, mobile 42, api 54 и др.
- `pnpm build` — PASS — 12/12 (в том числе `expo export` iOS/Android)
- `pnpm --filter @adclub/api openapi:check` — PASS — «openapi.json matches the contract and the served routes»
- `pnpm --filter @adclub/api openapi:compat --base HEAD` — PASS — «Contract is backward compatible with HEAD» (без трейлера)
- Интеграционные (Testcontainers, локально, по файлам):
  - `src/modules/offers/offers.integration.test.ts` + `src/modules/showcase/showcase.integration.test.ts` — PASS — 2 файла, 65 тестов
  - `src/modules/orders/on-order.integration.test.ts` — PASS (в прогоне вместе с database: «1 passed» для этого файла)
  - `src/database/database.integration.test.ts` — PASS — 40/40 (после добавления теста цикла новой миграции; до него 33 теста отката падали — см. Errors & Fixes)
- Миграция на dev-базе: `migrate` → `migrate:down` → `migrate` — PASS
- CI: прогон **38043668443** (push коммитов задачи) — не ожидался (CLAUDE.md §11), результат смотрит архитектор; коммит отчёта запускает ещё один прогон.

## UAT / E2E
Встроенный браузер, локально: `.claude/launch.json` → `api-test-ai`, `supplier-web`, `mobile-web`; dev-база после `migrate` (данные `dev:compatibility:seed`, `dev:suppliers:seed`). Входы — только тестовыми номерами dev-данных (`+77055550101` «Автомаркет», `+77057773636` «Запчасти Юг 036»), коды — `/dev/login-codes`. Панель браузера была скрыта: шторки приложения закрываются по `requestAnimationFrame`, поэтому в странице приложения он подменён таймером (иначе выбор в шторке не применяется — это свойство скрытой панели, не приложения; записано в CLAUDE.md).
1. Кабинет, «Автомаркет» (`both`, Алматы): «Добавить позицию» → «замена» → найдены «Замена моторного масла» и «Замена передних тормозных колодок» с пометкой «Услуга» → форма S-OFF-04 → «Цены по моделям» → марка «джили» → Geely, модель «cool» → Coolray, 8 000; «Добавить модель» → Geely Atlas, 10 000 → «Клиент увидит: Geely Coolray — 8 000 ₸ / Geely Atlas — 10 000 ₸ / Другие модели — не увидят» → «Выставить» → карточка «Видно клиентам». Третья строка Geely Coolray → «Сохранить» — у третьей строки «Эта модель уже есть в таблице», запрос не ушёл. «Мои предложения» → «Услуги» — одна строка «Замена моторного масла · Услуга · от 8 000 ₸ · 2 модели · Цены по моделям — в карточке».
2. Приложение (гость, Geely Coolray 2024, Алматы): Каталог → «Услуги в городе Алматы» (5 плиток подкатегорий) → «Замена масла» → «от 8 000 ₸ для Coolray · 1 предложение» → карточка «Услуга в городе Алматы · Цена для Coolray · 8 000 ₸ · Поставщик клуба · Проверенный партнёр · Новый поставщик · В вашем городе · Запись на услуги появится позже».
3. Смена автомобиля в шапке списка на Geely Atlas 2023 → «от 10 000 ₸ для Atlas»; карточка — «Цена для Atlas · 10 000 ₸».
4. Смена на Geely Monjaro 2023 → «Для Geely Monjaro 2023 здесь пока ничего нет».
5. Город в шапке главной → «Весь Казахстан» → блок «Услуги» — «Услуги показываются только по выбранному городу» и «Выбрать город»; «Выбрать город» → шторка, «Весь Казахстан» не кнопка, с подписью T-CITY-01 → «Алматы» → снова плитки «Услуги в городе Алматы». Город Астана + Coolray → «Замена масла» → «В городе Астана пока нет этой услуги» и «Выбрать другой город».
6. Кабинет, «Запчасти Юг 036» (`goods`): поиск «замена» → «Позиции нет в справочнике…»; «04465» → «Колодки тормозные передние».
Скриншотов нет: при скрытой панели снимки недоступны; проверка — по тексту страницы и DOM.

## Acceptance Criteria
- AC-1 — PASS — миграция `1791000000000_service-offers.sql` (тип `service`, `offer_service_terms_check`, `price_mode`, `offer_model_price`, триггер «цена = минимум»), цикл отката — `database.integration.test.ts` «holds a service's prices by model in the database…» (40/40); правила в базе — тест «the database keeps the rules…» в `offers.integration.test.ts`; доменная функция `servicePriceForCar` с таблицей случаев — `packages/domain/src/offer/service-price.test.ts` (domain 25/25).
- AC-2 — PASS — `offers.integration.test.ts` «the company's type limits what it puts on sale and returns; a misfit stays, off the showcase»: поиск по типу, 409 `OFFER_NOT_APPLICABLE` с `details` при выставлении и возврате, несовместимое после смены типа — `supplier_type_mismatch` в «Моих предложениях», правило и SQL-двойник совпадают.
- AC-3 — PASS — `showcase.integration.test.ts` раздел «services»: только город точки, без города `city_required`, другой город `no_items`, цена для модели (Coolray 8 000, Atlas 10 000, Monjaro — `vehicle`, автомобиль без модели — только «одна цена»), переезд точки, архивная модель; «hides services by the same rule as goods — hours, pause, block, the company's type — and the SQL twin agrees» сверяет `offerShowcase`, `shownOffers()` и выдачу карточки.
- AC-4 — PASS — UAT 1 и 6; `service-offer-rules.test.ts` (строки, дубль, ошибки сервера у строки, «от N ₸ · M моделей», предпросмотр).
- AC-5 — PASS — UAT 2–5.
- AC-6 — PASS — UAT 1–6 (все шесть шагов).
- AC-7 — PASS — `openapi:compat --base HEAD` без трейлера, `openapi:check` PASS.
- AC-8 — PASS — `ARCHITECTURE.md` 4.61 (I627–I636) и строки `offer`/`offer_model_price` раздела 5; `CLAUDE.md` блок 0 — «Предложения на услуги в dev».
- AC-9 — PASS — см. Verification (format, lint, typecheck, test, build, интеграционные изменённых модулей).
- AC-10 — PASS — этот отчёт, прогон CI 38043668443.

## Errors & Fixes
- Первый прогон интеграционных: почти каждое создание предложения — 500. Причина: в функции триггера `CASE … NEW.id … NEW.offer_id` PL/pgSQL вычисляет обе ветви, а у записи `offer` нет поля `offer_id`. Исправлено ветвлением `IF/ELSIF`.
- `database.integration.test.ts`: 33 теста отката сдвинулись — по соглашению файла каждая новая миграция добавляет свой тест в начало «спуска». Добавлен тест цикла новой миграции (с уборкой своих данных) — 40/40.
- `schema-drift.test.ts`: в полном списке таблиц не было `offer_model_price` — добавлена.
- Приложение: «В Астана пока нет этой услуги» — названия городов в именительном падеже; русские тексты переписаны «в городе {город}».

## Deviations
- Тексты «Услуги в {город}», «В {город} пока нет этой услуги» по-русски записаны как «Услуги в городе {город}», «В городе {город} пока нет этой услуги»: названия городов приходят в именительном падеже («в Астана» было бы неграмотно). Казахский и английский — по смыслу SCREENS.
- В карточке услуги нет «описания»: у позиций справочника нет такого поля (TASK-011). Пустой блок фото у услуги не показывается.
- `ARCHITECTURE.md 5.5` описывал `offer_model_price` как «строки нет — базовая цена»; TASK-019 требует «одно из двух» — уточнено в 5.5 и 4.61 I628.
- Пример «Что должно реально работать» — «Шины Юг» в Астане; в браузере пройдены те же шаги на «Автомаркете» в Алматы, как требует AC-6.

## Known Issues / Risks
- Казахские тексты не проверены носителем языка (как и прежние).
- Сортировка «Быстрее» и фильтры наличия/получения у услуг не показываются приложением; сервер их принимает как у товаров (на результат не влияют).
- Удаление всей таблицы цен при откате миграции удаляет предложения на услуги — заявок на них не бывает (заказ услуги отказывается).

## Remaining Work
None

## Future Improvements
- Цена по поколению (в старой модели данных было `generation_id?`) — если поставщики попросят.
- Отбор «Товары» в «Моих предложениях» (контракт уже умеет `kind=goods`).

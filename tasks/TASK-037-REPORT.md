# TASK REPORT — TASK-037

## Status
COMPLETED

## Result
Сервер принимает заявку на товар «под заказ» и ведёт её по второму автомату (ARCHITECTURE 6.2) в той же таблице переходов:

- `POST /orders` на предложение «Под заказ» создаёт заявку `kind: "on_order"`; снимок фиксирует срок (`leadDays`), заявка — его дату по рабочим дням точки (`onOrderTerm.expected`); поставщикам уходит W-01a с кнопками «Подтвердить срок · Отказать · Открыть» (тестовый канал).
- «Подтвердить срок» — прежний `POST /supplier/orders/{id}/accept` или кнопка W-01a в WhatsApp: статус `accepted` = «Срок подтверждён», дата — `receiptDate` от подтверждения, резерва нет, телефон клиента открывается, W-02 нажавшему.
- «Предложить другой срок» — `POST /supplier/orders/{id}/propose-term {expectedVersion, leadDays}`: `term_proposed`, дата по рабочим дням точки, ответ клиента — до `term_agreement_hours`; тот же срок, 0 и больше `offer_lead_days_max` — 400 у `leadDays`.
- Пользователь видит «Нужен ваш ответ до …» (`onOrderTerm.proposed`, в копии без сети — `needsAnswer: true`, `mainDate.kind: "answer_by"`, первой в списке) и отвечает: `POST /orders/{id}/term/agree` → `accepted` с предложенными сроком и датой, телефон открывается, W-02 предложившему сотруднику; `…/term/reject` → `cancelled_by_user`, W-04; отмена — тоже W-04; молчание — свипер (или первое чтение) переводит в `term_expired`.
- «Готово к выдаче» — резерв `on_order_pickup_reserve_hours` от этого момента; выдача по коду/QR — из «срок подтверждён» и «готова».
- Просрочка поставки (подтверждённая дата прошла, а заявка не готова) — заметка `supply_overdue` в журнале и сигнал `supply_overdue` администратору, один раз на заявку; статус не меняется; тестовая заявка сотрудника сигнала не поднимает (`countsInStatistics`).
- Администратор продлевает ответ пользователя на срок (`deadline: "term"`), отменяет и закрывает такую заявку.
- Приложение, кабинет, админка и сканер показывают заявку «под заказ» словами статуса и сроком; «Оформить» у «Под заказ» в приложении по-прежнему выключено (TASK-039).

## Changes
- **Домен** (`packages/domain/src/order/`): `order-machine.ts` — вид заявки как измерение таблицы (`orderTransition(from, action, kind)`, `orderKinds`), ходы `propose_term`, `agree_term`, `reject_term`, `expire_term`, статусы `term_proposed` (активный), `term_expired` (конечный), `answerAwaitingOrderStatuses`/`orderNeedsAnswer`; `order-term.ts` (новый) — `proposedTermProblem`, `termAnswerBy`, `supplyOverdueAt`; `order-close.ts`, `order-supplier-rights.ts` (`propose_term` — только кабинет), `order-repeat.ts` (повтор «под заказ» разрешён).
- **Миграция** `infra/migrations/1790950000000_on-order-orders.sql` — вид, статусы, колонки срока, проверки, индексы свипера, новые действия журнала; откат обратим.
- **Сервер** (`apps/api/src/modules/orders/`): `order-transitions.ts` (ходы, просрочка, продление `term`), `orders.service.ts` (создание, `proposeTerm`, `answerTerm`, списки кабинета), `orders.controller.ts` (три маршрута), `order-views.ts` (`onOrderTerm`, `needsAnswer`, `answer_by`, `termAnswerBy`), `order-notices.ts` (W-01a, `termAgreed`, `NEW_ORDER_TEMPLATES`), `order-notice-texts.ts` (`termText`, слова W-03), `order-button-presses.ts`, `order-deadlines.ts`, `order-notice-channel.ts`, `order-cleanup.ts`, `schema.ts` (`activeOrderStatusList`); `users/admin-users.service.ts`; `messaging/message-templates.ts` (W-01a отправляется).
- **Контракт** (`packages/contracts/src/`): `orders.ts` (вид, статусы, действия, `onOrderTermSchema`, тела маршрутов, `answer_by`, `term`), `routes.ts`, `signals.ts` (`supply_overdue`), `error.ts`; `apps/api/openapi.json`.
- **Клиенты**: приложение — `orders/order-status.ts`, `order-view.ts`, `active-orders.ts`, `checkout.ts`, `screens/orders/OrderScreen.tsx`, `CheckoutScreen.tsx`, `parts.tsx`; кабинет — `orders/order-rules.ts`, `OrderParts.tsx`, `OrderScreen.tsx`, `OrdersList.tsx`, `scan/scan-rules.ts`; админка — `orders/order-words.ts`, `OrderCard.tsx`, `Orders.tsx`, `signals/signal-words.ts`, `home/Home.tsx`; тексты kk/ru/en — `packages/i18n/src/{mobile,supplier}/*.json`.
- **Тесты**: `apps/api/src/modules/orders/on-order.integration.test.ts` (новый, 21 тест), тест миграции в `database/database.integration.test.ts`, юнит-тесты домена, текстов уведомлений, клиентов; списки `testing/expected/migrations.ts`, `integration-weights.json`, `contracts/openapi.test.ts`.
- **Документы**: `ARCHITECTURE.md` — раздел 4.59 (I608–I618) и «Реализовано в TASK-037» под таблицей 6.2; `CLAUDE.md` блок 0 — «Заявки под заказ в dev».

## Technical Decisions
Все — в `ARCHITECTURE.md` 4.59:
- I608 — вид заявки — обязательный параметр единственной таблицы переходов.
- I609 — «срок подтверждён» = `accepted` вида `on_order`; новые `term_proposed` (активный) и `term_expired` (конечный, не `response_expired` — молчание пользователя не судит поставщика); списки активных статусов в SQL — из одного определения.
- I610 — ходы `on_order`; при согласии срок и дата — те, что показаны с предложением; `decline` из `term_proposed` не разрешён (таблица 6.2 его не даёт).
- I611 — колонки срока в `customer_order`, правила в базе, обратимый откат.
- I612 — просрочка поставки: заметка и сигнал один раз, статус не меняется.
- I613 — `onOrderTerm` одинаков для всех сторон; телефон — только после `accept` или `agree_term`.
- I614 — уведомления существующими шаблонами (W-01a, W-02, W-04).
- I615 — продление ответа пользователя через тот же `OrderTransitions.extend` (`deadline: "term"`) — решение агента.
- I616 — контракт аддитивен, кроме осознанного `oneOf` сканера (трейлер `Contract-Breaking-Change`).
- I617 — клиенты до TASK-039 показывают, но не предлагают новых действий.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS
- `pnpm typecheck` — PASS (20/20 задач)
- `pnpm test` — PASS (19/19 задач; первый прогон упал на `contracts/openapi.test.ts` — список путей не знал трёх новых маршрутов, исправлено)
- `pnpm build` — PASS
- `pnpm --filter @adclub/api openapi:check` — PASS
- `pnpm --filter @adclub/api openapi:compat --base HEAD` — ожидаемый FAIL ровно на двух пунктах `response-body-one-of-added` (`POST /supplier/orders/lookup`, `/close`); коммит несёт трейлер `Contract-Breaking-Change`
- Интеграционные (Testcontainers):
  - `src/modules/orders/on-order.integration.test.ts` — PASS, 21/21 (142 с)
  - `src/database/database.integration.test.ts` — PASS, 39/39 (цикл миграций с новой)
  - `src/modules/orders/order-notices.integration.test.ts` — PASS, 34/34
  - `src/modules/orders/orders.integration.test.ts`, `src/modules/users/admin-users.integration.test.ts`, `src/modules/admin-home/admin-panel.integration.test.ts`, `src/database/schema-drift.integration.test.ts` — PASS, 102/102
  - Весь набор интеграционных локально не запускался (CLAUDE.md §11) — его выполняет CI.
- CI — NOT RUN к моменту отчёта (по CLAUDE.md §11 агент CI не ждёт): прогон `38036237011` (push коммитов f6e19b5, 7490d5e, ddc3aa1; вместе с ним уходит коммит с этим отчётом, у которого будет свой прогон). Коммит сервера f6e19b5 несёт трейлер `Contract-Breaking-Change`.

## UAT / E2E
- **Dev-стенд (локальный Docker, API с тестовым ИИ, worker, кабинет в встроенном браузере)**, после `pnpm --filter api migrate`: скриптом через настоящий API сотрудник «Автомаркета» (`+77055550101`) и тестовый пользователь `+77019990371` (клубный доступ выдан серверной командой) — три заявки на масло Mobil Super 3000 «под заказ» (срок предложения 1 раб. день): №1035 новая, №1036 — предложен срок 5 раб. дней (`term_proposed`, `readyOn` 15 октября, `answerBy` +24 ч), №1037 — срок подтверждён. Копия без сети пользователя: №1036 первой с `needsAnswer: true` и `mainDate.kind: "answer_by"`. W-01a ушло в тестовый канал на языке каждого получателя («11 қазан» / «11 октября»); у №1036 и №1037 W-01a отменены шлюзом — заявку обработали раньше отправки.
- **Кабинет в браузере** (`localhost:5175`, вход сотрудником «Автомаркета»): «Новые · 1» — №1035 с кнопками «Отказать» / «Подтвердить срок»; «В работе» — группа «Готовятся» с «Срок подтверждён» №1037 и группа «Ждут ответа клиента · 1» с №1036 «Клиент ответит до завтра, 12:20»; карточка №1036 — «Телефон откроется после принятия заявки», «Срок: Предложен другой срок: 5 раб. дн., до 15 октября. Клиент ответит до завтра, 12:20», журнал «Другой срок — Ерлан, 12:20: 5 раб. дн., до 15 октября», кнопок нет; карточка №1037 — имя и телефон клиента, «Срок подтверждён: 1 раб. дн., до 11 октября», кнопки «Готово к выдаче», «Выдать по QR / коду», «Отказать». Панель браузера была скрыта (0×0) — проверено по тексту страницы, без снимков экрана. Найдено и исправлено по ходу: dev-сервер кабинета держал старый пребандл `@adclub/i18n` и показывал ключ `orders.confirmTerm` — после очистки `node_modules/.vite` текст на месте (это кэш dev-сервера, не код).
- **Приложение и админка в браузере — не проходились.** Приложение: строки статусов и главной даты проверены юнит-тестами (`order-status.test.ts`, `active-orders.test.ts`), экран — только `tsc`. Админка: слова и строка срока — юнит-тесты (`order-words.test.ts`), админские ответы с `onOrderTerm`/`termAnswerBy` — интеграционным тестом; вход в админку тестовым администратором с TOTP не выполнялся.
- Dev-база после проверки содержит три тестовые заявки №1035–1037 и предложение Mobil «под заказ» (оно было таким и до проверки).

## Acceptance Criteria
- **AC-1 — PASS.** Таблица `on_order` в `orderTransition` (`packages/domain/src/order/order-machine.ts`); `order-machine.test.ts` перебирает все пары «статус × действие × вид» (домен: 7 файлов, 139+ тестов PASS); миграция `1790950000000_on-order-orders.sql` с откатом — тест «holds the term of an order under order in the database, and rolls back keeping the orders (on order orders)» в `database.integration.test.ts` (39/39 PASS).
- **AC-2 — PASS.** `on-order.integration.test.ts` 21/21: ««Подтвердить срок» in WhatsApp → ready with its own reserve → given out by the code»; «another term → the user agrees → W-02 to who proposed it → ready → given out»; «another term → the user says no: cancelled by the user, W-04»; «another term → silence: the order expires once…» (два свипера одновременно, один переход); ««Подтвердить срок» in WhatsApp against another term in the cabinet… (six rounds)»; «an overdue supply is noted once and signalled once; the status stays»; «lets only the user of the order answer and only an employee of its company propose» (404 чужим, 403 контекстам, 401 гостю, 409 чужой версии).
- **AC-3 — PASS.** «gives the code and the QR to the user only, and the phone only once the term is confirmed»: в ответах поставщика и администратора нет кода и QR, телефона до согласия нет, после — `revealed`; в пути с предложением `phone_revealed_at` пуст до согласия, запись `order.phone_revealed` с ролью `user`.
- **AC-4 — PASS.** Тестовый канал: W-01a `order_new_on_order` с кнопками «Подтвердить срок», «Отказать», «Открыть» и без телефона/кода; нажатие «Подтвердить срок» через вебхук → `accept` каналом `whatsapp`, W-02 нажавшему; W-02 предложившему после согласия; W-04 после «нет» и после отмены — всё в `on-order.integration.test.ts`; на dev-стенде W-01a ушло в тестовый канал.
- **AC-5 — PASS (кабинет — в браузере, приложение и админка — юнит-тестами и `tsc`).** Кабинет — UAT выше; сканер — интеграционные тесты (`ready` для «срок подтверждён», `refused/not_accepted` для `term_proposed`, `refused/term_expired`) и `scan-rules.ts`; приложение — `order-status.test.ts` (строки «Поставщик подтвердил срок», «Нужен ваш ответ», «Вы не ответили…»), `checkout.test.ts` (`canOrderOffer({availability: "on_order"}) === false`), оформление дополнительно отказывает «под заказ»; админка — `order-words.test.ts`.
- **AC-6 — PASS.** `openapi:check` PASS; `openapi:compat` — только два признанных `response-body-one-of-added` сканера; трейлер `Contract-Breaking-Change` в коммите сервера.
- **AC-7 — PASS.** `ARCHITECTURE.md` 4.59 (I608–I618) и «Реализовано в TASK-037» под таблицей 6.2; `CLAUDE.md` блок 0 — «Заявки под заказ в dev».
- **AC-8 — PASS.** См. Verification.
- **AC-9 — PASS.** Этот отчёт, идентификатор прогона CI — в Verification.

## Errors & Fixes
- Однострочник `node -e` с обратными кавычками в bash подменил часть текста замены в `order-repeat.ts` (файл не испорчен — строка просто не заменилась); дальше правки только инструментом Edit и скриптами из файлов (CLAUDE.md §8).
- Первый скрипт вставки ключей переписал JSON словаря через `JSON.stringify` и убрал пустые строки между группами — откатил три файла (`git checkout` только их, других правок в них не было) и вставил ключи построчно.
- `contracts/openapi.test.ts` и `database.integration.test.ts` держат полные списки маршрутов и миграций — добавлены три пути и тест цикла новой миграции.
- Dev-сервер кабинета показывал ключ вместо текста из-за старого пребандла — `node_modules/.vite` очищен (не код).
- `database.integration.test.ts`: вспомогательная `walkDownPast` откатывала не больше 20 миграций, а после новой миграции тесту `ai_job` нужно 21 шаг — предел стал числом миграций в списке (это защита от бесконечного цикла, не проверка).
- `orders.integration.test.ts`: проверка «предложение под заказ → 409 `ORDER_KIND_NOT_SUPPORTED`» описывала поведение, которое задача отменила; убрана, создание заявки под заказ покрыто `on-order.integration.test.ts`.
- Первый общий прогон шести интеграционных файлов в три потока (вместе с `pnpm test` и `pnpm build` на той же машине) завис больше чем на 20 минут; процессы остановлены, те же файлы по одному/последовательно прошли без зависаний (`order-notices` — 34/34 за обычное время). Причину зависания под нагрузкой не установил — в коде задачи её не видно; CI гоняет части параллельно на отдельных машинах.

## Deviations
- `decline` из `term_proposed` не разрешён — его нет в таблице 6.2; поставщик, передумавший после предложения, ждёт ответа клиента или обращается к администратору (`admin_cancel` разрешён). Если Product Owner хочет «Отказать» и там — одна строка таблицы.
- Истечение молчания пользователя — свой статус `term_expired`, а в 6.2 написано `expired`; так решено, чтобы не смешивать с `response_expired` (молчание поставщика) — 4.59 I609.
- «Повторить» заявку под заказ сервер разрешает (`orderRepeatDecision`), но приложение до TASK-039 оформление «под заказ» не откроет — покажет «Заявки под заказ появятся позже».
- `late_cancel` в дисциплину при отмене после подтверждения срока (6.2) не сделан — как и у товара в наличии, это EPIC-19.

## Known Issues / Risks
- Казахские тексты новых статусов и W-03 «басқа мерзім ұсынылған» — рабочий черновик, носителем языка не проверены (как и прежние, 4.35 I368).
- Push пользователю о предложенном сроке и о просрочке — TASK-051; до этого пользователь узнаёт о предложении только в приложении (поэтому администратор может продлить ему ответ).
- Экраны новых действий (предложить срок, согласиться/отказаться, продлить ответ в админке) — TASK-039.

## Remaining Work
None.

## Future Improvements
- Вид заявки в ответе сканера (`SupplierScanOrder.kind`), чтобы экран выдачи писал «Срок подтверждён» вместо «Принята» — изменение того же `oneOf`, лучше вместе с TASK-039.

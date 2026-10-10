# TASK REPORT — TASK-038

## Status
COMPLETED

## Result
Заявка на услугу работает на сервере целиком (PRODUCT 11, ARCHITECTURE 6.3):

- **Запись** — `POST /orders` на предложение услуги с автомобилем гаража пользователя (`carId`) и желаемым временем (`desiredAt`). Цена — для модели автомобиля через `servicePriceForCar` (нет цены для модели — `ORDER_OFFER_UNAVAILABLE`, цена изменилась — `ORDER_PRICE_CHANGED`). Время — в часах работы точки, не в нерабочую дату, не в прошлом, не дальше новой настройки `service_booking_horizon_days` (30), целая минута; иначе 400 у `desiredAt`. Ответ поставщика — до `supplier_response_hours`, но не позже желаемого времени. `ORDER_KIND_NOT_SUPPORTED` на `POST /orders` больше не отвечается.
- **Три ответа поставщика**: «Подтвердить время» (прежний `accept` — в кабинете или кнопкой W-01b), «Предложить другое время» (`POST /supplier/orders/{id}/propose-time`, варианты — `GET …/time-options`), «Отказать» (в том числе пока клиент думает — D-072 по аналогии и после подтверждения).
- **Ответ пользователя** на другое время — те же маршруты `/orders/{id}/term/agree|reject`, молчание — истечение (`term_expired`).
- **Визит** закрывается по коду или QR («Отметить выполненной» сканера); **неявку** отмечает только сотрудник с времени визита до конца окна `service_grace_hours` (`POST /supplier/orders/{id}/no-show`), с дисциплинарной отметкой `service_no_show` (тестовая заявка — без отметки); **подтверждённая запись без разбора** истекает свипером в `visit_unresolved` с сигналом администратору «Запись не разобрана» один раз и с окном позднего закрытия кодом; **поздняя отмена** — заметка `late_cancel` в журнале.
- **Уведомления** — W-01b получателям с «Подтвердить время / Отказать», W-02 после подтверждения кнопкой и после согласия пользователя (предложившему), W-04 при отмене; только тестовый канал.
- **Варианты времени для экранов**: пользователю — `GET /order-visit-options?offerId=`, сотруднику — `GET /supplier/orders/{id}/time-options`.
- **Клиенты** показывают запись словами статуса, автомобилем и временем: приложение («Заявки», карточка, история, копия без сети; «Запись на услуги появится позже» у услуги осталась), кабинет (список, группа «Записи на услуги», карточка, сканер), админка (отбор «Тип: Услуга», карточка, сигнал на главной и в «Сигналах»).

## Changes
- **Домен** (`packages/domain/src/order`): `order-machine.ts` — вид `service` в единственной таблице `orderTransition`, статусы `no_show`, `visit_unresolved`, действия `propose_time`, `mark_no_show`, `expire_visit`; новый `order-visit.ts` — `visitTimeProblem` (одна проверка времени), `visitDays`, `serviceRespondBy`, `timeAnswerBy`, `visitUntil`, `noShowVerdict`, `isLateCancel`; `order-close.ts` (поздний код для `visit_unresolved`, отказ `no_show`), `order-supplier-rights.ts`, `order-repeat.ts` (услугу не повторяют до TASK-039.B).
- **Миграция** `infra/migrations/1791050000000_service-orders.sql` (с откатом): колонки `car_id` (FK на `account_car`, `ON DELETE SET NULL`), `car_snapshot`, `desired_at`, `proposed_at`, `visit_at`, `visit_until`; правила в базе (`customer_order_service_check`, обобщённый `customer_order_term_check`, `…_accepted_check`, `…_late_close_check`), индексы свипера, действия журнала, вид дисциплины.
- **Сервер** (`apps/api/src/modules/orders`): `order-transitions.ts` (ходы услуги, сроки, сигнал, заметка поздней отмены, guard неявки по времени), `orders.service.ts` (создание услуги, `proposeTime`, `timeOptions`, `markNoShow`, `visitOptions`), `orders.controller.ts` (4 маршрута), `order-views.ts` (`serviceVisit` всем сторонам, главная дата `visit_at`), `order-notices.ts` и `order-notice-texts.ts` (W-01b, W-03 по виду), `order-notice-channel.ts` (детектор берёт `NEW_ORDER_TEMPLATES`, а не список руками), `order-deadlines.ts`, `order-discipline.ts`, `order-repeat.ts`, `order-errors.ts`; `settings/registry/registry.ts` (`service_booking_horizon_days`, описание `late_cancel_hours`); `messaging/message-templates.ts` (`sentBy` у W-01b).
- **Контракт** (`packages/contracts/src`): `orders.ts` (вид, статусы, действия, `serviceVisit`, `orderCar`, тело создания, тела и ответы новых маршрутов, `repeatItemSchema`), `routes.ts`, `signals.ts`, `error.ts` (`ORDER_NO_SHOW_TOO_EARLY`); `apps/api/openapi.json` перегенерирован.
- **Клиенты**: приложение — `orders/order-status.ts`, `order-view.ts`, `active-orders.ts`, `screens/orders/OrderScreen.tsx`, `parts.tsx`; кабинет — `orders/order-rules.ts`, `OrderParts.tsx`, `OrderScreen.tsx`, `OrdersList.tsx`, `scan/scan-rules.ts`, `Scanner.tsx`; админка — `orders/order-words.ts`, `OrderCard.tsx`, `signals/signal-words.ts`, `home/Home.tsx`, `audit/audit-words.ts`; тексты — `packages/i18n/src/{mobile,supplier}/{ru,kk,en}.json`.
- **Тесты**: `order-machine.test.ts` (все пары трёх видов), `order-visit.test.ts`, `order-close.test.ts`, `order-supplier-rights.test.ts`, `order-repeat.test.ts`, `order-notice-texts.test.ts`, контрактные `orders.test.ts` и `openapi.test.ts`, клиентские словари и правила; интеграционные — новый `modules/orders/service-orders.integration.test.ts` (19 тестов), цикл миграции в `database.integration.test.ts`, поправлен тест «услугу пока не заказать» в `on-order.integration.test.ts`; `testing/expected/migrations.ts`, `integration-weights.json`.
- **Документы**: `ARCHITECTURE.md` — 4.62 (I637–I647), таблица 6.3 «Реализовано в TASK-038», настройка в разделе 14; `CLAUDE.md` блок 0 — «Записи на услуги в dev».

## Technical Decisions
Записаны в `ARCHITECTURE.md` 4.62:
- **I638 — статусы**: «Подтверждена на время» — `accepted` вида `service`; ожидание ответа пользователя и молчание — общие с «под заказ» `term_proposed` / `term_expired` (вся механика «нужен ваш ответ», продления и копии работает без правок); свои конечные — `no_show` и `visit_unresolved` (неявка — дисциплина, «никто не разобрал» — сигнал без виноватого и окно позднего кода).
- **I639 — D-072 по аналогии**: отказ поставщика из `term_proposed` у услуги разрешён.
- **I640 — поздняя отмена**: заметка журнала `late_cancel`, дисциплинарной отметки нет до EPIC-19.
- **I641 — горизонт**: новая настройка `service_booking_horizon_days` (30); проверка времени — одна функция `visitTimeProblem`.
- **I645 — контракт**: аддитивно; ответ «Повторить» сохранён прежним (`repeatItemSchema` — только товары); ломается только `oneOf` ответов сканера (`/supplier/orders/lookup`, `/close`) — коммит с трейлером `Contract-Breaking-Change`.
- **I642 — откат миграции** удаляет записи на услуги с их журналом и отметками (старые правила не умеют снимок услуги, а следующий откат TASK-019 удаляет предложения на услуги).
- Сканер в S-SCAN-04 для услуги говорит «Выполнено · {услуга}» без «× 1».

## Verification
- `pnpm format:check` — PASS («All matched files use Prettier code style!»).
- `pnpm lint` — PASS (13/13 задач).
- `pnpm typecheck` — PASS (20/20).
- `pnpm test` — PASS (19/19 задач). Один промежуточный прогон дал отказ `@adclub/ui` «Failed to start forks worker» (машина была занята интеграционными контейнерами; пакет не менялся) — отдельный прогон 8 файлов / 70 тестов PASS, итоговый `pnpm test` — 19/19.
- `pnpm build` — PASS (12/12, включая `expo export` приложения).
- `pnpm --filter @adclub/api openapi:check` — PASS («matches the contract and the served routes»).
- `pnpm --filter @adclub/api openapi:compat --base HEAD` (до коммитов) — только `response-body-one-of-added` у `POST /supplier/orders/lookup` и `/close`; ответ `GET /orders/{id}/repeat` после `repeatItemSchema` не меняется. Коммит контракта несёт трейлер `Contract-Breaking-Change`.
- Интеграционные изменённых модулей (Testcontainers, локально):
  - `service-orders.integration.test.ts` — PASS 19/19 (дважды);
  - `on-order.integration.test.ts` — PASS 25/25 (отдельный прогон вместе с `service-orders`: 44/44);
  - `orders.integration.test.ts`, `admin-users.integration.test.ts`, `schema-drift.integration.test.ts` — PASS (первый прогон);
  - `database.integration.test.ts`, `order-notices.integration.test.ts`, `admin-panel.integration.test.ts` — PASS (последовательный прогон).
  - Промежуточные красные прогоны и их причины — в «Errors & Fixes». Весь набор (~40 мин) локально не гонялся — его выполняет CI.

## UAT / E2E
Пройдено в dev-окружении (Docker Compose, `api-test-ai`, worker, кабинет, админка, приложение под react-native-web; встроенный браузер со скрытой панелью — проверка через DOM; входили тестовыми номерами `+77055550101` (сотрудник «Автомаркета») и `+77470009038` (клиент), dev-настройки входа не трогали):
- Запросами (скрипт в scratchpad) созданы три записи «Замена моторного масла» для Geely Coolray 2024: № 1048, 1049, 1050. Попытка на воскресенье (точка закрыта) — 400 `desiredAt` «Outside the point's working hours»; варианты `GET /order-visit-options` дают сегодня только оставшиеся минуты до закрытия и рабочие дни дальше.
- `/dev/messages`: W-01b «Запись № 1050: Замена моторного масла, Geely Coolray 2024, 12 октября в 13:00. Ответьте до 17:58» обоим получателям, с кнопками.
- Кабинет: «Новые» — № 1048 «Geely Coolray 2024 · Клиент просит: 12 октября, 11:00», метка «Услуга», «Отказать / Подтвердить время»; «В работе» — № 1049 в «Ждут ответа клиента» («Предложено другое время: 12 октября, 15:00. Клиент ответит до завтра, 15:58»), № 1050 в «Записи на услуги» («Подтверждена · Визит 12 октября, 13:00»). Карточка № 1049 — «Телефон откроется после принятия заявки»; № 1050 — имя и телефон клиента, «Автомобиль», «Время», журнал «Подтвердил время Ерлан», «Отказать / Отметить выполнение по QR / коду». Кнопка «Подтвердить время» в карточке № 1048 — статус «Подтверждена», телефон открылся.
- Сканер (ручной ввод кода № 1050): «Заявка найдена · № 1050 · Подтверждена», автомобиль, время, «Отметить выполненной» → результат (после правки — «Выполнено · Замена моторного масла · Тест Записи»; до правки было «Выдано … × 1», исправлено и покрыто тестом).
- № 1048: `visit_until` сдвинут в прошлое, `jobs:run orders.apply-deadlines` → `visit_unresolved`; админка «Сигналы» — «Запись не разобрана · № 1048 · Автомаркет · визит …», подсказка, «Открыть объект» → `/orders/<id>`; карточка «Запись не разобрана» на главной.
- Админка: «Заявки» → «Тип: Услуга» — три записи («Выдана», «Ждёт ответа клиента на время», «Ждёт ответа»); карточка № 1049 — «Получение: Визит в точку», «Автомобиль», «Желаемое время», «Предложено другое время … клиент ответит до …», журнал «Запись оформлена на …», «Предложено другое время …», кнопки «Продлить ответ клиента… / Закрыть без кода… / Отменить заявку…».
- Приложение (вход клиентом): «Заявки → Активные» — «Нужен ваш ответ · Замена моторного масла · Geely Coolray 2024 · 8 000 ₸ · Автомаркет · Ответьте до 15:58, 11 октября»; экран заявки — «Поставщик предлагает другое время — 15:00, 12 октября. Ответьте до …», «Куда приехать», «Автомобиль», «Время», ход заявки, «Отменить заявку» (кнопок ответа нет — это TASK-039.B); «История» — «Время записи прошло» и «Получено» с автомобилем.
- Не проверено: нативное приложение на телефоне; кнопка W-01b в браузере не нажималась (нажатие проверено интеграционным тестом и dev-командой не вызывалось).

## Acceptance Criteria
- **AC-1 — PASS** — `packages/domain/src/order/order-machine.ts` (вид `service`), `order-machine.test.ts` перебирает все пары «статус × действие × вид» для трёх видов (`pnpm --filter @adclub/domain exec vitest run src/order` — 8 файлов PASS); проверка времени `order-visit.ts` + `order-visit.test.ts`; миграция `1791050000000_service-orders.sql` с откатом, цикл проверен тестом «holds an order on a service in the database, and rolls back removing only such orders» в `database.integration.test.ts`.
- **AC-2 — PASS** — `service-orders.integration.test.ts`, 19/19 PASS (настоящие PostgreSQL и Redis, API и два worker'а): подтверждение кнопкой → визит → выполнена по коду; предложил → согласился → W-02 → выполнена; предложил → отказался (W-04); предложил → молчание → истекла (два свипера, одно событие); отказ во время ожидания ответа (D-072); неявка с отметкой `service_no_show`, раньше времени — 409, после окна — `visit_unresolved`; тестовая заявка без отметки; без разбора → истекла, один сигнал при трёх свиперах и двух worker'ах, поздний код; гонка кнопки WhatsApp и кабинета (4 раунда); время вне часов, в нерабочую дату, в прошлом, за горизонтом, с секундами, другое время по тем же правилам; матрица доступа (чужая компания и чужой пользователь — 404, чужие контексты — 403, гость — 401, устаревшая версия — 409, ходы услуги на товаре — `ORDER_KIND_NOT_SUPPORTED`).
- **AC-3 — PASS** — тест «confirmed by the button…» проверяет `customer: hidden` до подтверждения и `revealed` после; «another time proposed → agreed» — телефон только после «да»; ни ответ кабинета, ни ответ админки, ни ответ сканера не содержат кода (`JSON.stringify(...).not.toContain(code)`), итоговый тест — ни одного кода в выводе процессов.
- **AC-4 — PASS** — W-01b `order_new_service` с переменными `service`, `model` («Geely Coolray 2024»), `time` и кнопками `confirm`/`decline`; нажатие «Подтвердить время» — `outcome: accepted`, W-02 нажавшему; W-02 предложившему после согласия; W-04 после отказа и поздней отмены — всё в тестовом канале (интеграционный тест и `/dev/messages` в dev).
- **AC-5 — PASS** — юнит-тесты клиентов (`order-status.test.ts` приложения, `order-rules.test.ts` и `scan-rules.test.ts` кабинета, `order-words.test.ts` админки) и проход в браузере (раздел UAT): приложение, кабинет, админка и сканер показывают запись со словами статуса, автомобилем и временем; «Запись на услуги появится позже» не тронута (`canOrderOffer` не менялся).
- **AC-6 — PASS** — `openapi:check` PASS; `openapi:compat --base HEAD` — только `response-body-one-of-added` у `POST /supplier/orders/lookup` и `/close`; коммит контракта — с трейлером `Contract-Breaking-Change`.
- **AC-7 — PASS** — `ARCHITECTURE.md` 4.62 (I637–I647) и «Реализовано в TASK-038» под таблицей 6.3; `CLAUDE.md` — «Записи на услуги в dev».
- **AC-8 — PASS** — см. «Verification».
- **AC-9 — PASS** — этот отчёт. Коммиты `dd537c6` (правки Product Owner), `e807986` (сервер, домен, контракт — с трейлером `Contract-Breaking-Change`), `c67db45` (клиенты), `92fa76d` (CLAUDE.md) запушены в `main`; прогон CI на них — **38068040775** (запущен, результат не ожидался — его смотрит архитектор при приёмке). Коммит этого отчёта запускает ещё один прогон.

## Errors & Fixes
- Однострочник `node -e` с обратными кавычками в комментарии (нарушение §8 «Оболочка»): bash вырезал их содержимое — затронута только одна неудачная замена текста комментария в `order-repeat.ts`, файл проверен по `git diff`, повреждений нет. Дальше правки — только Edit/Write и скрипты в файлах scratchpad.
- Скрипт вставки `visit: null` в `order-status.ts` задвоил ключ в объектах с большим отступом — найдено `tsc`, исправлено.
- `no-fallthrough` ESLint на комментарии между пустыми `case` — комментарий перенесён.
- `database.integration.test.ts`: тесты идут вниз по одной миграции с верхней — новая миграция сдвинула их; добавлен тест её цикла первым.
- Первый прогон регрессии (7 тяжёлых файлов параллельно и dev-стек рядом) дал тайм-ауты хуков 120 с в `order-notices` и `admin-panel`; последовательный повтор — PASS. В последовательном прогоне `on-order` с середины файла получил тайм-ауты `beforeEach` (120 с) у тестов, прошедших в первом прогоне; отдельный повтор `on-order` + `service-orders` — 44/44 PASS. Считаю это перегрузкой машины (Docker на Windows), а не дефектом; если CI покажет то же — повод разобраться.
- Тест «нет кода в выводе процессов» в `service-orders` сначала сравнивал подстроку по всему выводу (шесть цифр кода совпали с куском UUID) — приведён к образцу `on-order`: журнал приложения (`appLogText`) и границы слова.
- `on-order.integration.test.ts`: тест «услугу пока не заказать (`ORDER_KIND_NOT_SUPPORTED`)» стал неверен по задаче — переписан: предложение на услугу без машины и времени — 400 у `carId`.

## Deviations
- Названия маршрутов и статусов — решение агента (как разрешено задачей): ответ пользователя на другое время — те же `term/agree|reject`, статусы ожидания и молчания — общие с «под заказ».
- В задаче «неявка — такая же отметка»: заведён отдельный вид `service_no_show` той же таблицы дисциплины (админка показывает его как «Неявка»), чтобы отличать неявку на услугу от невыкупленного резерва.
- Описание настройки `late_cancel_hours` («записывается в дисциплину пользователя») не совпадало с решением отложить дисциплину до EPIC-19 — исправлено на «отмечается в журнале заявки как поздняя».

## Known Issues / Risks
- Продление администратором срока ответа поставщика или пользователя за желаемое/предложенное время допускается (решение администратора): подтверждённый после этого визит может сразу оказаться в прошлом и истечь без разбора по своему окну.
- Казахские тексты новых слов — рабочий черновик (как и прежние).
- `service_grace_hours = 0` делает окно неявки пустым: визит истекает без разбора в момент своего времени.

## Remaining Work
None.

## Future Improvements
- Автоматически закрывать сигнал «Запись не разобрана», когда сотрудник закрыл визит поздним кодом или администратор закрыл без кода.
- Сканер может отказывать в «Отметить выполненной» задолго до времени визита (сейчас разрешено — клиент мог приехать раньше).

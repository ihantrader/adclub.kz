# TASK REPORT — TASK-022

## Status

COMPLETED (все 13 AC выполнены; AC-12 — с оговоркой: CI с первой попытки упал на внешней причине, не на коде, и зелёный после починки образа отдельным коммитом — подробности в AC-12)

## Result

Заявка доходит до конца.

**Сканер кабинета.** Сотрудник поставщика находит заявку своей компании по коду с экрана пользователя (шесть цифр, с пробелами и дефисами или без) или по содержимому QR — `POST /supplier/orders/lookup` — и выдаёт товар — `POST /supplier/orders/close`. Учётные данные идут только в теле запроса. Ответ — размеченное объединение под случаи S-SCAN-04: `ready` (позиция, количество, сумма, статус — **без кода, без QR, без телефона покупателя**), `late` («Срок заявки истёк {когда}, закрыть можно» с концом окна), `closed` («уже выдана {дата}, закрыл(а) {сотрудник}»), `refused` с причиной (`not_accepted`, `cancelled_by_user`, `declined_by_supplier`, `response_expired`, `late_window_passed` с числом часов), `other_supplier` (только факт; название компании — лишь если сотрудник состоит и в ней), `not_found`. Выдача работает из «Принята» и из «Готова» (D-040) и когда предложение снято, а поставщик на паузе (PRODUCT 10.6). Повторная выдача той же заявки — не ошибка: ответ «уже выдана», второй записи в журнале нет.

**К «Выдана» ведут ровно три действия автомата** — `close` и `close_late` сотрудником по коду или QR и `admin_close` администратором с причиной; юнит-тест перебирает все пары «статус × действие» и утверждает, что других путей нет.

**Перебор кода практически невозможен.** Три предела: общий на сотрудника (60 поисков в минуту) и отдельно на **неудачи** — не найдено или чужая компания — на сотрудника (10 в час) и на всю компанию (30 в час). Сверх — 429 с `Retry-After` и именем предела; первое срабатывание в окне пишется в журнал действий (`order.lookup_blocked`, без кода) и считается метрикой. Недоступный Redis не отключает предел: поиск и выдача отвечают 503 — заявку закроют позже, окно позднего закрытия для этого и существует.

**Окно позднего закрытия** (`order_late_close_hours`, 48 ч) фиксируется в заявке при истечении резерва: уменьшение настройки не двигает окно уже ждущей заявки. Поздно закрыть можно только заявку, истёкшую **по резерву**; без ответа поставщика, отменённую и отклонённую — нельзя. Заявка помечается «закрыта поздно» (отбор `closedLate` у администратора, `closure.late` поставщику, `givenOut.late` пользователю). **Код закрываемой заявки не достанется другой:** уникальность кода стоит на частичном индексе по `code_released_at IS NULL` — заявка держит код, пока её можно закрыть; освобождает его переход, которым код больше не нужен, а у истёкшего резерва — свипер по окончании окна (или чтение карточки, если дошло раньше).

**Дисциплина пользователя.** При истечении резерва в той же транзакции появляется отметка `pickup_no_show`; её нет у доставки, у истечения без ответа поставщика, у отказа, у отмены и у тестовых заявок сотрудников. Отметка никогда не удаляется: позднее закрытие и закрытие администратором помечают её снятой, администратор снимает вручную **только с причиной** (действие — в журнале действий). Администратору доступны отметки заявки (в карточке), отметки пользователя со снятыми и список «кто не пришёл, сколько раз, когда в последний раз». Пользователю и поставщику дисциплина не видна нигде.

**Закрытие администратором без кода** (D-043) — из активных статусов и из обоих истёкших, только с причиной; пометка «Закрыта администратором» видна поставщику, **причина — только администратору**; запись и в журнал заявки, и в журнал действий; дисциплинарная отметка снимается. Отменённую, отклонённую и уже выданную так закрыть нельзя.

**Сигналы администратору** — таблица `admin_signal` с одним открытым сигналом на субъект: «вторая заявка на ту же позицию при позднем закрытии» и «частые закрытия администратором у одного поставщика» (порог настройкой); читаются `GET /admin/signals`.

**Семь замечаний приёмки TASK-021 закрыты:** лимит действий сотрудника и одна запись `late_action_ignored` на (заявку, сотрудника, намерение); в конфликте называется только то, что кто-то с заявкой сделал (собственное `create` покупателя больше не попадает); `qrPayload` и содержимое QR маскируются санитайзером; повтор отказа с другой причиной — честный 409, а не молчаливая потеря уточнения; срок учитывается при чтении карточки и в сканере, не со следующим проходом свипера; все решения о сроках принимаются по времени базы; ключ повторной отправки очищается задачей по сроку хранения.

## Changes

**Доменная логика (`packages/domain/src/order/`)**

- `order-machine.ts` — действия `close_late` и `admin_close` в единственной таблице переходов; актор `admin`; `orderCloseActions`.
- `order-close.ts` (новый) — `lateCloseUntil` и `orderCloseVerdict`: одно решение «можно ли выдать сейчас, поздно, уже выдана, нельзя» для ответа сканера и для самого закрытия. Тесты — `order-close.test.ts`, дополнен `order-machine.test.ts`.

**Контракт (`packages/contracts/src/`)**

- `orders.ts` — `orderCredentialSchema`, `supplierScanOrderSchema`, `orderLookupResponseSchema`, `closeOrderResponseSchema`, `orderClosureSchema`/`adminOrderClosureSchema`, `orderGivenOutSchema`, дисциплина (`disciplineMarkSchema`, страницы, `revokeDisciplineBodySchema`), `adminCloseOrderBodySchema`, отборы `closedLate`/`closedByAdmin`, `orderCloseMethodSchema`, новые значения перечислений журнала.
- `signals.ts` (новый) — сигналы администратору.
- `routes.ts` — 7 маршрутов; `error.ts` — `ORDER_QR_UNKNOWN`, `DISCIPLINE_ALREADY_REVOKED`; `login-code.ts` — 4 имени пределов; `audit.ts` — `order.closed_by_admin`, `user_discipline_event.revoked`, `order.lookup_blocked`, сущность `user_discipline_event`; `openapi.ts` — регистрация схем модуля сигналов.

**Сервер (`apps/api/src/`)**

- `modules/orders/order-lookup.service.ts` (новый) — поиск по коду и QR, три предела с отказом без Redis и следом в журнале действий, выдача.
- `modules/orders/order-discipline.ts` (новый) — отметки, их снятие (три причины), ручное снятие с причиной и журналом, списки для администратора.
- `modules/orders/order-cleanup.ts` (новый) — свипер `orders.cleanup-idempotency-keys`.
- `modules/orders/order-transitions.ts` — `close`/`close_late`/`admin_close`, `orElse` (код заявки с только что истёкшим резервом закрывает её поздно), окно и дисциплинарная отметка при истечении резерва, снятие отметки, сигналы, журнал действий закрытия администратором, освобождение кода, `databaseNow`, релевантное `lastAction`, дедупликация `late_action_ignored`, повтор только с теми же параметрами, условие окна в самом `UPDATE`.
- `modules/orders/order-views.ts` — `closure` поставщику и администратору (причина — только администратору), `givenOut` пользователю, `discipline` в карточке администратора, `scanOrderView`.
- `modules/orders/orders.service.ts` — ленивое истечение при чтении карточки всех трёх сторон, закрытие администратором, лимит действий сотрудника, отборы `closedLate`/`closedByAdmin`.
- `modules/orders/order-deadlines.ts` — четвёртое условие свипера (освобождение кода), время из базы в SQL, модуль задач с новыми провайдерами.
- `modules/orders/orders.controller.ts` — `SupplierScanController`, `AdminDisciplineController`, закрытие администратором.
- `modules/signals/` (новый модуль) — `admin_signal`, `AdminSignals.raise`/`page`, маршрут.
- `observability/sanitizer.ts` — ключи QR и содержимое `ADCLUB-ORDER:…`.
- `modules/settings/registry/registry.ts` — `order_late_close_hours` (переименована из `late_close_window_hours`), 8 ключей пределов и сигналов, `cleanup_order_idempotency_retention_days`.
- `orm-tables.ts`, `testing/database.ts`, `app.module.ts`, `worker.module.ts` (через `OrderJobsModule`), `background-jobs.ts` (через `orderJobCatalog`).

**Миграция** `infra/migrations/1790450000000_close-orders.sql` — колонки закрытия и окна, `code_released_at` с частичным уникальным индексом вместо прежнего «уникален среди активных», ослабленное правило «выдана ⇒ принята» только для закрытия администратором, необязательный `idempotency_key`, таблицы `user_discipline_event` и `admin_signal`, индексы под отборы и свипер; обратима (проверено циклом up → down → up с данными).

**Тесты** — `apps/api/src/modules/orders/orders.integration.test.ts` (+26 тестов, всего 54), `apps/api/src/database/database.integration.test.ts` (новый тест правил и откат миграции), `apps/api/src/modules/identity/access.integration.test.ts` и `sign-in-data-cleanup.integration.test.ts` (описи маршрутов и расписаний), `schema-drift.test.ts`, `registry.test.ts`, `sanitizer.test.ts`, `packages/contracts/src/openapi.test.ts`, доменные юнит-тесты.

**Документация** — ARCHITECTURE.md 0.35: новый раздел 4.32 (I321–I338), уточнены 5.7, 5.11, 6.1, 6.5, 13.2, 14, 17.15, 18.8, R17; CLAUDE.md блок 0 — новый абзац с командами dev.

## Technical Decisions

Все — в ARCHITECTURE.md 4.32 (I321–I338). Значимые:

1. **Код держится за заявкой, пока её можно закрыть** (I327). Прежняя уникальность «среди активных статусов» освобождала код истёкшей заявки сразу, хотя закрыть её можно было ещё двое суток. Вместо расширения предиката индекса на «активна ИЛИ окно открыто» (предикат частичного индекса не может звать `now()`) введена колонка `code_released_at`: индекс частичный по `code_released_at IS NULL`. Код освобождается переходом, которому он больше не нужен, а у истёкшего резерва — по окончании окна (свипер или чтение карточки). Держать код дольше безопасно, освободить раньше — нет.
2. **Одно решение о выдаче — чистая функция** `orderCloseVerdict` (I326): ею пользуются и ответ сканера, и закрытие, поэтому экран никогда не предлагает «Выдать» там, где сервер откажет; условие окна дополнительно стоит в самом `UPDATE`.
3. **Освобождённый код ищется только среди своих заявок** (I327): это даёт «уже выдана» и «клиент отменил» после освобождения и ничего не рассказывает о чужих компаниях.
4. **Redis недоступен — поиск и выдача отказывают** (I325), в отличие от чтений каталога и создания заявки: единственное, что нельзя обслуживать без счёта, — угадывание кода, а окно позднего закрытия покрывает сбой.
5. **Окно — хранимый срок** (I326), как все прочие дедлайны (13.4): изменение настройки не двигает уже ждущую заявку.
6. **Повтор — просьба сделать то же самое** (I334): второй отказ с другой причиной — 409 с `lastAction`, а не 200 с потерянным уточнением.
7. **Время решений — из базы** (I336): `databaseNow` и `now()` в SQL свипера.
8. **Ключ повторной отправки не вечен** (I337): колонка стала необязательной, чистит свипер по сроку хранения; у незавершённой заявки ключ не трогается никогда.
9. **Ослабление правила базы «выдана ⇒ принята»** (I329) — только при `close_method = 'admin'`: администратор закрывает и заявку, на которую поставщик не ответил, и такое закрытие не должно делать вид, что телефон покупателя открывался.

## Commits (D-024)

Каждый коммит собран перечислением файлов (`git add <путь> …`), состав проверен `git status` и `git diff --cached --stat`; `git commit -a` и `git add -A` не использовались.

1. `7ca2b49` **Update project plan and state, add TASK-022 (Product Owner edits)** — правки Product Owner, найденные в рабочем дереве, отдельным первым коммитом: `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-022.md`. Ни с чем не смешаны.
2. `1157a3c` **Put the three moves that reach «Выдана» in the table of moves** — `packages/domain/src/order/order-machine.ts`, `order-machine.test.ts`, `order-close.ts`, `order-close.test.ts`, `packages/domain/src/index.ts`.
3. `664c69b` **Keep the code of a closable order, the discipline and the signals in the database** — `infra/migrations/1790450000000_close-orders.sql`, `apps/api/src/modules/orders/schema.ts`, весь `apps/api/src/modules/signals/`, `apps/api/src/orm-tables.ts`, `apps/api/src/testing/database.ts`, `apps/api/src/database/schema-drift.test.ts`, `apps/api/src/database/database.integration.test.ts`.
4. `b7919c6` **Describe giving an order out in the contract** — `packages/contracts/src/orders.ts`, `signals.ts`, `routes.ts`, `error.ts`, `login-code.ts`, `audit.ts`, `index.ts`, `openapi.ts`, `openapi.test.ts`, `apps/api/openapi.json`.
5. `2fa0524` **Give an order out by the code, late and by the administrator** — `apps/api/src/modules/orders/` (`order-lookup.service.ts`, `order-discipline.ts`, `order-cleanup.ts`, `order-code.ts`, `order-transitions.ts`, `order-views.ts`, `order-deadlines.ts`, `orders.service.ts`, `orders.controller.ts`, `orders.module.ts`, `index.ts`, `orders.integration.test.ts`), `modules/settings/registry/registry.ts` и `registry.test.ts`, `observability/sanitizer.ts` и `sanitizer.test.ts`, `app.module.ts`, `modules/identity/access.integration.test.ts`, `modules/identity/cleanup/sign-in-data-cleanup.integration.test.ts`.
6. `9dd96eb` **Describe the end of an order in the architecture and the development guide** — `ARCHITECTURE.md`, `CLAUDE.md`.
7. `e570f7a` **Take the MinIO image from a registry that still serves it** — **вне задачи, починка CI:** `infra/docker/compose.dev.yml`, `apps/api/src/modules/catalog/catalog-photos.integration.test.ts`, `CLAUDE.md`, `ARCHITECTURE.md` (решение I339). Отдельным коммитом именно потому, что к TASK-022 не относится.
8. `d8107fe` **Add the TASK-022 report** — `tasks/TASK-022-REPORT.md`; номер CI этого коммита дописан следующим коммитом.

## Verification

| Проверка | Результат | Кратко |
|---|---|---|
| `pnpm format:check` | PASS | All matched files use Prettier code style |
| `pnpm lint` | PASS | 12 задач, 0 ошибок и предупреждений |
| `pnpm typecheck` | PASS | tsc по workspace без ошибок |
| `pnpm test` | PASS | 15 задач; `apps/api` 476 тестов, `packages/domain` 209, `packages/contracts` 126 и остальные пакеты |
| `pnpm --filter @adclub/api openapi:check` | PASS | «matches the contract and the served routes» |
| `pnpm --filter @adclub/api openapi:compat --base HEAD` | PASS | «No breaking changes to report… Contract is backward compatible» |
| `pnpm test:integration` (весь набор) | PASS | 21 файл, 510 тестов; см. ниже про прогоны |
| `pnpm --filter api test:integration src/modules/orders/orders.integration.test.ts` | PASS | 54 теста (было 24 + 26 новых, 4 переписаны) |
| `pnpm --filter api test:integration src/database/database.integration.test.ts` | PASS | 29 тестов, цикл up → down → up с данными |
| `pnpm build` | PASS | Turborepo, 11 задач: пакеты, API, оба веб-приложения и JS-бандл мобильного (`expo export` для iOS и Android) |
| `pnpm --filter api migrate` на dev-базе | PASS | миграция применилась к реальной dev-базе с заявками № 1001–1010; активные держат код, завершённые освободили, у истёкшего резерва окно в прошлом |
| Прогон в dev (сканер) | PASS | см. «UAT / E2E» |
| Прогон в dev (администратор) | PASS | см. «UAT / E2E» |
| CI на `main` | PASS (со второго коммита) | run 36129016015 — failure на образе MinIO, не на коде (то же падение воспроизвёл перезапуск прогона предыдущего коммита — 35899683472); после починки образа run 36133377025 — success; коммит с отчётом — run 36139352772, success |

**Про интеграционный набор.** Он прогонялся трижды.

1. Первый прогон — 6 падений: одно настоящее (опись маршрутов в `access.integration.test.ts` не знала семи новых) и пять — истечения времени тестов и хуков (120 с и 60 с) в `settings`, `offers` и `sign-in-data-cleanup`: прогон шёл одновременно с поднятым dev-API и вторым набором на той же машине. Описи маршрутов, расписаний и задач пополнены; те же файлы по отдельности зелёные.
2. Второй прогон — 2 падения. Одно настоящее и важное: сигнал «вторая заявка на ту же позицию» иногда не поднимался, потому что `created_at` новой заявки ставился по часам процесса, а `finished_at` истёкшей — по часам базы, и при расхождении в четверть секунды новая заявка выглядела созданной раньше истечения. Это ровно тот класс ошибок, от которого защищает долг 6: создание заявки тоже переведено на время базы. Второе падение — не связанное с задачей: загрузка фотографии ответила 500 на создании позиции под нагрузкой (повторный прогон файла — 31 тест зелёные).
3. Третий прогон (после исправления, без конкуренции) — зелёный целиком: 21 файл, 510 тестов.

## UAT / E2E

Оба сценария пройдены на **реальном dev-окружении**: Docker Compose (PostgreSQL 16, Redis, MinIO, Meilisearch), `pnpm --filter api migrate`, `pnpm --filter api dev` и `pnpm --filter api worker`, всё по HTTP настоящими сессиями (мобильной, кабинета и админки с настоящим вторым фактором). Сценарии — из «Что должно реально работать».

**Сканер (скрипт в scratchpad, вывод ниже дословно).**

```
order № 1015 total 13000
lookup: {"result":"ready","order":{…,"status":"accepted","quantity":2,"total":13000,
  "item":{"article":"04465-0K090","brand":"Geely","name":{"text":"Колодки тормозные передние"}},
  "receiptOn":"2026-09-25"}}
the answer holds the code? false          …the phone? false
close: given_out late false {"method":"code","by":{"kind":"member","name":"Айгерим"},"late":false}
the user sees: completed {"at":"…","late":false} code left? false
journal: create,accept,close
close again: {"result":"closed","at":"…","by":{"kind":"member","name":"Айгерим"},"late":false}
journal: create,accept,close                    ← второй записи нет
the stranger sees: {"result":"other_supplier","supplier":null}
a foreign QR: {"code":"ORDER_QR_UNKNOWN","details":{"prefix":"ADCLUB-ORDER:"}}
answered 9 then {"status":429,"code":"RATE_LIMITED",
  "details":{"limit":"order_lookup_failures_per_member","retryAfterSeconds":3600},"retryAfter":"3600"}
the administrator's journal: 1 entries of order.lookup_blocked
status: reserve_expired
window: 48 h, holds the code: true
no-show: pickup_no_show
lookup: late expired 2026-09-25T10:34:55Z until 2026-09-27T10:34:55Z
the code is held: a second order can't have it — held_code_key
close: given_out late true {"method":"qr","by":{"kind":"member","name":"Айгерим"},"late":true}
no-show after: pickup_no_show revoked_by=late_close
journal: create,accept,expire_reserve,close_late
close: {"result":"refused","reason":"response_expired"} status: response_expired
```

(«answered 9», а не 10, потому что первым неудачным поиском этого сотрудника был ответ «оформлена у другого поставщика» — он по замыслу считается неудачей.)

**Администратор.**

```
admin session ok                                  ← настоящий TOTP, настроенный как в админке
order № 1012
marks [["pickup_no_show",null]]                   users with no-shows 3
without a reason: 400 VALIDATION_ERROR
closed completed {"method":"admin","by":{"kind":"admin","adminId":"…"},"late":false,
  "reason":"Клиент подтвердил получение"}
marks now [["pickup_no_show","admin_close"]]
the supplier sees {"method":"admin","by":{"kind":"admin","adminId":"…"},"late":false}
has the reason? false
audit [["order.closed_by_admin","Клиент подтвердил получение"]]
closedByAdmin=true 1
the scanner says {"result":"closed","by":{"kind":"admin","adminId":"…"},"late":false}
signals [["frequent_admin_closes",1,{"days":30,"closes":2,"threshold":1,"supplierId":"…"}]]
without a reason: 400 VALIDATION_ERROR
lifted {"by":"admin","note":"Клиент сообщил, что приходил","adminId":"…"}
twice: 409 DISCIPLINE_ALREADY_REVOKED
```

Заодно в dev подтвердилось ленивое истечение (долг 5): первый прогон шёл без worker'а, и заявка перешла в `reserve_expired` (с дисциплинарной отметкой) на чтении карточки администратором, до любого прохода свипера.

Экранов нет ни у сканера (TASK-033), ни у админки (TASK-036) — проверялся только сервер.

## Acceptance Criteria

- **AC-1 — PASS.** «closes an order from «accepted» and from «ready», by the code and by the QR» (`orders.integration.test.ts`): код с пробелами находит заявку, `close` даёт `completed` с `closure {method, by: member, late}`, `closed_at`, `closed_by_member_id`; журнал — `create,accept,close`; заявка попадает в «Завершённые» кабинета и в историю пользователя; повтор отвечает `closed` и оставляет 3 записи; вторая заявка выдана по QR из «Готова» (`close_method = qr`). В dev — тот же вывод выше. Плюс «closes an order even when the offer is withdrawn… and the supplier paused» (PRODUCT 10.6).
- **AC-2 — PASS.** «tells apart another company, nothing found and a broken QR, and gives nothing away»: `other_supplier` c `supplier: null` и проверкой, что в ответе нет ни кода, ни телефона, ни артикула, ни суммы, ни id заявки; сотрудник двух компаний получает название; `not_found`; 400 `ORDER_QR_UNKNOWN` и 400 на «не шесть цифр». «reaches no answer of the scanner, of the administrator, no journal and no log»: собраны ответы сканера (успех, повтор, чужая компания, позднее), карточек поставщика и администратора, списков, журнала действий и сигналов — ни одного кода (по границам слова) и ни одного QR-токена; то же в `order_event`, `audit_log` и логе приложения. «keeps the QR out of the monitoring when a write fails with the whole row» — принудительный отказ CHECK на закрытии: в приёмнике мониторинга есть имя ограничения и нет ни кода, ни токена.
- **AC-3 — PASS.** «makes guessing a six-digit code run into a wall, and an administrator sees it»: при пределах 3/5 четвёртая неудача сотрудника — 429 с `Retry-After` и `details.limit = order_lookup_failures_per_member`, третья неудача коллеги — предел компании; в журнале действий ровно две записи `order.lookup_blocked` (по одной на предел), в них нет введённых кодов; 200 попыток подряд при пределе 10 дают ровно 10 ответов, остальные 429. «refuses to look a code up at all when Redis can't count the tries» — 503 на поиск и на выдачу, статус заявки не меняется, после возврата Redis заявка выдана. Пределы — настройки (`settings.set` в тесте).
- **AC-4 — PASS.** «gives out an expired reserve inside the window, marks it late and lifts the no-show»: `late` c `until − expiredAt = 48 ч`, закрытие — `closed_late = true`, журнал `create,accept,expire_reserve,close_late`, у пользователя `givenOut.late = true`. «never closes late an order without the supplier's answer, a cancelled or a declined one»: `refused` с `response_expired`/`cancelled_by_user`/`declined_by_supplier`, статусы не меняются; непринятая — `not_accepted`. «closes the window at its edge…»: ровно в `late_close_until` — `late_window_passed` с `lateCloseHours`, уменьшение настройки не двигает окно ждущей заявки, следующая истёкшая получает новое окно (1 ч проверен запросом к базе). Отбор «Закрыта поздно» — в тесте отборов.
- **AC-5 — PASS.** «never gives the code of an order that can still be closed late to another order»: прямой `INSERT` второй заявки с тем же кодом отклоняется базой — `customer_order_held_code_key`; после прохода окна и свипера тот же `INSERT` проходит, а старая заявка находится только своей компанией как «окно прошло». То же на уровне правил базы — в новом тесте `database.integration.test.ts`. В dev — строка «the code is held: a second order can't have it — held_code_key».
- **AC-6 — PASS.** Отметка ставится при истечении резерва (тест позднего закрытия) и не ставится у истечения без ответа, отказа, отмены (`disciplineRows(...) = []` в «never closes late…»), у доставки («keeps no no-show for delivery») и у тестовой заявки сотрудника («keeps no no-show and no signal for a test order»); снимается позд­ним закрытием (`revoked_by = late_close`) и закрытием администратором (`admin_close`); вручную — только с причиной (400 без неё, 409 на второй раз, запись `user_discipline_event.revoked` с причиной в журнале действий); список A-USR-03 с `count`/`revokedCount`/`lastAt`; «shows the discipline to nobody but the administrator» — ни в карточке пользователя, ни в его списке, ни в карточке поставщика нет ни id отметки, ни `pickup_no_show`, ни слова `discipline`, а маршруты дисциплины отвечают 403 пользователю и кабинету.
- **AC-7 — PASS.** «closes a disputed order with a reason, marks it and logs it»: без причины 400, с причиной — `completed` и `closure {method: admin, by: admin, reason}`; поставщик видит пометку и не видит причину (проверено поиском текста), пользователь — только `givenOut`; журнал заявки `admin_close` от актора `admin`, журнал действий `order.closed_by_admin` с причиной и номером; отметка снята. «closes an order the supplier never answered, and never a cancelled, declined or closed one»: из `response_expired` можно (и `phoneRevealedAt` остаётся `null`, покупатель для поставщика по-прежнему скрыт), из отменённой, отклонённой и уже выданной — 409; поставщику и пользователю маршрут отвечает 403.
- **AC-8 — PASS.** «signals the administrator when the user ordered the same item again meanwhile»: `GET /admin/signals?kind=duplicate_after_late_close` даёт один сигнал с номерами обеих заявок, обе остаются действительными. «signals the administrator about a supplier whose orders are closed without a code too often»: при пороге 2 — один сигнал с `closes: 2`, третье закрытие увеличивает `times` до 2 и `closes` до 3, а не плодит строки; кабинету `GET /admin/signals` отвечает 403. В dev — строка `signals [["frequent_admin_closes",1,{…}]]`.
- **AC-9 — PASS**, каждое замечание с тестом в describe «the acceptance notes of TASK-021»: (1) «limits how often one employee acts on orders» — 429 `order_actions_per_member`, и «keeps the same employee from filling the journal with ignored presses» — пять нажатий дают одну заметку, другое намерение — вторую; (2) «names in a conflict only what somebody did to the order…» — у необработанной заявки в 409 нет `lastAction`, после принятия коллеге называется принявший; (3) «removes the QR of an order, by its key and inside any text» (юнит санитайзера) и интеграционный тест из AC-2; (4) «never changes the reason of a decline behind the employee's back» — тот же отказ 200, другой 409, записанная причина не изменилась; (5) «counts a deadline as passed when reading the card, before the sweeper comes» — карточки всех трёх сторон и сканер дают `reserve_expired`/`late` без прохода свипера; (6) «decides deadlines by the clock of the database» — `databaseNow` совпадает с `SELECT now()`, метка события истечения равна метке строки (ограничение — см. Known Issues); (7) «clears the idempotency key of an order long finished, keeping the order» — задача очищает ключ завершённой заявки и не трогает активную, заявка и журнал на месте. Решения описаны в ARCHITECTURE 4.32 I331–I337.
- **AC-10 — PASS.** «lets exactly one of two employees give the same order out» — 6 раундов: оба ответа 200, но ровно один `given_out` и один `closed`, в журнале одна запись `close`. «gives exactly one outcome when an employee and an administrator close at once» — 4 раунда: статус `completed`, ровно одна запись закрытия, победитель виден в `close_method`, проигравший получает понятный ответ (`closed` сотруднику, 409 администратору).
- **AC-11 — PASS.** `openapi:generate` + `openapi:check` — файл совпадает с контрактом и маршрутами; `openapi:compat --base HEAD` — «Contract is backward compatible». Существующие тесты не ослаблены: четыре изменения в старых тестах — (а) опись маршрутов и две описи задач и расписаний пополнены новыми именами; (б) правило кода в старом тесте миграции оставлено как было (та миграция там уже откачена), а новое правило проверяется новым тестом; (в) допуск времени в тесте резерва стал двусторонним, потому что срок теперь считается по часам базы; (г) ожидание `lastAction` от собственного повторного нажатия заменено на нажатие коллеги — собственный повтор по-прежнему безобидный 200 (I311). `pnpm test` и `pnpm test:integration` зелёные.
- **AC-12 — PASS с оговоркой, которую надо прочитать.** Коммиты по D-024 — в разделе «Commits (D-024)» выше; правки Product Owner — отдельным первым коммитом, ни с чем не смешаны. **CI с первой попытки не прошёл — и не по вине этой задачи.** Прогон 36129016015: `Format check`, `Lint`, `Typecheck`, `Test` — зелёные, `Integration test` — красный, потому что набор фотографий (TASK-013) не смог поднять свой контейнер: `Error: (HTTP code 500) server error - unauthorized: access to the requested resource is not authorized`. Образы самого MinIO перестали отдаваться без учётной записи — проверено `docker pull quay.io/minio/minio:RELEASE.2025-04-08T15-41-24Z` («401 Unauthorized») и `docker pull minio/minio:…` («pull access denied»). Что это не моя регрессия, доказано перезапуском CI **предыдущего** коммита `main` (run 35899683472, зелёный 23.09): при перезапуске 25.09 он упал точно так же. Образ заменён на тот же сервер MinIO в сборке Bitnami отдельным коммитом (`e570f7a`, решение 4.32 I339 — помечено как не относящееся к задаче), после чего **run 36133377025 — success**: 21 файл интеграционных тестов, включая 31 тест фотографий, и все прочие шаги. Коммит с отчётом — **run 36139352772, success** (9 мин 24 с).
- **AC-13 — PASS.** ARCHITECTURE.md 0.35 (раздел 4.32, I321–I338; уточнены 5.7, 5.11, 6.1, 6.5, 13.2, 14, 17.15, 18.8, R17; версия, статус, дата и история изменений); CLAUDE.md блок 0 — новый абзац «Выдача заявки, позднее закрытие и дисциплина в dev» и обновлённое имя настройки.

## Errors & Fixes

1. **Правило базы срабатывало на обычной вставке.** `(close_method IN ('qr','code')) IS NOT DISTINCT FROM (…)` при `close_method IS NULL` даёт `NULL IS NOT DISTINCT FROM false` = false, и любая новая заявка отклонялась. Та же ошибка была в правиле снятия дисциплинарной отметки. Исправлено на `COALESCE(close_method, '') IN (…)`; обнаружено интеграционным тестом правил базы.
2. **Порядок в миграции.** Ограничение «у истёкшего резерва всегда есть окно» проверяется при добавлении, поэтому его нельзя было добавлять до дозаполнения `late_close_until`; а откат не мог перевести заявку, закрытую администратором, обратно в `created`, пока действовали новые правила. Оба шага переставлены; цикл up → down → up с данными зелёный.
3. **Освобождение кода происходило раньше свипера.** Тест ожидал, что код освободит свипер, но чтение той же заявки уже применило истёкшее окно (это и есть долг 5). Тест разделён: один случай проверяет чтение, другой — свипер на заявке, которую никто не читал.
4. **Часы базы впереди часов процесса.** Тест «резерв ровно 3 часа от локального времени» упал на 248 мс — ровно то расхождение, от которого защищает долг 6. Допуск сделан двусторонним, расхождение описано в ARCHITECTURE 4.32 I336.
5. **`walkDownPast` в тесте миграций перебирал не больше 10 шагов** — с новой миграцией цепочка стала длиннее, и тест «AI calls and translation tasks» не доходил до своей миграции. Предел поднят до 20.
6. **Тесты падали от конкуренции за ресурсы.** Пять падений первого полного интеграционного прогона — истечения времени тестов и хуков, когда одновременно работали dev-API и второй набор. По отдельности и в чистом повторном прогоне — зелёные.
7. **CI не мог скачать образ MinIO.** Не регрессия задачи: образы `quay.io/minio/minio` и `minio/minio` перестали отдаваться анонимно, и набор фотографий (TASK-013) не поднимал контейнер — падал бы любой коммит (проверено перезапуском CI предыдущего коммита). Образ заменён на ту же MinIO в сборке Bitnami (`bitnamilegacy/minio:2025.7.23-debian-12-r5`, закреплён): сервер запускается сам, бакет создаётся из `MINIO_DEFAULT_BUCKETS` (одноразовый `minio-init` из compose удалён), данные — в `/bitnami/minio/data`, в dev-compose контейнеру задан `user: root` (именованный том принадлежит root, а образ работает под непривилегированным пользователем). Проверено: 31 тест фотографий локально, `docker compose up` с существующим томом (прежние объекты на месте) и зелёный CI.

## Deviations

1. **Имя настройки окна.** TASK называет настройку `order_late_close_hours`. В реестре с TASK-007 уже была `late_close_window_hours` с тем же смыслом и тем же умолчанием 48, которую ничто не читало. Вместо второго ключа на один смысл ключ **переименован** в `order_late_close_hours` (имена настроек в контракт не входят — это свободная строка, ARCHITECTURE 14), а упоминания прежнего имени в ARCHITECTURE 6.5, 13.2, 17.15, 18.8 и R17 обновлены.
2. **Имя клиента на экране сканера.** S-SCAN-03 обещает «имя клиента», но профиля с именем ещё нет (EPIC-10; T-ORD-01 обещает передавать имя после принятия, TASK-021 I317). Ответ сканера имени не содержит, и телефон в него не попадает намеренно: покупатель открывается поставщику в карточке принятой заявки, а не на экране, куда попадают, набрав шесть цифр. Экран сканера (TASK-033) к моменту своей реализации либо получит имя из профиля, либо будет показывать карточку заявки.
3. **Заметка о проигранном нажатии в сканере.** Спокойный повтор («тот же код второй раз») в журнал ничего не пишет: решение о выдаче принимается до перехода, и при уже выданной заявке перехода нет. Заметка `late_action_ignored` появляется только у сотрудника, который проиграл настоящую гонку (коллега закрыл заявку в тот же момент), и не чаще одного раза на (заявку, сотрудника, намерение) — решение долга 1.
4. **Опись расписаний.** Новая задача очистки ключей — свипер, а свипер в этом проекте всегда раз в минуту (`defineSweeperJob`), как `identity.cleanup-*`. Для срока хранения 30 дней это чаще, чем нужно, но однообразнее; запрос идёт по частичному индексу.

## Known Issues / Risks

1. **Расхождение часов нельзя воспроизвести на одной машине.** Тест долга 6 проверяет источник времени (`databaseNow` = `SELECT now()`, метка события равна метке строки), а не величину сдвига. Само расхождение в контейнере (сотни миллисекунд) наблюдалось и учтено в тесте резерва.
2. **Освобождённый код теоретически может быть выдан другой заявке**, и тогда «уже выдана» для старой заявки сменится на «оформлена у другого поставщика» (если новая заявка у другой компании). Вероятность — совпадение шести цифр среди свободного миллиона; на правило AC-5 это не влияет (пока заявку можно закрыть, код её).
3. **Образ MinIO взят из legacy-репозитория Bitnami.** Он заморожен и качается без учётной записи, но это не путь на годы: если понадобится, стоит отдельной задачей выбрать постоянный источник S3-сервера для dev и тестов (например, собственное зеркало или другой совместимый сервер) — сами образы MinIO теперь требуют учётную запись.
4. **Миграция необратима без потерь.** Откат снимает колонки закрытия (кто, когда и как выдал) и удаляет дисциплинарные отметки и сигналы; заявку, закрытую администратором без ответа поставщика, откат возвращает в `created`. Это описано в самой миграции и проверено тестом.
5. **Уведомлений нет** (EPIC-09): при закрытии пользователю ничего не отправляется, события для будущих уведомлений записаны в журнал заявки.
6. **В dev-базе после прогонов** остались компании `Сканер-…`, `Чужая-…`, `Админ-…`, их сотрудники, заявки № 1011–1018, администратор `+7701…` с настроенным TOTP и выдачи клубного доступа на номера `+7747…`. Ничего из этого не мешает; при желании снести — `pnpm --filter api migrate:down` до TASK-021 и обратно или пересоздать базу.
7. **Настройки, изменённые прогонами в dev** (`login_code_resend_interval_seconds` = 1, `login_code_requests_per_phone` = 200, `admin_close_signal_count` возвращён к умолчанию): вернуть — `settings:reset <key> --reason "…"`.

## Remaining Work

None по TASK-022. Вне задачи стоит завести отдельную: выбрать постоянный источник S3-сервера для dev и тестов вместо legacy-репозитория Bitnami (сами образы MinIO теперь требуют учётную запись) — сейчас закреплён рабочий образ, CI зелёный.

## Future Improvements

- **Один механизм лимитов для маршрутов в сессии.** Сейчас пределы на сотрудника пишутся руками в трёх местах (поиск позиции TASK-018, действия и сканер здесь). Декоратор вроде `RateLimitedRoute` для маршрутов с сессией (ключ — учётная запись, сотрудник или компания, поведение при недоступном Redis — в контракте) убрал бы повторение.
- **Сигналы как общий модуль с действиями администратора.** `admin_signal` сейчас только читается; «подтвердить» и «закрыть» сигнал понадобятся A-HOME (TASK-034).
- **Отметка «выдана поздно» в рейтинге.** Позднее закрытие сознательно не влияет на рейтинг поставщика; TASK-050 стоит проверить, что оно и не улучшает его (доля закрытых в срок должна считаться по `closed_late`).
- **Единый счётчик неудач по адресу.** Пределы перебора считаются по сотруднику и компании; злоумышленник с доступом к нескольким компаниям обходит оба. Предел по адресу (как у открытых маршрутов) добавил бы третий рубеж.
- **Очистка ключей повторной отправки могла бы быть почасовой** — сейчас свипер раз в минуту, потому что все свиперы проекта минутные.

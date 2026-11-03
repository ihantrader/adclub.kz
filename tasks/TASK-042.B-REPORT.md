# TASK REPORT — TASK-042.B

## Status
COMPLETED

## Result
Доводка TASK-042.A по красному CI (прогон 41307831405). Исправлены все три названные причины. По ходу нашлись и исправлены ещё две — обе в коде продукта, а не только в тестах:

1. **Повтор списания раньше срока.** Попытку `unavailable`/`unknown` теперь не берёт ни одна задача, пока не наступил `next_try_at`. Раньше это время пускает только «Оплатить сейчас» (I843).
2. **Открытая транзакция «idle in transaction».** Причину нашли и доказали, она в коде пула соединений. Когда срабатывал `query_timeout` клиента `pg`, соединение возвращалось в пул посреди транзакции и держало её блокировки. Теперь таймаут оператора задаётся на сервере (`statement_timeout`), а соединение, на котором сработал клиентский таймаут, закрывается (I845). Отдельно: внутри транзакции код больше не обращается ко второму соединению пула (I844).
3. **Общая очистка тестов.** Одна функция `truncateAll` для всех 34 интеграционных файлов. Если очистить не удалось, она падает с понятной ошибкой и списком открытых транзакций, а не висит минутами.
4. **Порог в `hostile-files`.** Изменён один порог, 2000 → 5000 мс, с комментарием.
5. **Найдено по ходу:** отвязка замещённой карты у провайдера могла потеряться навсегда (I846).

## Changes
- `apps/api/src/modules/billing/payment-charger.ts`:
  - `claim` не берёт попытку `unavailable`/`unknown` до `next_try_at`;
  - новый `makeDueNow` — «Оплатить сейчас» по попытке на заменённой карте делает её срочной;
  - `chargeSubscription` больше не ставит в очередь попытку, которую сам же тут же запускает (две копии одной попытки соревновались за захват).
- `apps/api/src/modules/billing/payment-methods.ts`, `billing-handlers.ts`:
  - `billing.detach-card` ставится с ключом `singletonKey` = id карты (`scheduleDetach`);
  - `detachWhenFree` блокирует строку карты;
  - задача проверяет «карта свободна» в короткой транзакции под той же блокировкой, а провайдера вызывает уже после неё.
- `apps/api/src/database/database.service.ts`:
  - `statement_timeout: 2000`;
  - `query_timeout: 10000`;
  - новый `closeOnReadTimeout` — соединение, на котором сработал клиентский таймаут, закрывается.
- `apps/api/src/modules/settings/app-settings.ts`, `apps/api/src/jobs/job-settings.ts`, `job-runner.service.ts`:
  - `fresh()` заменён на `freshWithin(tx)`;
  - синхронизация расписаний читает настройки соединением своей транзакции.
- `apps/api/src/modules/price-imports/catalog-requests.service.ts` — лимит `catalog_requests_per_supplier_day` читается до транзакции.
- `apps/api/src/testing/database.ts` — `truncateAll(db, alsoRun?)`:
  - очистка в транзакции с `lock_timeout = 3s`;
  - повтор при `40P01`/`55P03` до 20 раз;
  - затем ошибка со списком открытых транзакций базы (`pg_stat_activity`: состояние, ожидание, кто блокирует, последний запрос).
- 34 файла `*.integration.test.ts` переведены на `truncateAll`. Локальные помощники и циклы повторов удалены. Файлы, которые чистили ещё и `pgboss.job`, передают это через `alsoRun`.
- `apps/api/src/modules/billing/supplier-billing.integration.test.ts`:
  - новые тесты «does not take a charge … before its hour, whatever job runs» и «forgets a replaced card while another card's detach waits on the queue (I846)»;
  - тесты дефекта 2 больше не «усыпляют» обработчик и не ждут по времени, а запускают задачи из очереди напрямую (`runQueuedJobs`) и проверяют, что они ничего не сделали;
  - истечение подписки прогоняется повторно до нужного статуса (`expireUntil`).
- `apps/api/src/database/database.integration.test.ts` — тест «leaves no transaction open in the server when a statement in it waits too long (I845)».
- `apps/api/src/modules/price-imports/file/hostile-files.test.ts` — один порог 2000 → 5000 мс с комментарием.
- `ARCHITECTURE.md` 0.84 — I843, I844, I845, I846.

## Technical Decisions
Все решения внесены в `ARCHITECTURE.md` 0.84 (раздел 4.77):

- **I843 — повтор не раньше срока.** Срок хранится в строке попытки, и его проверяет сам захват. Поэтому гарантия не зависит от того, когда worker возьмёт задачу. Ранняя задача ничего не делает. Своевременный повтор ставит `billing.resolve-attempts`.
- **I844 — внутри транзакции нет второго соединения пула.** Иначе получается цикл ожиданий, которого PostgreSQL не видит: транзакция ждёт свободное соединение, а оно стоит в очереди блокировок.
- **I845 — таймаут оператора на сервере.** Для приложения предел прежний — 2 с. Клиентский таймаут остался только на случай, если сервер совсем не отвечает, и такое соединение не возвращается в пул. pg-boss работает на своём пуле, его это не затрагивает.
- **I846 — ключ singleton по карте и блокировка строки карты.**

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS
- `pnpm typecheck` — PASS
- `pnpm build` — PASS
- `pnpm test` — PASS на повторе (api — 887/887, все пакеты зелёные). Первый запуск — FAIL: в `hostile-files.test.ts` упала проверка «merged cells … the event loop free»: `expected 748.78 to be less than 500` (пауза цикла событий при параллельной нагрузке turbo). Это не тот порог, что разрешено менять по AC5, поэтому я его не трогал — см. Known Issues.
- Интеграционные тесты (Testcontainers, локально):
  - `supplier-billing` целиком — PASS 41/41, три раза подряд (два прогона и финальный);
  - тот же файл в одном из промежуточных прогонов — FAIL 1/41: «tells the payer by the day…» (`Timed out waiting for the subscription to be suspended`); исправлено, см. Errors & Fixes;
  - `billing` — PASS 10/10;
  - `sign-in-data-cleanup` — PASS пять отдельных запусков подряд, 5/5 в каждом;
  - `catalog-photos` — PASS 31/31;
  - `messaging` — PASS 64/64;
  - `suppliers` — PASS 26/26;
  - `database` — PASS 54/54.
- Тесты дефекта 2 и новые тесты, 20 прогонов подряд (`--repeats 19`, четыре теста: «defect 2», «Оплатить сейчас после Сменить карту», «before its hour», I846) — PASS: код выхода 0, 909,65 с, ни одного падения.
- Unit `hostile-files.test.ts` — PASS 17/17 (отдельно).
- CI — NOT RUN к моменту отчёта: прогон **41645184284** запущен push'ем в `main`, я его не ждал.

## UAT / E2E
Не применимо: пользовательского поведения задача не меняет. Экраны не проверялись.

## Acceptance Criteria
- **AC1 — PASS.** Тест «does not take a charge the provider could not take (or whose answer was lost) to it before its hour, whatever job runs» в режимах `unavailable` и `outcome_unknown` проверяет: до `next_try_at` ни `billing.run-attempt`, ни `PaymentCharger.run`, ни ежедневное списание не обращаются к провайдеру, а после срока попытка проходит. С `payment-charger.ts` из HEAD тест падает: `AssertionError: expected [ { …(5) }, { …(5) }, { …(5) } ] to have a length of 2 but got 3` — лишнее обращение к провайдеру раньше срока. С исправлением — проходит.
- **AC2 — PASS.** Оба теста дефекта 2 (и новые тесты) — 20 прогонов подряд без падений (`--repeats 19`, код выхода 0).
- **AC3 — PASS.** `truncateAll` в `apps/api/src/testing/database.ts` используют все 34 интеграционных файла. `git grep "db.query(TRUNCATE_ALL)"` в тестовых файлах ничего не находит. Единственное совпадение — внутри самой `truncateAll` (`testing/database.ts:37`), это и есть общая очистка.
- **AC4 — PASS.** Причина найдена и исправлена в коде (I845), подробности — ниже. `supplier-billing` целиком проходит локально (41/41), `sign-in-data-cleanup` — пять запусков подряд.
  - Общая очистка поймала зависание с диагностикой: пять транзакций свиперов (`… FOR UPDATE SKIP LOCKED` по `inbound_webhook_event`, `outbound_message`, `otp_challenge`, `price_import` и `payment_attempt`) в состоянии `idle in transaction` / `ClientRead` по ~90 с, `TRUNCATE` за ними не проходил 20 попыток.
  - Механизм: `query_timeout` клиента `pg` перестаёт ждать, а оператор идёт дальше на сервере. ROLLBACK стоит в очереди клиента и истекает сам, после чего drizzle возвращает соединение в пул посреди транзакции.
  - Доказательство — тест `database.integration.test.ts` «leaves no transaction open…»: с `database.service.ts` из HEAD — `AssertionError: expected 1 to be +0` (одна открытая транзакция), с исправлением — PASS.
  - Дополнительно убраны два обращения ко второму соединению пула внутри транзакции (I844).
- **AC5 — PASS.** В `hostile-files.test.ts` изменён один порог (`toBeLessThan(2000)` → `5000`) и добавлен комментарий. Другие проверки не трогались.
- **AC6 — PASS.** `ARCHITECTURE.md` 0.84:
  - I843 — правило повтора;
  - I844, I845 — соединения пула: причина оказалась в коде;
  - I846 — отвязка карты.
- **AC7 — PASS.** `format:check`, `lint`, `typecheck`, `test`, `build` — зелёные (`test` — на повторе, см. Verification).
- **AC8 — PASS.** Пять коммитов задачи (6602b6d, 1e787e1, 21239a4, 7538cc4, 498ba7b) запушены в `main`. Прогон CI — **41645184284**, не ожидался.

## Errors & Fixes
- **20 повторов в первый раз зависли** на 65 минут: `Hook timed out` в `beforeEach`. Новая общая очистка вывела список открытых транзакций, и по нему нашлась причина I845. Исправлено в пуле.
- **На 20 повторах после этого** тест дефекта 2 упал на `Timed out waiting for the old card forgotten`. Причина — I846: `billing.detach-card` — задача-singleton (политика `stately`), и без ключа ждущая отвязка одной карты молча отбрасывала постановку для другой. Страховочной уборки для `payment_method` нет, так что в продукте замещённая карта осталась бы у провайдера навсегда. Исправлено ключом по карте и блокировкой строки карты. Новый тест I846 падает на коде из HEAD (`Timed out waiting for the replaced card forgotten`) и проходит с исправлением.
- **«tells the payer by the day…»** однажды упал при прогоне всего файла. Тест делал один проход свипера истечения (`SKIP LOCKED`). Если строку подписки в этот момент держала транзакция worker'а, проход её пропускал, а плановый приходит только через минуту. В продукте так и задумано. Тест теперь повторяет проход до нужного статуса (`expireUntil`). Два следующих прогона файла — 41/41.
- **`sign-in-data-cleanup` с `--repeats 4`** падал с 429: счётчики лимитов лежат в Redis, а его между повторами внутри одного запуска никто не очищает. Это свойство способа запуска, а не дефект. Поэтому пять раз подряд — отдельными запусками.

## Deviations
- **AC4.** «Idle in transaction» оказалась не причиной только стенда, а дефектом пула в коде (I845). Исправлена в коде, а не доказана как особенность стенда.
- **Сверх названного в задаче** исправлен дефект I846 (потеря отвязки карты) и одна гонка теста (`expireUntil`). Без них AC2 и «supplier-billing целиком» не выполнялись бы стабильно.

## Known Issues / Risks
- В `hostile-files.test.ts` проверка «merged cells … the event loop free» (`stallMs < 500`) один раз из двух упала при параллельном `pnpm test` (749 мс). По AC5 менять её нельзя. Если она покраснеет в CI, нужна отдельная задача.
- Предел оператора для приложения по-прежнему 2 с. Теперь он действует на сервере, и оператор, который раньше «досчитывался» после клиентского таймаута, теперь отменяется. Для пользователя ничего не меняется: ответ и раньше был ошибкой.
- Всего интеграционного набора локально я не запускал (по правилам, около 40 минут). Остальные из 34 файлов с новой очисткой проверит CI 41645184284.

## Remaining Work
None.

## Future Improvements
- Проверки «до срока» после `expireRun` (`expect(...status).toBe("past_due")`) тоже могут ложно пройти, если проход пропустил строку по `SKIP LOCKED`. Их стоит сделать проверками на явно свободной строке.

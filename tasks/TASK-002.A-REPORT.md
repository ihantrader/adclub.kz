# TASK REPORT — TASK-002.A

## Status
COMPLETED

## Result
Интеграционные тесты и цикл миграций TASK-002 проходят в CI на GitHub Actions — подтверждено фактическим зелёным прогоном:
https://github.com/ihantrader/adclub.kz/actions/runs/35140766394 (commit `be1ac01`, `conclusion: success`, получено через `gh run view --json`).

Причина падения — не флейки и не отличие окружений «вообще», а конкретный факт поведения Node на Linux (описан ниже), исправленный в самом коде, а не ослаблением проверки.

## Changes
- `apps/api/src/common/health/describe-error.ts` (+test) — `describeError(error)`: для `AggregateError` объединяет сообщения вложенных ошибок; иначе `error.message || error.name`; никогда не возвращает `""`.
- `apps/api/src/common/health/measure-check.ts` — использует `describeError` вместо `error instanceof Error ? error.message : String(error)`.
- `apps/api/src/database/database.service.ts`, `apps/api/src/redis/redis.service.ts` — та же замена в двух местах с идентичным паттерном (`pool.on('error', ...)`, `onModuleInit` пробник, `client.on('error', ...)`) — там оказалась та же проблема (пустое сообщение), обнаружено при проверке исправления.
- `apps/api/scripts/verify-graceful-shutdown.ts` — новый скрипт: запускает собранный `dist/worker.js` с недостижимыми зависимостями, дожидается старта, посылает `SIGTERM`, проверяет лог о грациозном завершении и код выхода 0.
- `apps/api/package.json` — скрипт `verify:graceful-shutdown`.
- `.github/workflows/ci.yml` — `push.branches` сужен с `["**"]` до `["main"]`; добавлен шаг «Verify worker shuts down gracefully on SIGTERM (Linux)» после `Build`.
- `ARCHITECTURE.md` 0.5 → 0.6, раздел 4.3 (I21–I23).

## Technical Decisions
- **Причина падения — не «Windows vs Linux вообще», а конкретный механизм Node.** Дуал-стек-подключение («Happy Eyeballs», RFC 8305): при попытке подключиться к `localhost`, который резолвится и в `127.0.0.1`, и в `::1`, и обе попытки проваливаются, Node/`pg` бросают `AggregateError`. У `AggregateError` без явно заданного текста `.message` по умолчанию — пустая строка `""`. `measureCheck` брал `error.message` напрямую → в CI (где этот путь реально сработал) `DependencyCheck.error` получался `""` → `expect(downCheck.error).toBeTruthy()` падал. Локально (Windows) тот же тест проходил — не потому что там нет этого поведения Node вообще (подтверждено: подключение к заведомо закрытому порту `localhost:1` на этой же Windows-машине тоже даёт `AggregateError` с пустым `message`), а потому что при остановке Testcontainers-контейнера на Windows соединение рвётся другим путём (`Error: Connection terminated unexpectedly`, обычный `Error` с непустым сообщением), а не через параллельный неудачный коннект по обоим стекам.
- **Исправление — не в тесте, а в продакшен-коде** (`describeError`), поскольку пустое сообщение об ошибке в `/ready` — это баг и в реальной эксплуатации (Linux, ARCHITECTURE 15.1: prod и staging — Linux VM), а не только причина падения теста.
- **CI-проверка грациозного завершения worker по SIGTERM** — закрывает Known Issue из TASK-002 (на Windows нельзя было это подтвердить). Проверено без реальных PostgreSQL/Redis/S3: зависимости указывают на заведомо закрытые локальные порты, что специально допустимо по дизайну (edge case TASK-002 — сервис стартует даже при недоступности зависимостей).
- **Триггер CI сужен, отмена устаревших прогонов и кэш pnpm — уже существовали** (с TASK-001), не добавлялись заново; проверено чтением `ci.yml`, не предположением.

Значимые решения зафиксированы в ARCHITECTURE.md 4.3 (I21, I22, I23).

## Verification
- **Доступ к CI получен и использован.** `gh` CLI аутентифицирован токеном из `.env` (`GITHUB_PAT`) через `gh auth login --with-token` (токен передан напрямую через pipe, не выведен и не сохранён нигде, кроме keyring `gh`). `gh auth status` подтвердил scope `repo`, `workflow` (и значительно шире — см. Known Issues/Risks) — достаточно для чтения статусов и логов Actions; ограничений не обнаружено.
- **Причина падения получена из реального лога**, не предположением: `gh run view 35138592469 --repo ihantrader/adclub.kz --log-failed` →
  ```
  AssertionError: expected '' to be truthy
  - Expected: true
  + Received: ""
   ❯ src/database/database.integration.test.ts:124:29
      122|     const downCheck = await databaseService.checkHealth();
      123|     expect(downCheck.status).toBe("error");
      124|     expect(downCheck.error).toBeTruthy();
  ```
  (тот же прогон показал, что все 7 тестов цикла миграций — up/status/down/status/up — прошли; упал только этот один тест).
- **Гипотеза подтверждена локальным экспериментом**: `node -e "console.log(new AggregateError([new Error('a'),new Error('b')]).message)"` → `""`; запрос к заведомо закрытому порту на этой машине (Windows) воспроизвёл тот же пустой `message` через `AggregateError`.
- `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm test` (35 тестов, включая новый `describe-error.test.ts`) / `pnpm test:integration` (8/8) / `pnpm build` — все PASS локально после исправления.
- **Реальный прогон CI после исправления — success**, получен через `gh run view --json status,conclusion,url`:
  ```
  {"conclusion":"success","status":"completed","url":"https://github.com/ihantrader/adclub.kz/actions/runs/35140766394"}
  ```
  Лог шага `Integration test`: `Test Files 1 passed (1)`, `Tests 8 passed (8)` — включая все шаги цикла миграций.
  Лог нового шага `Verify worker shuts down gracefully on SIGTERM (Linux)`: `Worker exited gracefully (code 0) after SIGTERM, logged "Received SIGTERM, shutting down".`
- **Отмена устаревшего прогона проверена реальным вторым push**, сделанным намеренно, пока первый прогон был `in_progress` (`gh run list` показал оба ID): первый прогон (`35140737558`) получил аннотацию `Canceling since a higher priority waiting request for ci-CI-refs/heads/main exists` и через несколько секунд перешёл в `completed / cancelled`; второй (`35140766394`) продолжился и завершился `success`. Использованный для этой проверки пуш — пустой коммит `be1ac01`, оставлен в истории как часть доказательства (не переписывал/не удалял).

## UAT / E2E
Не применимо в собственном смысле (задача про CI) — «UAT» здесь и есть реальный прогон CI, описанный выше и в Verification.

## Acceptance Criteria
- `AC-1 — PASS` — фактическая причина (AggregateError, пустой `.message`, Happy Eyeballs) приведена с фрагментом реального лога CI (см. Verification), без секретов.
- `AC-2 — PASS` — последний прогон CI: `success`, https://github.com/ihantrader/adclub.kz/actions/runs/35140766394, статус получен через `gh run view --json` (API/CLI), не предположением.
- `AC-3 — PASS` — в этом успешном прогоне выполнены `Integration test` (8/8, включая полный цикл миграций up→down→up) и новый шаг проверки грациозного завершения.
- `AC-4 — PASS` — ни один тест не удалён, не пропущен, не ослаблен; добавлены новые (`describe-error.test.ts`); шаг `Integration test` в CI остался.
- `AC-5 — PASS` — `push.branches: ["main"]`; `pull_request` без изменений; отмена устаревших прогонов подтверждена реальным вторым push (см. Verification); кэш pnpm уже существовал.
- `AC-6 — PASS` — токен не встречается в выводе, отчёте или коммитах; в терминале показывался только маскированный `gh auth status` (`ghp_****...`).
- `AC-7 — N/A` — прав токена хватило, `BLOCKED` не потребовался.

## Errors & Fixes
Единственная и полностью описанная выше находка: `AggregateError` с пустым `.message` (Node Happy Eyeballs) → `DependencyCheck.error` приходил пустой строкой только на Linux. Исправлено `describeError()`, применено в трёх местах с идентичным паттерном.

## Deviations
None.

## Known Issues / Risks
- **Токен из `.env` (`GITHUB_PAT`) сильно избыточен по правам** для задачи «читать статус/логи CI»: `gh auth status` показал scope, включающий `admin:enterprise`, `admin:org`, `delete_repo`, `admin:repo_hook` и другие административные права, далеко выходящие за пределы `repo`/`workflow`, которых было бы достаточно. Не менял и не отзывал — это решение Product Owner (как минимум стоит оценить, не создать ли отдельный token с минимальными правами для CI-задач агента).
- `gh` CLI остался аутентифицирован этим токеном (сохранён в системном keyring, аккаунт `ihantrader`) — на случай если это нежелательно, можно выполнить `gh auth logout --hostname github.com` (не делал сам, так как не было прямого запроса и это может быть полезно для дальнейшей работы).
- Пустой коммит `be1ac01`, использованный для проверки отмены устаревшего прогона, остался в истории `main` — не убирал (переписывание истории после push требует отдельного разрешения).
- Проверка грациозного завершения (I22) закрывает Known Issue TASK-002 только для **worker**-процесса; аналогичная проверка для API-процесса (`main.ts`, завершение через `enableShutdownHooks()`) не добавлялась — не требовалась ни TASK-002, ни TASK-002.A явно, но может быть полезна отдельно.

## Remaining Work
None.

## Future Improvements
- Отдельный GitHub PAT с минимальными правами (`repo` + `workflow`, возможно только для чтения) для задач вроде этой — снизит риск при случайной утечке/логировании.
- Аналогичная CI-проверка грациозного завершения для API-процесса (`main.ts`), если это станет важным (например, перед первым настоящим деплоем).

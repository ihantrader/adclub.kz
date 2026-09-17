# TASK REPORT — TASK-006.A

## Status
COMPLETED

## Result

- Незавершённый шаг входа (выбор компании, настройка TOTP, ввод TOTP или резервного кода) завершает только браузер, прошедший проверку кода. Одного токена из ответа 403 недостаточно. Другой клиент получает 401 `SIGN_IN_STEP_INVALID`: не узнаёт секрет TOTP, не тратит попытки администратора и резервные коды, не расходует шаг. Законный владелец после такого отказа завершает вход. Два входа в двух вкладках одного браузера не мешают друг другу.
- Удаление сотрудника в той же транзакции завершает все сессии кабинета этого членства: строки `session` получают `revoked_reason = access_closed` ещё до запросов с этих устройств. Восстановление членства (та же строка, тот же id) старые сессии не возвращает. Мобильная сессия, сессии в других компаниях и сессии других сотрудников продолжают работать.
- Вход в кабинет и смена компании блокируют строку членства (`FOR SHARE`), поэтому при одновременном удалении сессия не остаётся в контексте удалённого членства.
- Расшифровка секрета TOTP принимает только тег GCM полной длины (16 байт) и IV длиной 12 байт.
- Если срок шага входа больше 30 минут, процесс не стартует.
- Коды входа из `session.integration.test.ts` тоже проверяются на утечки. Теперь это делают все интеграционные тесты, которые получают коды.
- Продуктовое поведение не менялось. Контракт не менялся — в `openapi.json` уточнены только описания тел четырёх маршрутов шагов.

## Changes

- `infra/migrations/1789644232969_bind-sign-in-step-to-client.sql`: новая обратимая миграция, `sign_in_step.client_binding_hash TEXT NULL`. ORM-схема обновлена в `modules/identity/schema.ts`, новой таблицы нет.
- `session/sign-in-step-token.ts`: функции `newSignInStepBinding`, `hashSignInStepBinding`, `signInStepBindingMatches` (HMAC с разделением доменов, сравнение за постоянное время).
- `session/sign-in-step-cookie.ts` (новый): установка, чтение и удаление cookie `adclub_sign_in_<id шага>` (`HttpOnly; Secure; SameSite=Strict; Path=/auth/sign-in`, срок равен сроку шага).
- `session/sign-in-steps.service.ts`, `sign-in-step.store.ts`: `create` сохраняет хэш привязки и возвращает её. `open(token, binding, …)` проверяет привязку сразу после подлинности токена, при отказе пишет в журнал `reason=other_client`.
- `session/sign-in.service.ts`: `signIn` возвращает итог `signed_in | step_required` (с привязкой). `selectSupplier` принимает `stepBinding`. Членства читаются через `lockActive` (`FOR SHARE`).
- `login-code/login-code.controller.ts`: при `step_required` ставит cookie шага и бросает ошибку 403.
- `session/sign-in-step.controller.ts`: читает cookie шага на всех четырёх маршрутах, после успеха удаляет её.
- `admin/admin-auth.service.ts`: `startSetup`, `confirmSetup` и `verify` передают привязку в `open`.
- `session/session.store.ts`: `revokeMemberSessions`.
- `supplier/supplier-membership.store.ts`: `lockActive`, `lockActiveIn` (`FOR SHARE OF supplier_member`). `removeMember` заменён на `markRemoved(memberId, now, tx)`. Больше не используемый `findActive` удалён.
- `admin/operator.service.ts`, `operator.ts`: `removeMember` работает в одной транзакции с завершением сессий, пишет в журнал каждую завершённую сессию и возвращает `sessionsEnded`.
- `supplier/supplier-context.service.ts`: смена компании через `lockActiveIn`.
- `admin/admin-crypto.ts`: `authTagLength: 16`, проверка длины IV и тега.
- `config/env.schema.ts`: `signInStepTtl` — от 1 до 1800 секунд для `SIGN_IN_SUPPLIER_SELECTION_TTL_SECONDS` и `SIGN_IN_ADMIN_TOTP_TTL_SECONDS`. `.env.example` описывает предел.
- `packages/contracts/src/sign-in.ts`, `routes.ts`, `apps/api/openapi.json`: в описаниях указано, что нужна cookie шага и `credentials: "include"`.
- Тесты:
  - `access.integration.test.ts`: хелперы cookie шага, 5 новых тестов, тест удаления переписан под новое поведение.
  - `session.integration.test.ts`: регистрация кодов входа.
  - `database.integration.test.ts`: шаг цикла миграций для новой миграции.
  - `admin-crypto.test.ts`: укороченный тег, привязка шага.
  - `env.schema.test.ts`: предел сроков.
- Документы:
  - `ARCHITECTURE.md` 0.12: раздел 4.9 (I80–I85); уточнены 4.8 I69, I70, I71, I76, I78, 5.1 и 14.
  - `CLAUDE.md`: для шагов входа через curl нужен `-c/-b steps.txt`; удаление сотрудника сразу завершает его сессии.
  - `tasks/TASK-006-REPORT.md`: ссылка TASK-031 заменена на TASK-034.

## Technical Decisions

Все решения записаны в ARCHITECTURE.md 4.9.

- **I80 — отдельная cookie на каждый шаг.** Значение cookie случайное и своё у каждого шага, в базе хранится только его HMAC.
  - Одна cookie на браузер ломала бы два входа в двух вкладках.
  - Повторное использование значения из запроса допускало бы навязывание заранее известного значения (fixation).
  - Токен в теле ответа сохранён, контракт не менялся.
  - Шаги, созданные до миграции, завершить нельзя: они живут 10 минут, повторный вход создаёт привязанный шаг.
- **Мобильный клиент.** Шагов у мобильного приложения нет: `sessionKindForClient` сразу выдаёт мобильную сессию, шаги создаются только для `supplier-web` и `admin-web`. Если шаг когда-нибудь появится у клиента без cookie, `open` без привязки откажет, и привязку придётся передавать иначе (записано в I80).
- **I81.** Отдельная причина завершения не вводилась: используется `access_closed`, клиент получает тот же 401 `SUPPLIER_ACCESS_CLOSED`. Проверка в предикате (I76) оставлена как страховка — её покрывает отдельный тест.
- **I82.** Блокировка `FOR SHARE` строки членства во всех путях, которые привязывают к нему сессию: `verify`, выбор компании, смена компании. Порядок блокировок везде «членство → сессия».
- **I83.** Формат `v1` сохранён, уже записанные секреты расшифровываются.
- **I84.** Предел — 30 минут: этого хватает, чтобы установить приложение-аутентификатор.
- **I85.** Коды из `session.integration.test.ts` регистрируются после каждого теста.

## Verification

- `pnpm format:check` — PASS.
- `pnpm lint` — PASS.
- `pnpm typecheck` — PASS.
- `pnpm test` — PASS: 12/12 задач Turborepo; в `@adclub/api` 20 файлов, 226 тестов.
- `pnpm test:integration` (`apps/api`, Testcontainers) — PASS с третьего полного прогона: 5 файлов, 133 теста.
  - Первый и второй прогоны (до исправления теста миграций) — FAIL, по 6 тестов в каждом:
    - 5 в `database.integration.test.ts`: не учтена новая миграция, тест исправлен.
    - 1 в `session.integration.test.ts`: в каждом прогоне другой тест TASK-005, зависящий от времени (подробности — в «Errors & Fixes»).
  - Отдельный прогон `access.integration.test.ts` до этого: 31 тест, 1 падение в новом тесте — исправлен сам тест, код не менялся.
- `pnpm --filter @adclub/api openapi:check` — PASS после `openapi:generate` (изменились 4 описания).
- `pnpm --filter @adclub/api openapi:compat --base HEAD` — PASS: «Contract is backward compatible», ломающих изменений нет, трейлер не нужен.
- `pnpm build` — PASS, 10/10 задач.
- `pnpm --filter api migrate` в dev — PASS: применена `1789644232969_bind-sign-in-step-to-client`. `migrate:status` — Pending (0).
- Цикл миграций `down`/`up` — PASS в интеграционном тесте. Откат удаляет столбец, строки шагов сохраняются.
- CI на `main`: прогон **35217202332** для `fd46a96` (последний коммит кода и документации, в него входят `9d757df` и `1a22149`). Статус — в разделе «Коммиты».

## UAT / E2E

Окружение: dev.
- API: `tsx src/main.ts` на `:3000` со сниженными `LOGIN_CODE_RESEND_INTERVAL_SECONDS=1` и лимитами кодов.
- Docker Compose dev (PostgreSQL, Redis).
- Запросы — curl с отдельными cookie-файлами на «браузер», коды — из `/dev/login-codes`, компании и сотрудники — серверной командой, TOTP-коды — RFC 6238 на node.
- Номера `+77019990011/12/13`, после прогона администратор снят.

1. **Сотрудник двух компаний.**
   - `verify` с `X-Client: supplier-web/0.1.0` → `403 SUPPLIER_SELECTION_REQUIRED`. В cookie-файле одна cookie `adclub_sign_in_…` с путём `/auth/sign-in` и флагом HttpOnly.
   - Токен шага без cookie → `401 SIGN_IN_STEP_INVALID`.
   - С исходного клиента → `200`, компания «UAT Альфа». Refresh-токена в теле нет. Cookie шага после успеха удалена (в файле 0).
   - Повтор → `401 SIGN_IN_STEP_INVALID`.
2. **Удаление и восстановление сотрудника.**
   - Вход → `200`, `GET /supplier/company` → `200`.
   - `dev:member:remove` → `{"removed":true,"sessionsEnded":1}`. В базе `revoked_reason = access_closed` — до какого-либо запроса этой сессии.
   - `dev:member:add` → тот же `memberId`.
   - Старый access-токен → `401 SUPPLIER_ACCESS_CLOSED`, старая refresh-cookie → `401 SUPPLIER_ACCESS_CLOSED`.
   - Новый вход → `200`, `GET /supplier/company` → `200`.
3. **Администратор.**
   - `admin:grant`, `verify` с `X-Client: admin-web/0.1.0` → `403 TOTP_SETUP_REQUIRED`.
   - `…/totp/setup` без cookie → `401 SIGN_IN_STEP_INVALID`, секрета в ответе нет. С исходного клиента → `200`.
   - `…/setup/confirm` без cookie → `401`. С исходного клиента → `200`, контекст `admin`, 10 резервных кодов.
   - Следующий вход → `403 TOTP_REQUIRED`. `…/totp` без cookie → `401 SIGN_IN_STEP_INVALID`. С исходного клиента → `200`, контекст `admin`.
   - `GET /admin/administrators` → `200`.

Журнал API за прогон:
- есть строки `Sign-in step refused step=… reason=other_client`;
- 0 совпадений `st1.<uuid>.` и `otpauth://`;
- 0 вхождений полных номеров `7701999`.

Первый прогон скрипта: все статусы совпали, но одна строка вывода (старая сессия после восстановления) не разобралась из-за ошибки в самом скрипте. Скрипт исправлен и прогнан заново на новых номерах — результат выше. Экраны не делались (TASK-031, TASK-034).

## Acceptance Criteria

- **AC-1 — PASS.**
  - Тест `access.integration.test.ts` → «lets only the browser that passed the code finish the company choice»:
    - атрибуты cookie шага;
    - отказ 401 без cookie, с cookie другого шага, с её значением под именем этого шага, с выдуманным значением, с секретом токена, с пустым и с повторённым значением — и для компании сотрудника, и для чужого id;
    - сессий 0, `consumed_at` у шага пуст;
    - владелец завершает вход, cookie удаляется;
    - два шага в двух вкладках одного браузера завершаются;
    - у мобильного клиента cookie шага нет;
    - в журнале `reason=other_client`.
  - Тест «lets only the browser that passed the code set up or pass the second factor»:
    - `setup` без cookie не отдаёт секрет, `totp_secret` в шаге пуст;
    - `confirm` без cookie → 401, владелец → 200;
    - при лимите 1 попытка на администратора три вида чужих попыток с кодом TOTP и с резервным кодом → 401, резервных кодов использовано 0;
    - владелец с тем же кодом → 200, сессий админки 2.
  - UAT, сценарии 1 и 3.
- **AC-2 — PASS.**
  - Тест «ends the cabinet sessions of a removed employee in the removal itself…»:
    - `removeMember` → `{ sessionsEnded: 2 }`;
    - обе сессии компании A (два браузера) имеют `access_closed` до любого запроса, незавершённых сессий у членства 0;
    - сессия в компании B, сессия другого сотрудника и мобильная работают;
    - после восстановления (тот же id) сессия, не обращавшаяся к серверу, отклонена по access- и refresh-токену;
    - новый вход работает;
    - строки журнала оператора проверены.
  - Тест «still ends a session whose membership was removed behind its back…» — страховка предиката.
  - UAT, сценарий 2.
- **AC-3 — PASS.** Два детерминированных теста:
  - «…switch first»: смена ждёт на `update "session"`, удаление ждёт на `update "supplier_member"` (видно в `pg_stat_activity`). Итог: 200, `sessionsEnded: 1`, у сессии `supplier_member_id = memberB` и `access_closed`, запрос → 401.
  - «…removal first»: удаление ждёт на `update "session" set "revoked_at"`, смена — на `for share`. Итог: 404, сессия в компании A и активна.
  - Без блокировки ожидание на `update "supplier_member"` / `for share` не наступило бы, и тест упал бы по таймауту.
- **AC-4 — PASS.** Тест `admin-crypto.test.ts` → «accepts only the full-length tag…»:
  - «мягкая» расшифровка принимает префиксы тега длиной 4, 8, 12, 13 и 15 байт, а `openSecret` их отклоняет (`Malformed sealed secret`);
  - также отклоняются удлинённый тег и укороченный IV.
- **AC-5 — PASS.** Тест `env.schema.test.ts` → «refuses to start with a sign-in step that stays open longer than 30 minutes»: для обеих переменных 1801 → ошибка с именем переменной и «at most 1800», 0 → ошибка, 1800 принимается.
- **AC-6 — PASS.**
  - Коды входа регистрируют после каждого теста: `session.integration.test.ts` (добавлено в этой задаче), `login-code.integration.test.ts` и `access.integration.test.ts` (было раньше).
  - В `session.integration.test.ts` добавлена проверка `rememberedCodes().size > 50`.
  - Два других интеграционных файла (миграции, дрейф схемы) кодов не получают.
  - Значения cookie шагов регистрируются как секреты. Итоговая проверка `expectNoSecretsWritten` прошла во всех файлах.
- **AC-7 — PASS.**
  - `openapi:compat --base HEAD`: совместимо, трейлер не нужен. Изменились только описания.
  - Миграция обратима, это проверено шагом цикла в `database.integration.test.ts`.
  - Новых таблиц нет. Столбец добавлен в ORM-схему, проверка дрейфа схемы (`schema-drift.integration.test.ts`) прошла.
- **AC-8 — PASS (с оговоркой о статусе CI коммита с отчётом).**
  - Существующие тесты не ослаблены. Тест удаления сотрудника переписан, потому что поведение изменилось по требованию задачи: строки журнала «при следующем запросе» проверяются теперь в отдельном тесте страховки.
  - Коммиты сделаны по D-024, состав — ниже.
  - CI 35217202332 для `fd46a96` — статус в разделе «Коммиты».
  - CI коммита с этим отчётом — в ответе сессии.
- **AC-9 — PASS.**
  - `ARCHITECTURE.md` 0.12: раздел 4.9 (I80–I85), история изменений, уточнения 4.8, 5.1 и 14.
  - В `tasks/TASK-006-REPORT.md` (строка 242) TASK-031 заменён на TASK-034. Та же ошибка была в ARCHITECTURE 4.8 I71 — исправлена там же.

## Errors & Fixes

- **Python на Windows записал CRLF.** Правки через Python переписали концы строк в изменённых файлах, и diff показал весь файл. Исправлено приведением к LF до коммита; дальнейшие скрипты пишут с `newline='\n'`.
- **Лимит в новом тесте админки.** Тест упал с 429: подтверждение настройки уже засчиталось в лимит `admin_totp_per_admin` до его снижения до 1. Исправлен тест — перед снижением лимита Redis очищается. Код не менялся.
- **Цикл миграций.** `database.integration.test.ts` ожидал 4 миграции. Добавлен шаг отката новой миграции, прежний шаг `roles` стал следующим.
- **Тесты TASK-005, зависящие от времени.** В первом полном прогоне упал «stays signed in until an explicit logout…» (access-токен с TTL 1 с истёк до `logout`), во втором — «never extends an admin session past 12 hours…» (`accessTokenExpiresAt` на 17 мс позже конца сессии из-за округления `exp` до секунды). Затронутые пути (`session.service` `tokens`) задача не меняла. Третий полный прогон — 133/133. Вынесено в Known Issues.

## Deviations

- Файл `CLAUDE.md` не входит в список документов, которые я веду. Но в нём мои инструкции dev из TASK-006 (вход в кабинет и админку через curl), и без cookie шага они перестали работать. Поправлен только этот фрагмент.
- ARCHITECTURE 4.8 I71 содержал ту же ошибку «TASK-031 вместо TASK-034», что и отчёт TASK-006, — исправлена там же.
- Строка «Основание» в ARCHITECTURE обновлена до SCREENS.md 1.1 и DESIGN.md 0.4 — это актуальные версии по постановке сессии.

## Known Issues / Risks

- **Веб-клиентам нужны credentials.** TASK-031 и TASK-034 должны вызывать `verify` и маршруты шагов с `credentials: "include"` (в `@adclub/api-client` это опция клиента). Иначе шаг не завершится, ответ — `SIGN_IN_STEP_INVALID`.
- **Cookie шага и SameSite.** Cookie шага, как и refresh-cookie, передаётся при `SameSite=Strict`. Веб-клиент и API должны быть одним сайтом (`localhost` в dev, поддомены одного домена в production), как и для сессий TASK-005.
- **Шаги, созданные до миграции.** Их нельзя завершить, пользователю нужно войти заново. Влияние — не дольше срока шага (10 минут) после выкладки.
- **Неустойчивые тесты TASK-005.** Два теста в `session.integration.test.ts` зависят от времени (TTL 1 с и секундное округление `exp`) и изредка падают на медленной машине. Код не менялся, см. Future Improvements.
- **Потеря контекста у сессии без запросов (4.8 I76).** Если завершить членство в обход `OperatorService.removeMember` (например, будущим кодом TASK-017, который не использует этот путь), сессии отклоняются только на ближайшем запросе. Правило записано в I81: TASK-017 обязана завершать сессии в той же транзакции.

## Remaining Work
None.

## Future Improvements

- Устранить неустойчивость двух тестов TASK-005, зависящих от времени:
  - TTL access-токена больше 1 с либо ожидание с запасом;
  - сравнение `accessTokenExpiresAt` с концом сессии с учётом секундного округления.
  - Отдельно — в `SessionService.tokens` `exp` не должен выходить за конец сессии даже в последнюю секунду: сейчас `max(now + 1, …)` может превысить конец сессии меньше чем на 1 с. Сессия при этом всё равно отклоняется проверкой строки.
- Периодическая очистка истёкших строк `sign_in_step` (индекс по `expires_at` уже есть) — задача worker.

## Коммиты

1. `1a22149` — «Update project plan and state, add TASK-006.A (Product Owner edits)»: `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-006.A.md` (правки Product Owner, отдельным коммитом в `main` по D-024).
2. `9d757df` — «Bind sign-in steps to the client and end sessions of removed employees (TASK-006.A)» — 26 файлов:
   - `.env.example`, `apps/api/openapi.json`, `infra/migrations/1789644232969_bind-sign-in-step-to-client.sql`;
   - `packages/contracts/src/routes.ts`, `packages/contracts/src/sign-in.ts`;
   - `apps/api/src/config/env.schema.ts`, `env.schema.test.ts`, `apps/api/src/database/database.integration.test.ts`, `apps/api/src/operator.ts`;
   - в `apps/api/src/modules/identity/`:
     - `access.integration.test.ts`, `schema.ts`;
     - `admin/admin-auth.service.ts`, `admin/admin-crypto.ts`, `admin/admin-crypto.test.ts`, `admin/operator.service.ts`;
     - `login-code/login-code.controller.ts`;
     - `session/session.integration.test.ts`, `session/session.store.ts`, `session/sign-in-step-cookie.ts` (новый), `session/sign-in-step-token.ts`, `session/sign-in-step.controller.ts`, `session/sign-in-step.store.ts`, `session/sign-in-steps.service.ts`, `session/sign-in.service.ts`;
     - `supplier/supplier-context.service.ts`, `supplier/supplier-membership.store.ts`.
3. `fd46a96` — «Document TASK-006.A decisions in ARCHITECTURE 4.9 and fix TASK-006 report»: `ARCHITECTURE.md`, `CLAUDE.md`, `tasks/TASK-006-REPORT.md`. Коммиты 1–3 отправлены в `main` одним push. CI-прогон **35217202332** для `fd46a96` — статус: **success** (все шаги, включая Integration test, OpenAPI и совместимость контракта).
4. Коммит с этим отчётом: `tasks/TASK-006.A-REPORT.md`. У коммита, который фиксирует собственный CI, номера прогона ещё нет, поэтому номер и статус этого прогона — в ответе сессии.

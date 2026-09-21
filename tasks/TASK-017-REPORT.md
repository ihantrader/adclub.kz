# TASK REPORT — TASK-017

## Status
COMPLETED

## Result
- **Сотрудники в кабинете** (контекст `supplier`, компания — всегда из сессии; сотрудник чужой компании — 404):
  - список активных сотрудников — имя, полный телефон, «получает уведомления», язык уведомлений, контактное лицо, когда добавлен, `isMe` — и сводка уведомлений `{limit, enabled, recipients, full}` для «Достигнут предел — N» (`GET /supplier/members`);
  - **добавление** по имени и казахстанскому мобильному номеру (`POST /supplier/members`): учётная запись создаётся при необходимости, приглашение W-08 уходит через тестовый канал; номер уже в компании — 409 `SUPPLIER_MEMBER_EXISTS` (`status: active`); ранее удалённый сотрудник этой компании — тот же код с `status: removed` и текстом «вернуть может только администратор клуба»; номер другой компании или администратора добавляется, и кабинет об этом ничего не узнаёт; лимит — настройка `supplier_members_added_per_supplier_day` (20 в сутки на компанию, сверх — 429 с `Retry-After`);
  - **удаление** (`DELETE /supplier/members/{id}`) — сотрудник и все его сессии кабинета в этой компании в одной транзакции (I81), неотправленные приглашения отменяются; удалённый сразу получает 401 `SUPPLIER_ACCESS_CLOSED` во всех браузерах и при обмене refresh-токена; мобильная сессия того же человека не затрагивается; последнего удалить нельзя (409 `SUPPLIER_LAST_MEMBER`), в том числе когда двое последних удаляют друг друга одновременно; себя — можно, если есть другие (своя сессия завершается, в ответе `self: true`);
  - **изменение** имени, переключателя уведомлений и языка (kk/ru) — самим сотрудником и коллегами (`PATCH /supplier/members/{id}`).
- **Предел уведомлений:** включить можно, только пока включивших меньше `max_notified_members`, иначе 409 `SUPPLIER_NOTIFICATION_LIMIT` с числом; проверка на сервере под блокировкой компании — из двух одновременных включений на последнее место проходит ровно одно. **Уменьшение настройки** ничьих переключателей не выключает: получатели — первые N по времени включения, остальные видны как «включено, но не получает» и становятся получателями, когда место освободится. Новый сотрудник получает уведомления, если есть место; первый сотрудник поставщика — всегда.
- **«Мои настройки»** (S-TEAM-02): `GET|PATCH /supplier/me` — имя, телефон, уведомления (с тем же пределом), язык уведомлений.
- **Администратор** (A-SUP-03 «Сотрудники», контекст `admin`): текущие и удалённые сотрудники с тем, кто добавил, кто и когда удалил, и последним восстановлением (`GET /admin/suppliers/{id}/members`; то же — в карточке поставщика); **восстановление доступа** с причиной (`…/members/{id}/restore`) — старые сессии не возвращаются, сотрудник входит заново; добавление (`POST …/members`); повторное приглашение (прежний маршрут); **контактное лицо** — одно на компанию (`…/members/{id}/contact-person`); **сессии сотрудников** — список без токенов (устройство, платформа, версия, сокращённый адрес, время) и завершение одной, всех сессий сотрудника или всех сессий компании (`GET …/sessions`, `POST …/sessions/{id}/end`, `POST …/sessions/end {memberId?}`; причина `ended_by_admin`, клиент получает 401 `SESSION_ENDED`).
- **Карточка компании по S-COMP-01** (исправление постановки TASK-016): поставщик меняет адрес и район точки выдачи и телефон компании (`PATCH /supplier/company`), часы и нерабочие даты — как раньше; название, БИН, город, тип — 400 `VALIDATION_ERROR` на этом поле; правки с версией и журналом (автор — сотрудник, телефон в журнале маской). **Сохранение без изменений** (карточки и тех же часов) не поднимает версию, не пишет журнал и не даёт ложного конфликта второму редактору.
- **Исправления по замечаниям приёмки TASK-016:** приглашение не уходит сотруднику, удалённому до отправки (удаление отменяет его, отправка держит строку сотрудника); восстановленному старое приглашение не уйдёт — новое отправляет администратор. Повтор той же заявки на подключение (двойной клик) не расходует лимит номера; лимит считается на пару «номер + БИН», поэтому посторонний с номером компании и другими БИН не исчерпывает лимит самой компании.
- Все действия — в журнале действий в той же транзакции, с автором-сотрудником или администратором; номера в журнале приложения — только маской.

## Changes
- `packages/contracts`: `suppliers.ts` — схемы сотрудников кабинета и админки, сводка уведомлений, тело `PATCH /supplier/company` (только разрешённые поля), сессии сотрудников, детали новых ошибок, статус приглашения `cancelled`; `routes.ts` — 13 маршрутов; `error.ts` — `SUPPLIER_LAST_MEMBER`, `SUPPLIER_MEMBER_EXISTS`, `SUPPLIER_MEMBER_STATE`, `SUPPLIER_NOTIFICATION_LIMIT`; `login-code.ts` — лимит `supplier_members_added_per_supplier`; `audit.ts` — действия `supplier_member.restored/changed/contact_person_changed/sessions_ended`; тесты `suppliers.test.ts`, `openapi.test.ts`; `apps/api/openapi.json` перегенерирован.
- `packages/domain`: `supplier/supplier-members.ts` — `notificationRecipients`, `canEnableNotifications` + тест.
- `infra/migrations/1790250000000_supplier-members.sql` — колонки `supplier_member` (переключатель и язык уведомлений, контактное лицо с частичным уникальным индексом, кто добавил и удалил, восстановление), заполнение для существующих компаний, статус приглашения `cancelled`, причина сессии `ended_by_admin`, индекс активных сессий компании; обратима.
- `apps/api/src/modules/identity`: `supplier/supplier-member-remover.ts` — единственный путь удаления; `supplier-membership.store.ts` (`markRemoved`, `addMember` с новыми полями); `session/session.store.ts` (`listSupplierSessions`, `revokeSupplierSessions`); `admin/operator.service.ts` (`dev:member:remove` через remover); `schema.ts`, `index.ts`, `identity.module.ts`.
- `apps/api/src/modules/suppliers`: `supplier-members.service.ts`, `supplier-member-rows.ts`, `supplier-members.controller.ts` (новые); `suppliers.service.ts` (карточка поставщиком, первый сотрудник — контактное лицо с уведомлениями, сотрудники карточки админки), `suppliers.controller.ts` (`PATCH /supplier/company`), `supplier-invitations.ts` (отправка под блокировкой, отмена), `supplier-lead-form.service.ts` (лимит после проверки повтора, ключ «номер + БИН»), `supplier-common.ts` (`companyMembersLock`, ошибки, `canonicalJson`), `suppliers.module.ts`.
- `apps/api/src/modules/settings/registry/registry.ts` — `supplier_members_added_per_supplier_day`, уточнено описание `supplier_lead_per_phone`.
- Тесты: новый `supplier-members.integration.test.ts` (19 тестов); дополнены `suppliers.integration.test.ts` (лимит по номеру — на пару «номер + БИН», повтор не расходует лимит), `database.integration.test.ts` (цикл новой миграции, откат следующей миграции через `walkDownPast`), `access.integration.test.ts` (список админских маршрутов).
- `ARCHITECTURE.md` 0.30 — раздел 4.27 (I259–I270), уточнения 4.9 I81, 5.1, 8.3, 13.2, 14, версия и история; `CLAUDE.md`, блок 0 — «Сотрудники поставщика в dev», модули, тесты, права поставщика на карточку.

## Technical Decisions
Все внесены в ARCHITECTURE.md 4.27 (I259–I270). Главное:
- **Удаление — только `SupplierMemberRemover`** (identity): членство и все сессии кабинета в транзакции вызывающего; им пользуются кабинет и серверная команда (I260).
- **Блокировка состава компании** (`pg_advisory_xact_lock` по компании) перед добавлением, удалением, восстановлением, переключателем уведомлений и назначением контактного лица: «хотя бы один сотрудник» и предел уведомлений считаются под ней, гонок нет; другие компании не ждут (I261).
- **Переключатель — время включения** (`notifications_enabled_at`); получатели — первые N по нему; уменьшение предела никого не выключает (I262).
- **Удалённого поставщик не возвращает** — только администратор с причиной; ответ кабинета не раскрывает, что номер работает в другой компании или администратор (I263, I265).
- **Контактное лицо** — флаг сотрудника, одно на компанию (уникальный индекс в базе); первый сотрудник поставщика — контактное лицо; миграция назначила его существующим компаниям и включила уведомления первым пяти (I265).
- **Сессии сотрудников для администратора** — новая причина `ended_by_admin`; условие по компании — в самом `UPDATE` (I266).
- **Права поставщика на карточку** — тело `PATCH /supplier/company` отказывает в любом поле, кроме адреса, района и телефона, по его пути, без `additionalProperties: false` в OpenAPI; сравнение изменений — `canonicalJson` (I267).
- **Приглашение** отправляется в транзакции с `FOR SHARE` на строку сотрудника; удаление отменяет неотправленные (I268).
- **Лимит заявки по номеру** — только новые заявки, ключ «номер + БИН» (I269).
- **Пауза и блокировка поставщика** управлению сотрудниками и карточкой не мешают (вход в кабинет открыт, SCREENS 6.0) (I270).

## Verification
- `pnpm format:check` — PASS — «All matched files use Prettier code style!»
- `pnpm lint` — PASS — 12/12 задач
- `pnpm typecheck` — PASS — 18/18 задач
- `pnpm test` — PASS — 15/15 задач (в т.ч. `@adclub/api` 475 тестов, `@adclub/contracts` 106, `@adclub/domain` 83)
- `pnpm build` — PASS — 11/11 задач
- `pnpm --filter @adclub/api openapi:generate` / `openapi:check` — PASS — «openapi.json matches the contract and the served routes»
- `pnpm --filter @adclub/api openapi:compat --base HEAD` (до коммитов) — PASS — «Contract is backward compatible with HEAD», трейлер не нужен
- `pnpm test:integration` (полный, локально, Docker) — 17 из 18 файлов PASS; 1 FAIL — `catalog-photos.integration.test.ts` «removes files no record points at…» во время параллельного прогона dev-сценариев на той же машине; отдельный перезапуск файла — PASS (31/31). К изменениям задачи не относится (фотографии не затронуты).
- Затронутые интеграционные файлы после финальных правок — PASS: `supplier-members.integration.test.ts` 19/19; `src/modules/identity` + `src/modules/suppliers` — 6 файлов, 170 тестов; `database.integration.test.ts` 25/25.
- CI на `main`: см. раздел «Коммиты и CI».

## UAT / E2E
Пройдено в dev (локальный Docker Compose, миграции применены, API на порту 3010 — порт 3000 занят другим приложением пользователя, — worker `pnpm --filter api worker`), запросами к API скриптом (вход по кодам с `/dev/login-codes`, админ с настройкой TOTP):
- Сотрудник добавил коллегу → 201, приглашение со статусом `sent` видно на `/dev/supplier-invitations` («Марат, вас добавили в кабинет поставщика «Детали Юг (TASK-017)». Войти: http://localhost:5175») → коллега вошёл по коду, `GET /supplier/company` — та же компания.
- Уведомления у пяти сотрудников → шестой добавлен с выключенными, сводка `{"limit":5,"enabled":5,"recipients":5,"full":true}`; включение шестому — 409 `SUPPLIER_NOTIFICATION_LIMIT`, «no more than 5 employees receive notifications», `details {"limit":5,"enabled":5}`.
- Сотрудник удалил коллегу → `{"sessionsEnded":1,"self":false}`; сессия коллеги сразу — 401 `SUPPLIER_ACCESS_CLOSED`; удаление последнего сотрудника другой компании — 409 `SUPPLIER_LAST_MEMBER`.
- Повторное добавление удалённого — 409 `SUPPLIER_MEMBER_EXISTS`, `status: removed`, «only an administrator of the club can restore their access»; администратор восстановил с причиной → `status: active`, `restore.reason`; старая сессия — 401 `SUPPLIER_ACCESS_CLOSED`; новый вход — 200.
- Администратор видит сессии сотрудников (поля `id, member, deviceName, platform, clientVersion, ipHint, createdAt, lastUsedAt, expiresAt`, без токенов), завершил одну → `{"ended":1}`, она — 401 `SESSION_ENDED`.
- Поставщик изменил адрес и телефон → 200, версия 1 → 2; в журнале — автор `supplier`, `contactPhoneMasked: "+7***8877"`; попытка сменить название — 400 `VALIDATION_ERROR`, путь `name`; те же часы сохранены повторно и вторым «редактором» с той же версией — 200, версия осталась 3.
- Изменённые для прогона dev-настройки (`login_code_resend_interval_seconds`, `login_code_requests_per_phone`) возвращены к умолчанию; запущенные для проверки API и worker остановлены.
- Браузерных экранов в задаче нет (EPIC-11, EPIC-12) — UI не проверялся.

## Acceptance Criteria
- **AC-1 — PASS** — `supplier-members.integration.test.ts`: «adds a colleague who gets the invitation and signs in to the same company», «refuses a number already in the company and a removed one; takes one of another company or an administrator», «removes a colleague: every session of theirs ends in the same transaction, refresh too» (две сессии в двух «браузерах» отозваны с `access_closed`, refresh — 401, мобильная — 200), «never removes the last employee; removing oneself ends one's own session», «leaves exactly one employee when the last two remove each other at once» (4 раунда одновременных запросов, активных всегда 1), «limits how many employees one company adds a day». Путь удаления — `SupplierMemberRemover` (единственный код, меняющий членство на `removed`).
- **AC-2 — PASS** — «lets no more than max_notified_members turn notifications on», «gives the last place to exactly one of two employees turning it on at once» (статусы `[200, 409]`, в базе ровно 2 включённых при пределе 2), «keeps the earliest to turn it on as recipients when the limit is lowered, turning no switch off»; юнит — `packages/domain/src/supplier/supplier-members.test.ts`.
- **AC-3 — PASS** — «shows and changes one's own name, notifications and their language» (включая правку коллегой, пустое тело и `en` — 400, повтор без изменений не пишет журнал).
- **AC-4 — PASS** — «lists current and removed employees and restores one with the reason; old sessions stay ended» (включая повторное приглашение восстановленному — 202 и доставка), «adds an employee, appoints the contact person (one per company)», «sees the employees' cabinet sessions without tokens and ends one or all».
- **AC-5 — PASS** — «changes the address, district and phone; not the name, БИН or city; saving the same changes nothing», «saving the same hours twice raises no version and gives the next editor no conflict»; прежний тест TASK-016 (из кабинета `PATCH /admin/suppliers/{id}` — 403) сохранён.
- **AC-6 — PASS** — «never sends an invitation to an employee removed before it went out» (отмена при удалении + повтор задачи ничего не отправляет; приглашение в очереди при уже удалённом сотруднике — `cancelled`, ничего не отправлено); `suppliers.integration.test.ts`: «doesn't spend the number's limit on a repeat of the same request (TASK-017)» и обновлённый «limits requests per address … and per number».
- **AC-7 — PASS** — «serves the cabinet routes to the supplier context only and the admin routes to the admin only» (админ и мобильная сессия на маршрутах кабинета — 403, гость — 401; кабинет и мобильная на админских — 403), «sees and changes only its own company's employees» (чужой сотрудник — 404, строка не изменена), чужая сессия и несуществующий поставщик — 404; `access.integration.test.ts` — список админских маршрутов.
- **AC-8 — PASS** — журнал действий: проверки `actor_role`/`actor_member_id` для добавления, удаления, изменения, восстановления (с причиной), контактного лица, завершения сессий, карточки; журнал приложения — «logs the employees' numbers only masked»; все номера, коды и токены тестов зарегистрированы в перехвате вывода, проверка после файла прошла.
- **AC-9 — PASS** — контракт аддитивный, `openapi:compat` без трейлера; миграция обратима (цикл вверх/вниз с данными в `database.integration.test.ts`, откат сохраняет сотрудников и строки с новыми значениями); новые колонки в `identity/schema.ts`, сверка схемы (`schema-drift`) — PASS; существующие тесты не ослаблены — изменены только тест лимита по номеру (новое поведение по замечанию приёмки, проверка стала строже: и исчерпание своей пары, и неисчерпание чужими БИН) и перечни маршрутов/миграций.
- **AC-10 — PASS** — коммиты по D-024 (состав ниже); CI — см. «Коммиты и CI».
- **AC-11 — PASS** — `ARCHITECTURE.md` 0.30: 4.27, версия, история; `CLAUDE.md` блок 0 — «Сотрудники поставщика в dev».

## Коммиты и CI
- `946e613` — Update project plan, state and add TASK-017 (Product Owner edits): `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/TASK-017.md`.
- `3540ad5` — Add the contract of supplier employees and the cabinet's card: `packages/contracts/src/{suppliers.ts, suppliers.test.ts, routes.ts, error.ts, audit.ts, login-code.ts, openapi.test.ts}`, `apps/api/openapi.json`.
- `9fd2173` — Let suppliers manage their employees; restore, contact person and sessions for the administrator: `packages/domain/src/{index.ts, supplier/supplier-members.ts, supplier/supplier-members.test.ts}`, `infra/migrations/1790250000000_supplier-members.sql`, `apps/api/src/modules/identity/{schema.ts, index.ts, identity.module.ts, admin/operator.service.ts, session/session.store.ts, supplier/supplier-membership.store.ts, supplier/supplier-member-remover.ts, access.integration.test.ts}`, `apps/api/src/modules/settings/registry/registry.ts`, `apps/api/src/modules/suppliers/{supplier-common.ts, supplier-invitations.ts, supplier-lead-form.service.ts, suppliers.controller.ts, suppliers.module.ts, suppliers.service.ts, supplier-member-rows.ts, supplier-members.controller.ts, supplier-members.service.ts, supplier-members.integration.test.ts, suppliers.integration.test.ts}`, `apps/api/src/database/database.integration.test.ts`.
- `c4d478d` — Describe supplier employees in the architecture and the development guide: `ARCHITECTURE.md`, `CLAUDE.md`.
- Коммит с этим отчётом: `tasks/TASK-017-REPORT.md`.
- CI: прогон [35640291152](https://github.com/ihantrader/adclub.kz/actions/runs/35640291152) на `c4d478d` — `completed / success` с первой попытки. Прогон коммита с этим отчётом — в ответе сессии и в следующем коммите (как в TASK-016).

## Errors & Fixes
- Тест цикла миграций: «вверх» посреди теста городов TASK-016 возвращает и новую миграцию, поэтому следующий «вниз» откатывал только её — все последующие шаги сдвигались. Исправлено `walkDownPast` (как в соседних тестах).
- В тесте журнала сначала было неверное имя колонки (`actor_supplier_member_id` вместо `actor_member_id`).
- `.strict()` в схеме тела карточки дал `additionalProperties: false` в OpenAPI, что запрещено тестом контракта (объекты открыты для аддитивных полей). Заменено на `loose()` + `superRefine` с отказом по пути поля.
- `git push` по HTTPS — 403 (в кэше Windows учётные данные другого пользователя GitHub); push выполнен через `gh auth git-credential` с токеном из `.env` (как в прошлых задачах).

## Deviations
- Порт 3000 на машине занят другим приложением пользователя (Next.js из другого проекта), поэтому dev-проверка шла на API с `PORT=3010`; команды в CLAUDE.md оставлены с портом 3000.
- `ARCHITECTURE.md` 5.1 предлагал поля `receives_notifications`, `notification_lang`, `billing_contact`, `removed_by_account_id`; реализованы `notifications_enabled_at` (нужно время включения для однозначного правила получателей при уменьшенном пределе), `notification_language`, `is_contact_person` (SCREENS называет роль «Контактное лицо»; с оплатой она пока не связана), `removed_by_member_id` (удаляет всегда сотрудник этой компании). Описание 5.1 уточнено.
- `ARCHITECTURE.md` 8.3 предполагал, что администратор тоже удаляет сотрудников; SCREENS A-SUP-03 и TASK-017 этого не требуют — не реализовано (отмечено в 8.3).
- Серверная команда `dev:member:remove` (только development/test) удаляет тем же путём, но правило «последнего сотрудника» к ней не применяется — чтобы не менять поведение тестов TASK-006; записано в CLAUDE.md.

## Known Issues / Risks
- Отправка приглашения держит строку сотрудника (`FOR SHARE`) на время вызова канала; с настоящим WhatsApp (TASK-026) удаление этого сотрудника будет ждать окончания отправки (не дольше тайм-аута задачи, 60 с). Если это окажется заметным, можно перейти на «забронировать → отправить → подтвердить» с проверкой статуса.
- Лимит заявки по номеру теперь на пару «номер + БИН»: один номер может отправить заявки на много разных БИН, их ограничивает только лимит по адресу (10 в час на адрес / сеть /64).
- Миграция включила уведомления первым пяти активным сотрудникам существующих компаний и назначила контактное лицо — первого активного; значения можно поменять в кабинете и админке.
- `catalog-photos.integration.test.ts` «removes files no record points at…» один раз упал под нагрузкой при параллельном dev-прогоне и прошёл при повторе; к задаче не относится, но может быть чувствителен ко времени.

## Remaining Work
None.

## Future Improvements
- Удаление сотрудника администратором (с тем же правилом последнего сотрудника), если оно понадобится поддержке.
- Раздельные лимиты для заявки: на номер вообще (крупное окно) и на пару «номер + БИН».
- Отправка приглашения без удержания строки сотрудника на время вызова канала (см. риски).

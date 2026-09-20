# CLAUDE.md

Правила работы coding-agent в этом репозитории.

**TASK определяет WHAT. Ты самостоятельно выбираешь лучший HOW на основе реального репозитория.**

Не заставляй пользователя проектировать техническое решение вместо тебя.

---

## 0. Проект

> Заполнено по утверждённой `ARCHITECTURE.md` 0.8 (PRODUCT.md 1.2), дополнено до 0.22. Команды ниже фактические — проверены выполнением (последний раз — TASK-012); детали и обоснование решений — ARCHITECTURE 4 и 4.1–4.17.

- **Название:** adclub.kz
- **Что это:** закрытая клубная платформа: участники сообщества (первая аудитория — автоклуб Geely в Казахстане) получают клубные цены у отобранных поставщиков. Каталог, заявки с кодом/QR, рейтинг, ИИ-помощник; оплата товаров и доставка — вне платформы; монетизация — подписки пользователей (через сторы) и поставщиков (карточные рекурренты). Подробности — `PRODUCT.md`, решения — `ARCHITECTURE.md`.
- **Стек:** TypeScript везде. Мобильное приложение пользователя — React Native + Expo; веб-кабинет поставщика — PWA на React + Vite; панель администратора — React + Vite SPA; сервер — Node.js + NestJS (модульный монолит, API-процесс и worker-процесс из одного кода); PostgreSQL 16 (источник истины, Drizzle ORM, SQL-миграции); Meilisearch (поисковый индекс); Redis (кэш, лимиты частоты; отзыв сессий проверяется по PostgreSQL — ARCHITECTURE 4.6 I51); S3-совместимое объектное хранилище; pg-boss (очередь и cron на PostgreSQL); контракт API — zod-схемы в `packages/contracts` → OpenAPI 3.1 и типизированный клиент. Только стандартные компоненты, без фирменных сервисов хостинг-провайдера (переносимость — ARCHITECTURE 15.1).
- **Структура репозитория:** монорепозиторий pnpm workspaces + Turborepo (ARCHITECTURE 4): `apps/api` (NestJS — HTTP-процесс `src/main.ts` и worker-процесс `src/worker.ts`), `apps/mobile` (Expo; использует `contracts`, `domain`, `i18n`, `api-client` — Metro берёт их исходники через условие экспорта `adclub-source`, ARCHITECTURE 4.4 I29), `apps/supplier-web` (React + Vite), `apps/admin-web` (React + Vite); `packages/contracts` (zod-схемы, единый формат ошибки, реестр маршрутов `apiRoutes`, генерация OpenAPI), `packages/api-client` (типизированный HTTP-клиент по `apiRoutes`, им пользуются все три клиента), `packages/domain` (чистая доменная логика — `normalizeArticle`, сравнение версий приложения, нормализация и маскирование казахстанского номера), `packages/i18n` (kk/ru/en, `pickLanguage`), `packages/ui-core` (дизайн-система без платформы: токены DESIGN.md 7 для обеих тем, режимы темы, контраст, логика компонентов, SVG бренда и AI Pilot — ими пользуются веб и мобильное), `packages/ui` (веб-дизайн-система: CSS-переменные тем, шрифт Onest, веб-компоненты; ESM), `packages/ui-showcase` (витрина веб-компонентов, только для разработки), `apps/mobile/src/design-system` (компоненты React Native на `ui-core`, ARCHITECTURE 4.10), `packages/dynamic-forms` (каркас, без функциональности), `packages/config` (общие `tsconfig`/`eslint`); `infra/docker` (compose для dev), `infra/migrations` (SQL-миграции), `design/` (бренд и макеты — источник дизайна, DESIGN.md 0.4), `scripts/brand-assets.mjs` (растровые иконки из `design/brand`). Контракт API: `apps/api/openapi.json` — генерируется, руками не правится. `PRODUCT.md`, `ARCHITECTURE.md`, `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/` — в корне репозитория, не в `docs/`. Модель данных, реальные эндпоинты и полный контракт клиент–сервер — TASK-002/003; первые доменные эндпоинты (коды входа) — `apps/api/src/modules/identity/login-code` (TASK-004); сессии и учётные записи — `apps/api/src/modules/identity/session` и `identity/account` (TASK-005, ARCHITECTURE 4.6); защищённый маршрут объявляется `@SessionRoute(apiRoutes.x)` (маршрут с `auth: "session"` и обязательными `contexts` — `user`/`supplier`/`admin` — в контракте; права решает единый предикат `decideAccess` из `@adclub/domain`, в обработчиках проверок ролей нет), текущая сессия и её контекст — `@CurrentSession()`; компании, сотрудники, администраторы и второй фактор — `identity/supplier` и `identity/admin` (TASK-006, ARCHITECTURE 4.8); серверная команда оператора — `apps/api/src/operator.ts`; настройки (продуктовые пороги, лимиты, сроки, тексты, политика клиента) — `apps/api/src/modules/settings` (TASK-007, ARCHITECTURE 4.11, 14): реестр ключей с типами и умолчаниями — `registry/registry.ts`, значения в коде читаются через `AppSettings.get(key)` (кэш не старше 30 с), в окружении порогов нет; наблюдаемость (единый санитайзер персональных данных, мониторинг ошибок, метрики) — `apps/api/src/observability`, журнал действий — `apps/api/src/modules/audit` (TASK-009, ARCHITECTURE 4.13, 15.3); структура справочника (категории двух уровней, характеристики, варианты списков, их названия kk/ru/en в таблице `translation`) — `apps/api/src/modules/catalog` (TASK-010, ARCHITECTURE 4.15): админские маршруты `/admin/catalog/…`, клиентские `/catalog/…` без сессии, пример dev-дерева — `dev-catalog-seed.ts`; позиции справочника (бренды и их написания, позиции трёх видов, значения характеристик, полнота, массовое дозаполнение, аналоги, поиск по артикулу) — там же (TASK-011, ARCHITECTURE 4.17): `catalog-brands.service.ts`, `catalog-items.service.ts`, маршруты `/admin/catalog/brands`, `/admin/catalog/items`, `/admin/catalog/categories/{id}/fill`; переводы справочника и интерфейс ИИ (TASK-012, ARCHITECTURE 4.19): `apps/api/src/modules/ai` — `AiGateway` (порт провайдера: `TestAiGateway` для dev, тестов и CI без внешних вызовов и `ClaudeAiGateway` на `@anthropic-ai/sdk`; выбор — `AI_PROVIDER`/`ANTHROPIC_API_KEY`, ключа у проекта пока нет, настоящий вызов не проверялся) и `AiService` (единственный вход для модулей: дневной предел `ai_daily_budget_usd`, запись вызова в `ai_job`, время вызова, проверка ответа по схеме; новое применение ИИ — метод порта + `AiOperation`), `apps/api/src/modules/catalog/translation-*.ts` — все записи текстов справочника идут через `TranslationQueue.writeTexts` (изменение русского текста и задача перевода — одна транзакция), `TranslationRunner` (worker: пакеты, аренда задач, проверки, сохранение под блокировкой), `catalog-names.ts` (уникальность названий среди соседей — одна функция для администратора и автоперевода), админские маршруты `/admin/translations…`; фоновые задачи (очередь pg-boss, свиперы дедлайнов, расписания) — `apps/api/src/jobs` (TASK-008, ARCHITECTURE 4.12, 13), список всех задач — `apps/api/src/background-jobs.ts`, первые задачи (очистка данных входа) — `apps/api/src/modules/identity/cleanup`: модуль объявляет задачу (`defineJob`/`definePeriodicJob`/`defineSweeperJob`), регистрирует реализацию в `JobRegistry` и ставит задачи через `JobQueue.enqueue(job, payload, { tx })` в своей транзакции; обработчики обязаны быть идемпотентными.
- **Запуск dev:** скопировать `.env.example` в `.env` в корне репозитория (без этого шага API, worker и миграции не стартуют — `DATABASE_URL`/`REDIS_URL`/`S3_*` обязательны); значения по умолчанию подходят для локального Docker Compose ниже, менять не нужно. Затем `docker compose -f infra/docker/compose.dev.yml up -d` (PostgreSQL, Redis, Meilisearch, MinIO; моков внешних сервисов пока нет — появятся с интеграциями), затем `pnpm install` и `pnpm dev` (Turborepo, `turbo run dev --concurrency=32`: все постоянные задачи `dev` сразу — сборка общих пакетов в режиме наблюдения, API и оба веб-приложения; лимит выше их числа обязателен, ARCHITECTURE 4.16 I153: `apps/api` на `:3000` с `/health`, `/ready`, `/meta/client-policy`, в dev — `/openapi.json` и Swagger UI `/docs`; `apps/admin-web` на `:5174`, `apps/supplier-web` на `:5175`); worker (он же выполняет фоновые задачи) — отдельно и отдельной командой, `pnpm --filter api worker` (dev) или после `pnpm build` — `pnpm --filter api start:worker`; несколько worker'ов можно запускать одновременно — периодическая задача всё равно выполняется один раз за запуск; мобильное — `pnpm --filter mobile start` (Expo dev server; телефон с Expo Go в той же Wi-Fi-сети сканирует QR, приложение само обращается к API на `<IP машины>:3000`, переопределение — `EXPO_PUBLIC_API_URL` в `apps/mobile/.env`; брандмауэр должен пропускать входящие на порты 8081 и 3000; на эмуляторе/симуляторе не проверялось — на машине разработки нет Android SDK и macOS). **Витрина компонентов (только dev):** веб — `http://localhost:5175/showcase` (кабинет) и `http://localhost:5174/showcase` (админка) после `pnpm dev`: все веб-компоненты в состояниях, переключатели темы («Тёмная / Светлая / Как в системе») и языка подписей (ru/kk); в production-сборку не попадает. Мобильное — в Expo Go (`pnpm --filter mobile start`) на главном экране кнопка «Витрина компонентов (dev)»: компоненты, AI Pilot во всех состояниях, вкладки с AI Pilot и без, переключатель темы; в production-бандле витрины нет. **Пересборка иконок после изменения `design/brand`:** сначала SVG — `python design/brand/build.py` и/или `python design/brand/assistant.py` (нужны fonttools и brotli, `build.py` скачивает Onest), затем `pnpm brand:assets` (иконки и заставка мобильного, favicon и apple-touch-icon веба, модуль `packages/ui-core/src/brand/brand-svg.ts`); `pnpm brand:assets --check` — проверить, что всё актуально. Значения дизайна меняются только в `packages/ui-core/src/tokens` (тест сверяет их с таблицами DESIGN.md); после изменения токенов — `pnpm --filter @adclub/ui test -u` (пересоздаёт `packages/ui/src/styles/theme.css`). **Настройки в dev** (после `pnpm --filter api migrate`; ARCHITECTURE 4.11, 14): посмотреть все — `pnpm --filter api operator settings:list` (или одну — `settings:get <key>`); изменить — `pnpm --filter api operator settings:set <key> <value> --reason "<почему>"` (значение — JSON: `10`, `true`, `'{"kk":"…","ru":"…","en":"…"}'`; не-JSON — строка, например `1.4.0`; `--expected-version <n>` — защита от одновременной правки); вернуть умолчание — `settings:reset <key> --reason "…"`; история — `settings:history <key>`. Серверная команда меняет любые настройки, включая безопасность входа (`login_code_*`, `session_*`, `sign_in_*`, `admin_totp_*`, `admin_backup_code_count` — D-053); работающие API и worker применяют изменение не позже чем через 30 с, без перезапуска. Администратор — через API в сессии админки (см. «Админка в dev» ниже): `GET /admin/settings` (группы, значения, `version`), `PUT /admin/settings/<key>` `{"value":…,"expectedVersion":<version>,"reason":"…"}`, `POST /admin/settings/<key>/reset` `{"expectedVersion":…,"reason":"…"}`, `GET /admin/settings/<key>/history`; настройки безопасности входа API не меняет (403 `SETTING_OPERATOR_ONLY`), чужая версия — 409 `SETTING_VERSION_CONFLICT`. Минимальные версии клиентов и текст обновления — настройки `client_min_version_ios|android|supplier_web|admin_web` и `client_update_message`; минимум админки не выше `ADMIN_WEB_RELEASE_VERSION` (в dev — версия `apps/admin-web/package.json`). Прежние переменные `CLIENT_MIN_VERSION_*`, `LOGIN_CODE_LENGTH` и т. п. больше не действуют (API предупреждает при старте). **Фоновые задачи в dev** (после `pnpm --filter api migrate`; ARCHITECTURE 4.12, 13): задачи выполняет worker (`pnpm --filter api worker`), API и серверная команда их только ставят. Посмотреть очередь — `pnpm --filter api operator jobs:status` (по каждой задаче: ожидают, повторяются, выполняются, упали, в мёртвой очереди, расписание и время последних запусков); мёртвая очередь — `jobs:dead` (показываются имя задачи, число попыток, ошибка и только имена полей данных — сами данные не показываются никогда), повторить — `jobs:retry <id>`, удалить — `jobs:delete <id>`. Запустить периодическую задачу сейчас, не дожидаясь расписания, — `jobs:run <имя>` (например, `jobs:run identity.cleanup-sessions`). Очистка устаревших данных входа (`identity.cleanup-login-codes`, `identity.cleanup-sign-in-steps`, `identity.cleanup-sessions`) идёт по расписанию раз в минуту (запуск — до ~35 с после начала минуты); сроки хранения — настройки `cleanup_*_retention_days` (по умолчанию 7, 1 и 30 дней), меняются как остальные настройки и действуют со следующего запуска, например `settings:set cleanup_session_retention_days 1 --reason "dev"`. Действующие коды, шаги входа и сессии не удаляются никогда. Проверить повторы и мёртвую очередь: `pnpm --filter api operator dev:jobs:fail` (только в development/test) ставит задачу `dev.always-fails` — worker трижды пробует её выполнить, затем она оказывается в `jobs:dead`. Схему очереди ставят миграции проекта, pg-boss её сам не создаёт; после обновления зависимости `pg-boss` — `pnpm --filter api jobs:schema-migration generate` и закоммитить новую миграцию (`jobs:schema-migration check` — то же проверяет и в `pnpm test`). **`dev.daily-at-setting`** (TASK-011.A, ARCHITECTURE 4.18 I171; только development/test, как `dev.always-fails`; в каталоге staging и production её нет): ежедневная задача в час настройки `billing_notify_hour` (время Алматы), которая ничего не делает, — чтобы в dev видеть, как расписание следует за настройкой, пока нет первой настоящей ежедневной задачи (оплата): `pnpm --filter api operator jobs:status` показывает у неё расписание `0 10 * * *`; `pnpm --filter api operator settings:set billing_notify_hour 7 --reason "dev"` — и не позже чем через ~15 с (проход синхронизации расписаний каждого worker'а) там же `0 7 * * *` у всех worker'ов, ни на одном проходе расписание не возвращается к прежнему часу; вернуть — `settings:reset billing_notify_hour --reason "dev"`. **Журнал действий, мониторинг и метрики в dev** (TASK-009, ARCHITECTURE 4.13): значимые действия (изменение и сброс настройки, назначение и снятие администратора, сброс второго фактора, новые резервные коды, создание компании, добавление и удаление сотрудника, с TASK-010 — любое изменение справочника: категории, характеристики, варианты, порядок, статусы) пишутся в `audit_log` в той же транзакции, что и само действие. Посмотреть журнал — в сессии админки: `GET /admin/audit-log` с фильтрами `action`, `entityType`, `entityId`, `actorAccountId`, `actorRole`, `from`, `to` и постранично (`limit`, затем `cursor` из `nextCursor`), например `curl -s 'localhost:3000/admin/audit-log?action=setting.changed&limit=5' -H "Authorization: Bearer <accessToken админки>" -H 'X-Client: admin-web/0.1.0'`; мобильная сессия и сессия кабинета получают 403 `FORBIDDEN`. Экрана в админке пока нет (TASK-034). **Метрики** — `GET /metrics` в формате Prometheus (задержки и коды ответов по маршрутам, глубина очереди и мёртвые очереди по задачам, срабатывания лимитов входа, доставка кодов по каналам, состояние зависимостей `/ready`): выключаются `METRICS_ENABLED=false`, при заданном `METRICS_TOKEN` сборщик обязан прислать `Authorization: Bearer <токен>`; вне development/test метрики включены только с `METRICS_TOKEN`, а `METRICS_ENABLED=true` без него не даёт процессу стартовать (ARCHITECTURE 4.14 I134). **Отправка ошибок в мониторинг** выключена, пока не задан `MONITORING_DSN` (Sentry-совместимый адрес, `MONITORING_ENVIRONMENT` — имя окружения): с ним 5xx и упавшие задачи уходят приёмнику уже очищенными (номера маской, тела, коды, токены и адреса не уходят вовсе), 4xx бизнес-логики не уходят никогда. Проверить локально: поднять любой приёмник на порту (например, `node -e "require('node:http').createServer((q,s)=>{q.pipe(process.stdout);s.end('{}')}).listen(9911)"`), запустить API и worker с `MONITORING_DSN=http://devkey@127.0.0.1:9911/1` и вызвать отказ задачи — `pnpm --filter api operator dev:jobs:fail` (с `--on-query --note "<имя и номер>"` задача падает на реальном SQL-запросе с этими данными в параметрах — в приёмнике и журнале их быть не должно, ARCHITECTURE 4.14 I140). Реальные учётные записи, дашборды и алерты — TASK-055. **Справочник в dev** (TASK-010, ARCHITECTURE 4.15; после `pnpm --filter api migrate`): заполнить примерным деревом по PRODUCT 7.2 (7 узлов товаров, 3 узла услуг, характеристики «Моторных масел» и «Тормозных колодок») — `pnpm --filter api operator dev:catalog:seed` (только development/test; повторный запуск ничего не создаёт, существующее по коду не трогает; в выводе — сколько создано и сколько уже было). Посмотреть как гость: `curl -s localhost:3000/catalog/categories -H "Accept-Language: kk"` (дерево на казахском; без перевода — русский текст с `isFallback: true`), описание форм и фильтров категории — `curl -s localhost:3000/catalog/categories/<id>/attributes -H "Accept-Language: ru"` (id — из дерева; скрытая, архивная и несуществующая категория — одинаковый 404). Ответы клиентам помечены `Cache-Control: public, max-age=60`: изменение администратора видно клиентам не позже чем через минуту, запросу без кэша — сразу. Администратор (сессия админки, см. «Админка в dev»): дерево со всеми состояниями — `GET /admin/catalog/categories`; создать — `POST /admin/catalog/categories {"code":"…","kind":"goods","parentId":…,"names":{"ru":"…","kk":"…","en":"…"},"icon":"disc","compatibilityRequired":true}`; изменить, перенести — `PATCH /admin/catalog/categories/<id> {"expectedVersion":<version>,…}`; скрыть/в архив/восстановить — `POST /admin/catalog/categories/<id>/status {"status":"hidden|archived|active","expectedVersion":…}`; порядок — `PUT /admin/catalog/categories/order {"parentId":…|null,"kind":…,"categoryIds":[…все соседи…]}`; характеристики — `GET|POST /admin/catalog/categories/<id>/attributes`, `PATCH /admin/catalog/attributes/<id>`, `POST …/attributes/<id>/status`, `PUT /admin/catalog/categories/<id>/attributes/order`; варианты списка — `POST /admin/catalog/attributes/<id>/options`, `PATCH /admin/catalog/attribute-options/<id>`, `POST …/attribute-options/<id>/status`, `PUT /admin/catalog/attributes/<id>/options/order`. Чужая версия — 409 `CATALOG_VERSION_CONFLICT`; каждое изменение — в `GET /admin/audit-log?entityType=catalog_category` (а также `catalog_attribute`, `catalog_attribute_option`). **Позиции справочника в dev** (TASK-011, ARCHITECTURE 4.17; после `pnpm --filter api migrate`): тот же `pnpm --filter api operator dev:catalog:seed` добавляет 4 бренда (Geely с написаниями «GEELY Auto», «Джили»; TRW; Shell; Mobil), колодки Geely `04465-0K090` и TRW `GDB3534` (пара аналогов), задние колодки Geely `4050068800`, 4 моторных масла по характеристикам (два неполных) и 3 услуги; повторный запуск ничего не создаёт. В базе, заполненной до TASK-011, «Допуск» масел не участвует в полноте — включить: `PATCH /admin/catalog/attributes/<id> {"expectedVersion":…,"isRequiredForComplete":true}`. Найти позицию по артикулу (часть или любое написание, также по названию на любом языке) — в сессии админки: `curl -s 'localhost:3000/admin/catalog/items?q=04465%200k090' -H "Authorization: Bearer <accessToken админки>" -H 'X-Client: admin-web/0.1.0'` → позиция с `article: "04465-0K090"`, `articleNorm: "044650K090"`; отборы `categoryId`, `brandId`, `type` (`part`/`generic`/`service`), `status` (`draft`/`active`/`archived`), `completeness=incomplete`, постранично `limit` и `cursor` из `nextCursor`, всего — `total`. Карточка — `GET /admin/catalog/items/<id>` (значения по активным характеристикам, пустые — `null`, `missingAttributeIds`, аналоги). Бренды — `GET|POST /admin/catalog/brands` (`{"name":"…","aliases":[…],"isOem":true}`), `PATCH …/brands/<id>`, архив — `POST …/brands/<id>/status`. Позиция — `POST /admin/catalog/items {"type":"part","categoryId":…,"brandId":…,"article":"…","names":{"ru":"…"},"values":[{"attributeId":…,"value":…}]}` (значение списка — id варианта; дубль — 409 `CATALOG_ITEM_DUPLICATE` с `details.existingItemId`); изменение — `PATCH …/items/<id> {"expectedVersion":…}`, состояние — `POST …/items/<id>/status`, значения — `PUT …/items/<id>/values {"expectedVersion":…,"values":[…]}`, аналоги — `POST …/items/<id>/analogs {"analogItemId":…}` и `DELETE …/items/<id>/analogs/<analogId>`. Дозаполнение: таблица — `GET /admin/catalog/categories/<id>/fill?emptyAttributeId=<id>`, запись — `PUT …/fill {"cells":[{"itemId":…,"attributeId":…,"previous":null,"value":…}]}` (до 500 ячеек, всё или ничего, ошибки по ячейкам — `CATALOG_VALUES_REJECTED`); ответ создания характеристики несёт `itemsWithoutValue`. Журнал — `entityType=catalog_item` и `catalog_brand`. **Товары, ставшие одинаковыми (TASK-011.A, ARCHITECTURE 4.18):** если изменение структуры (архивирование или восстановление характеристики, снятие или установка «участвует в полноте») делает два товара одной категории и бренда совпадающими по всем идентифицирующим значениям, изменение не отклоняется: ответ характеристики (`AdminAttributeResponse` любого маршрута, что ей отвечает) несёт **`sameProductItems`** — число товаров категории, совпадающих с другим (0 — совпадений нет; у ответа варианта списка поля нет), а список позиций умеет отбор **`sameProduct=matching`** (вместе с остальными отборами и постранично): `curl -s 'localhost:3000/admin/catalog/items?sameProduct=matching&categoryId=<id>' -H "Authorization: Bearer <accessToken админки>" -H 'X-Client: admin-web/0.1.0'` — только такие товары. Правка такой позиции, не меняющая идентичность (название, прочие характеристики, состояние), проходит; смена бренда или категории и запись значения идентифицирующей характеристики, после которых позиция совпала бы с другой (в том числе возврат в пару), — по-прежнему 409 `CATALOG_ITEM_DUPLICATE`. **Автоперевод и ИИ в dev** (TASK-012, ARCHITECTURE 4.19; после `pnpm --filter api migrate`): ИИ в dev, тестах и CI — тестовая реализация без внешних вызовов (без `ANTHROPIC_API_KEY`; ключа Anthropic у проекта пока нет, настоящий вызов Claude не выполнялся и в CI не делается): она «переводит» детерминированно и так, чтобы это было видно — `Тормозные колодки [kk]`, `Tormoznye kolodki [en]`. Начальный режим — `AI_TEST_MODE` в `.env` (меняется перезапуском API и worker'а): `ok` (по умолчанию), `unavailable`, `rejected`, `slow`, `empty`, `too_long`, `control_characters`, `wrong_language`. **Увидеть автоперевод:** `pnpm --filter api operator dev:catalog:seed` (часть названий — подкатегории «Чехлы» и «Аксессуары» и четыре моторных масла — оставлена только по-русски; команда ставит для них перевод и печатает `translationsQueued`), затем worker — `pnpm --filter api worker`; через несколько секунд `curl -s localhost:3000/catalog/categories -H "Accept-Language: kk"` даёт у «Чехлы» название `Чехлы [kk]` и `isFallback: false` (до перевода — русский и `isFallback: true`; клиентам изменение видно не позже минуты — `Cache-Control: public, max-age=60`); в сессии админки источник по языкам — `curl -s localhost:3000/admin/translations/category/<id> -H "Authorization: Bearer <accessToken админки>" -H 'X-Client: admin-web/0.1.0'` (`origin` `source`/`ai`/`manual`, `aiModel`, `isSourceChanged`, ждущая или отказанная задача `task`). **Что ждёт перевода:** `GET /admin/translations?entityType=&lang=&state=missing|queued|failed|outdated` (`total` и `counts` по состояниям — объём работы, постранично `limit`/`cursor`); оператору — `pnpm --filter api operator translations:status` (ждущие, взятые запуском, с временной ошибкой, отказанные с причиной), `ai:status` (провайдер, расход дня против `ai_daily_budget_usd`, вызовы дня по видам и статусам, последние неудачные; сами записи вызовов — таблица `ai_job`: модель, статус, токены, стоимость, без текстов), `translations:queue-missing` (поставить перевод везде, где нет ни текста, ни задачи — то, что было до автоперевода или очищено; сам не делается), `translations:run` (запустить проход сейчас), `translations:retry-failed` (вернуть в очередь отказанное насовсем). **Правка и повтор** (сессия админки): `PUT /admin/translations/<type>/<id>/<field>/<kk|en> {"text":"…"}` — ручной текст (автоперевод его не затирает; когда русский текст меняется, у него `isSourceChanged: true`; тот же запрос подтверждает текст, который администратор посмотрел и оставил); `POST …/<kk|en>/retranslate` — «Перевести заново» (для автоматического, отсутствующего и отказанного; для ручного — 409 `TRANSLATION_MANUALLY_EDITED`); `POST …/<kk|en>/release` — снять ручную правку (текст остаётся видимым, язык ставится в очередь); `<type>` — `category`, `attribute`, `attribute_option`, `catalog_item`; `<field>` — `name` (у характеристики ещё `unit`). Русский текст меняется, как раньше, самой сущностью (например `PATCH /admin/catalog/categories/<id>`). Бренды не переводятся (имена собственные, они не в `translation`). **Провайдер недоступен:** `AI_TEST_MODE=unavailable` и перезапуск worker'а — изменения справочника сохраняются, задачи ждут; запуск повторяется (`translation_retry_limit` раз с паузой `translation_retry_delay_seconds`, вдвое дольше каждый раз), затем попадает в мёртвую очередь — `pnpm --filter api operator jobs:dead --job catalog.translate`; вернуть `ok`, перезапустить worker и `jobs:retry <id>` (или любое изменение справочника, или `translations:run`) — переводы выполняются; отказ `rejected` уходит в мёртвую очередь сразу. **Дневной предел:** `pnpm --filter api operator settings:set ai_daily_budget_usd 0 --reason "dev"` — новые пакеты не уходят (в логе worker'а `AI daily budget exhausted…`, `ai:status` — `exhausted: true`, задачи ждут, мёртвых нет); вернуть значение и `translations:run` — ждущее уходит (иначе его подберёт страховочная `catalog.translation-wake` — раз в 5 минут, для задач, ждущих больше двух минут). Перевод, не прошедший проверки (пустой, длиннее поля, с управляющими символами, не на том языке, совпавший с названием соседа), не сохраняется: язык остаётся без текста, задача `failed` с причиной (`translations:status`, `GET /admin/translations?state=failed`), автоматически не повторяется. Настройки — группа «Переводы справочника»: `translation_batch_size` (20), `translation_retry_limit` (3), `translation_retry_delay_seconds` (60); метрики — `adclub_ai_spend_today_usd`, `adclub_ai_daily_budget_usd`, `adclub_ai_calls_today`, `adclub_translation_tasks`. **Коды входа в dev:** каналы WhatsApp и SMS тестовые, ничего не отправляют; отправленные коды видны в браузере на `http://localhost:3000/dev/login-codes` (последние 20, только при `NODE_ENV` development/test или `LOGIN_CODE_DEV_OUTBOX=true`; production с тестовыми каналами или этим адресом не стартует). Ошибку доставки канала имитирует `LOGIN_CODE_TEST_FAILING_CHANNELS=whatsapp` (или `whatsapp,sms`), адрес клиента за прокси — `TRUST_PROXY` (оба в `.env.example`, меняются перезапуском API; ARCHITECTURE 4.5); пороги и лимиты кодов — настройки `login_code_*` (см. «Настройки в dev»). **Сессия и защищённый маршрут в dev** (после `pnpm --filter api migrate`): (1) `curl -X POST localhost:3000/auth/login-code -H "Content-Type: application/json" -d '{"phone":"+77011234567"}'`; (2) код — на `http://localhost:3000/dev/login-codes`; (3) `curl -X POST localhost:3000/auth/login-code/verify -H "Content-Type: application/json" -H "X-Client: mobile/0.1.0 (ios)" -d '{"phone":"+77011234567","code":"<код>"}'` — в ответе `session.accessToken` и `session.refreshToken` (вид сессии задаёт `X-Client`; `supplier-web`/`admin-web` получают 403 `SESSION_KIND_UNAVAILABLE` до TASK-006); (4) `curl localhost:3000/auth/me -H "Authorization: Bearer <accessToken>"`; обновление — `POST /auth/session/refresh` с `{"refreshToken":"…"}`, устройства — `GET /auth/sessions`, выход — `POST /auth/logout`; то же — в Swagger UI `/docs` (кнопка Authorize). Сроки, пороги и лимиты — настройки `session_*`, секрет токенов — `SESSION_TOKEN_SECRET` (обязателен вне development/test), браузерные origin веб-клиентов (CORS и cookie-сессии) — `SUPPLIER_WEB_ORIGINS`/`ADMIN_WEB_ORIGINS` (в dev по умолчанию порты 5175/5174); запрос с чужим `Origin` получает 403 `ORIGIN_NOT_ALLOWED`. **Кабинет поставщика в dev** (TASK-006; компании и сотрудники без админки — серверной командой, только в development/test): `pnpm --filter api operator dev:supplier:create --name "Автомаркет" --city "Алматы"` → `supplierId`; `pnpm --filter api operator dev:member:add <supplierId> +77011234567 --name "Айгерим"` (учётная запись номера создаётся); удалить — `dev:member:remove <memberId>` (сессии кабинета этого сотрудника завершаются сразу). Вход — как выше, но с `-H "X-Client: supplier-web/0.1.0"` и `-c steps.txt` (шаг входа завершает только тот же клиент — его cookie `adclub_sign_in_<id шага>`, ARCHITECTURE 4.9 I80): одна компания — сразу сессия (refresh-токен только в cookie `adclub_supplier_refresh`, в ответе `access` с компанией); несколько — 403 `SUPPLIER_SELECTION_REQUIRED` с `details.signInStep.token` и списком компаний, затем `curl -X POST localhost:3000/auth/sign-in/supplier -b steps.txt -H "Content-Type: application/json" -d '{"signInStep":"<token>","supplierId":"<id>"}'` (без `-b steps.txt` — 401 `SIGN_IN_STEP_INVALID`) (без нового кода; шаг одноразовый, 10 минут); запомненная компания — `"supplierId"` в теле `verify`; смена — `POST /auth/supplier-context {"supplierId":…}`, список — `GET /auth/suppliers`, текущая — `GET /supplier/company`. Номер без членства получает 403 `NOT_SUPPLIER_MEMBER` после проверки кода. **Админка в dev:** `pnpm --filter api operator admin:grant +77011234567` (снять — `admin:revoke`, сбросить TOTP — `admin:reset-totp`; после сборки — `node apps/api/dist/operator.js …`); вход с `-H "X-Client: admin-web/0.1.0"` и `-c steps.txt` (все запросы шагов ниже — с `-b steps.txt`) → 403 `TOTP_SETUP_REQUIRED` (первый вход) или `TOTP_REQUIRED` с `details.signInStep.token`; настройка: `POST /auth/sign-in/totp/setup {"signInStep":…}` → `otpauthUri` (содержимое QR) и `secret` для приложения-аутентификатора, затем `POST /auth/sign-in/totp/setup/confirm {"signInStep":…,"totpCode":"<6 цифр из приложения>"}` → сессия админки (cookie `adclub_admin_refresh`) и 10 резервных кодов (показываются один раз); следующие входы — `POST /auth/sign-in/totp {"signInStep":…,"totpCode":…}` или `{"signInStep":…,"backupCode":"xxxx-xxxx"}`; админские маршруты — `GET /admin/administrators`, `POST /admin/administrators/<id>/totp-reset`, `POST /admin/totp/backup-codes {"totpCode":…}`. Ключ шифрования секретов TOTP — `ADMIN_TOTP_ENCRYPTION_KEY` (обязателен вне development/test); сроки шагов, допуск часов, число резервных кодов и лимиты — настройки `sign_in_*`, `admin_totp_*`, `admin_backup_code_count`. Для многократных входов одного номера подряд в dev интервал повторной отправки кода (60 с) и лимит кодов на номер меняются серверной командой без перезапуска: `pnpm --filter api operator settings:set login_code_resend_interval_seconds 5 --reason "dev"`, `settings:set login_code_requests_per_phone 100 --reason "dev"`.
- **Тесты:** `pnpm test` — unit и e2e-на-supertest (Vitest), одной командой для всего репозитория через Turborepo; покрывает `packages/domain`, `packages/contracts`, `packages/i18n`, `packages/api-client`, `packages/ui-core` (токены против DESIGN.md, контраст, темы, логика компонентов, синхронность SVG бренда), `packages/ui` (веб-компоненты в jsdom, `theme.css`, шрифты), `apps/api`, `apps/mobile` (только чистая логика и файлы — шрифты, `app.json`; без React Native). `pnpm test:integration` — интеграционные на реальных PostgreSQL и Redis (Testcontainers, нужен Docker): цикл миграций, коды входа по HTTP (лимиты, резерв, падение Redis, журнал), сессии по HTTP (выдача, ротация и повторное использование, устройства, cookie-сессии, CORS, падение Redis и PostgreSQL, журнал без токенов), роли и контексты по HTTP (матрица «вид сессии × контекст», вход в кабинет с выбором и сменой компании, TOTP и резервные коды, конкурентные попытки, лимиты и падение Redis, сброс и снятие, серверная команда, мгновенная потеря прав); весь вывод каждого интеграционного файла перехватывается `src/testing/output-capture.ts` и проверяется на отсутствие зарегистрированных тестами токенов, секретов и кодов и настройки по HTTP и серверной командой (изменение, сброс, история, конфликт версий, запрет правки безопасности входа через API, действие во втором процессе без перезапуска, политика клиента и устаревшая вкладка админки, испорченные значения, отказ PostgreSQL), сверка ORM-схемы с базой после миграций (долг T-5: новая таблица добавляется в `apps/api/src/orm-tables.ts`, иначе проверка падает), фоновые задачи (схема очереди из миграций и её версия, постановка в транзакции — откат и фиксация, повторы и мёртвая очередь с повтором и удалением оператором, singleton и расписание при двух worker'ах, свипер — пакеты, падение одной строки, параллельный запуск, бюджет времени, расписание во времени Алматы из настройки и догон пропущенного, остановка worker во время задачи и брошенная задача, недоступность PostgreSQL при работе и при старте) очистка данных входа по HTTP и серверной командой (что удаляется и что не удаляется, сроки из настроек, пакеты, журнал без номеров), что покидает процесс (реальный вход с номером, кодом, токенами и телами, затем отказ в обработчике: в тестовом приёмнике мониторинга нет ни одного персонального поля; 4xx не отправляются; сбой санитайзера не отправляет ничего; медленный и остановленный приёмник не задерживает запросы; при выключённой отправке поведение прежнее; состав метрик и доступ к ним по токену; журнал доступа без строки запроса) структура справочника (два уровня и тип характеристики на сервере и в самой базе, категории, характеристики и варианты администратором, уникальность названий, версии и одновременная правка, журнал, клиентское дерево и описание фильтров гостем и любой сессией с откатом на русский, 404 для скрытого, кэширование, матрица доступа, заполнение dev-базы), позиции справочника (бренды и написания, три вида позиций, уникальность артикула в базе и одновременное создание, идентичность товара по характеристикам, значения по типам, полнота против независимого подсчёта после каждого теста, дозаполнение всё-или-ничего с конфликтом по ячейке, аналоги, поиск и постраничный вывод, журнал, матрица доступа, dev-заполнение и сценарии TASK-011) и переводы справочника (очередь: изменение текста и задача — одна транзакция и откат без следов, ручной текст не затирается и помечается «исходник изменился», ручная правка, снятие правки и «перевести заново», список ждущего с состояниями и страницами, доступ; worker с тестовым ИИ: все виды текстов, запись вызова без содержимого и с расходом, ссылка перевода на вызов, пакеты по настройке, замена автоперевода, негодный перевод не сохраняется и не повторяется, совпадение с соседом, недоступный провайдер — повторы, мёртвая очередь и завершение после восстановления, отказ и медленный ответ, исчерпанный дневной предел между пакетами, изменение текста и ручная правка во время вызова, задача исчезнувшего текста, два worker'а без повторных переводов, страховочная задача, метрики; юнит-тесты — проверки перевода, тестовая и Claude-реализации на подменённом HTTP, прайс, конфигурация ИИ) и журнал действий (запись в транзакции действия и её отсутствие при откате, запрет изменения и удаления, действия администратора и серверной команды, фильтры и постраничный вывод, отказ мобильной сессии и сессии кабинета, ограничение размера `before`/`after`). Тесты задают пороги только через настройки (`src/testing/settings.ts`, ARCHITECTURE 4.11 I110), не переменными окружения. Контракт: `pnpm --filter @adclub/api openapi:generate` (перегенерировать `apps/api/openapi.json` после изменения схем/маршрутов и закоммитить), `openapi:check` (файл актуален и совпадает с маршрутами сервера), `openapi:compat --base <ревизия>` (нет ломающих изменений относительно базы, нужен Docker; осознанный breaking change — трейлер коммита `Contract-Breaking-Change: <причина>`, ARCHITECTURE 4.4 I28). E2E (Playwright/Maestro), набор качества ИИ — скриптов ещё нет.
- **Lint / typecheck / build:** `pnpm format` / `pnpm format:check` (Prettier), `pnpm lint` (ESLint 10 + typescript-eslint, общая конфигурация `packages/config/eslint`; запрещает импорт внутренностей чужого пакета в обход его `package.json.exports` — ARCHITECTURE 4.1 I4; правило про прямые вызовы SDK мониторинга появится вместе с модулем `observability`), `pnpm typecheck` (tsc по workspace, конфиги — `packages/config/typescript`), `pnpm build` (Turborepo; собирает пакеты, `apps/api`, веб-приложения и JS-бандл мобильного для iOS и Android — `expo export` в `apps/mobile/dist`; нативная сборка мобильного — EAS Build, позже).
- **Миграции:** node-pg-migrate, SQL-миграции в `infra/migrations`: `pnpm --filter api migrate` (применить), `migrate:down` (откатить последнюю), `migrate:status`, `migrate:create <name>` (ARCHITECTURE 4.2 I10). Схема очереди задач (`pgboss`) — тоже миграция проекта, но генерируется: `pnpm --filter api jobs:schema-migration generate` после обновления пакета `pg-boss` (ARCHITECTURE 4.12 I112); руками её не правят.
- **Внешние сервисы:** Meta WhatsApp Cloud API (коды входа, уведомления поставщикам с кнопками, резерв для пользователей); SMS-агрегатор РК (Mobizon или SMSC.kz — резерв кодов); FCM/APNs (push); App Store и Google Play (подписки пользователей, серверные уведомления сторов; RevenueCat допустим как агрегатор); Freedom Pay или CloudPayments KZ (рекурренты поставщиков, выбор по условиям); Anthropic Claude (`claude-opus-5` — сопоставление прайсов, совместимость, помощник; `claude-sonnet-5` — распознавание колонок, техпаспорт, приборная панель, фото деталей, перевод; `claude-haiku-4-5` — классификация); распознавание речи — Gemini Transcribe или ElevenLabs Scribe (казахский, смешанная речь); SerpAPI (поиск фото деталей с источником); хостинг — Servercore, ЦОД Алматы (PostgreSQL, S3, VM); мониторинг — зарубежные SaaS (Sentry и метрики) только с маскированием персональных данных в приложении. Все провайдеры — за внутренними интерфейсами (`AiGateway`, `SpeechProvider`, `PaymentProvider`, `SubscriptionProvider`, `ImageSearchProvider`, `SmsProvider`). Секреты — только в `.env` (в git не попадает) и `.env.example`.

---

## 1. Документы проекта

| Файл | Что содержит | Кто ведёт |
|---|---|---|
| `PRODUCT.md` | Что продукт должен делать и как себя вести | Product Owner |
| `ARCHITECTURE.md` | Принятые технические решения | **Ты** |
| `PROJECT_PLAN.md` | EPIC → TASK со статусами | Product Owner |
| `PROJECT_STATE.md` | Что фактически реализовано, DECISIONS, BACKLOG | Product Owner |
| `SCREENS.md` | Экраны, потоки, состояния и критичные тексты приложения, кабинета и админки; экранные TASK ссылаются на идентификаторы экранов | Product Owner |
| `DESIGN.md` | Бренд и дизайн-система (появится по итогам DES-2, DES-3) | Product Owner |
| `tasks/TASK-XXX.md` | Текущая и прошлые задачи | Product Owner |
| `tasks/TASK-XXX-REPORT.md` | Отчёты по задачам | **Ты** |

Правила:

- Ты редактируешь только `ARCHITECTURE.md` и свои отчёты. `PRODUCT.md`, `PROJECT_PLAN.md`, `PROJECT_STATE.md` и файлы задач не изменяй — если нашёл в них ошибку или расхождение с кодом, напиши об этом в отчёте.
- Значимые технические решения фиксируй в `ARCHITECTURE.md`, а не только в памяти сессии: следующая сессия и Product Owner видят файл, а не память.
- Не создавай README, документацию, сводки и вспомогательные `.md`, если это не требует TASK.

## 2. Одна TASK за раз

В работе всегда одна актуальная задача из `tasks/`. Закончил — остановись и отчитайся. Не начинай следующую TASK и не реализуй её части заранее, даже если они очевидны.

---

## 3. Приоритеты

1. системные и safety-инструкции;
2. явная текущая TASK;
3. более специфичные инструкции репозитория (`AGENTS.md`, `.claude/rules/`, локальные `CLAUDE.md`);
4. `PRODUCT.md` и принятые продуктовые решения;
5. существующая архитектура, контракты и код;
6. `PROJECT_PLAN.md`;
7. эти правила.

Если TASK противоречит `PRODUCT.md` или принятой архитектуре — не решай конфликт молча. Сделай безопасный минимум и вынеси противоречие в `Deviations`.

## 4. Честность

Не выдумывай: выполненные действия, результаты тестов, доступы, API, версии, состояние окружения, содержимое непроверенных файлов.

Отчёт читает человек, у которого нет доступа к твоей сессии. Всё, что нельзя подтвердить, называй неподтверждённым.

## 5. Язык

Общение и отчёты — на языке пользователя (русский). Код, идентификаторы, комментарии, сообщения коммитов — английский.

---

## 6. Рабочий цикл

Для каждой TASK: **Inspect → Plan → Implement → Verify → Review → Report.**

### Inspect

Перед изменениями:

1. Определи корень репозитория и рабочую область.
2. Прочитай релевантные инструкции репозитория, `PRODUCT.md`, `ARCHITECTURE.md`, `PROJECT_PLAN.md`, манифесты и конфигурацию.
3. Проверь текущий `git status` и `git diff`.
4. Изучи связанные с TASK модули, модели данных, API, UI, тесты, утилиты и существующие patterns.
5. Найди то, что можно переиспользовать вместо написания нового.
6. Сверь требования TASK с фактическим состоянием проекта.

Не предполагай стек, архитектуру или библиотеку — проверь.

Не задавай вопрос, если можешь безопасно принять инженерное решение сам. Спрашивай только если: отсутствует обязательный доступ или секрет; действие необратимо; без ответа невозможно выбрать между существенно разными **продуктово** значимыми вариантами.

### Plan

Для нетривиальной TASK определи затронутые области, зависимости, риски, данные и контракты, необходимые тесты, возможные регрессии. План должен быть достаточным для работы, а не отдельным проектом.

### Implement

Вноси **минимальное целостное production-quality изменение**, достаточное для Acceptance Criteria.

Сохраняй, если TASK не требует обратного: существующую архитектуру, публичные API, контракты, conventions, обратную совместимость, работающий функционал.

Не делай: реализацию будущих TASK, unrelated features, широкий рефакторинг без необходимости, параллельную архитектуру, переусложнение.

Не оставляй требуемую функциональность как TODO, placeholder или fake implementation.

Полезное улучшение вне scope — в `Future Improvements`, без реализации.

Используй зрелые возможности проекта прежде, чем добавлять зависимость.

### Verify → Review → Report

Если в Verify найден дефект, вызванный твоими изменениями: исправь → повтори проверку → только потом завершай TASK.

Перед отчётом просмотри итоговый diff целиком.

---

## 7. Инженерная планка

Применяй общепринятые практики по стеку. Отдельно, потому что здесь чаще всего ошибаются:

- Критичные бизнес-правила, права доступа и валидация проверяются на сервере, а не только в UI.
- Ownership и авторизация проверяются на каждом ресурсе, а не подразумеваются по факту наличия сессии.
- Изменения данных: думай о существующих записях, constraints, транзакциях, обратной совместимости и откате миграции.
- Destructive data changes — только при явной необходимости и разрешении.
- UI: помимо happy path предусматривай loading, empty, ошибку валидации, ошибку сервера, disabled/pending.
- Новая функциональность = новая поверхность атаки. Проверяй IDOR, privilege escalation, утечку данных, injection, XSS, загрузку файлов, верификацию вебхуков.
- Не ослабляй валидацию и защиту ради прохождения проверки.

## 8. Секреты и окружение

Читай `.env`, `.env.*` и secret stores только когда это действительно нужно.

Никогда не выводи секреты в терминал без необходимости, в отчёт, diff, документацию, память или коммит. Не сохраняй в git ключи, токены, пароли, cookies, приватные ключи и полные connection strings.

При добавлении конфигурации обновляй `.env.example` или аналог, если он используется проектом.

Если доступа нет — назови точный недостающий ресурс, не обходи ограничения среды.

---

## 9. Проверки

Подбирай проверки по стеку и риску. По применимости: formatter, lint, typecheck, валидация схем и конфигов, unit / component / integration / contract тесты, миграции, build, production-like запуск, health checks, E2E и smoke в браузере, security-аудит.

Для UI и пользовательских потоков, если среда позволяет, реально пройди критичные сценарии, а не только тесты.

Проверяй существенные edge cases, а не только happy path.

Статусы: `PASS` / `FAIL` / `NOT RUN` / `BLOCKED`. Не заявляй `PASS`, если проверка не запускалась.

Запрещено делать тесты зелёными через: удаление или skip корректного теста, ослабление assertion, отключение валидации или security, подавление реальной ошибки, необоснованный `any`, отключение lint или typecheck.

## 10. Acceptance Criteria и доказательства

Перед завершением проверь каждый обязательный AC отдельно:

- `AC-1 — PASS — evidence`
- `AC-2 — FAIL — reason`

**Evidence — это проверяемый факт, а не утверждение.** Путь к файлу, команда и её результат, фрагмент вывода теста, описание реально пройденного сценария с полученным результатом. Формулировки вида «реализовано» или «работает корректно» доказательством не считаются.

`COMPLETED` возможен, только если выполнены все обязательные AC. Иначе `PARTIAL` или `BLOCKED` с точной причиной и списком оставшейся работы.

Лучше честный `PARTIAL — 8/9 AC`, чем ложный `COMPLETED`.

---

## 11. Scope и необратимые действия

Не переписывай продуктовые требования ради удобства реализации и не меняй значимое продуктовое поведение молча.

Коммить логическими шагами, с осмысленными сообщениями. push в main после зелёных проверок

**Состав коммитов (D-024):**

- В коммит попадают только явно перечисленные файлы: `git add <путь> <путь> …`. Запрещены `git commit -a`, `git add -A`, `git add .` и любые другие способы добавить «всё сразу».
- Перед каждым коммитом проверяй состав: `git status` и `git diff --cached --stat` — в индексе ровно то, что относится к этому коммиту.
- Правки Product Owner в документах проекта (`PRODUCT.md`, `PROJECT_PLAN.md`, `PROJECT_STATE.md`, `tasks/` и другие документы, которые ведёт Product Owner), найденные в рабочем дереве, коммить отдельным коммитом с понятным сообщением (например, `Update project plan and state (Product Owner edits)`) в `main` и перечисляй этот коммит в отчёте.
- Эти правки не смешиваются с коммитами задачи и никогда не попадают во временные или экспериментальные ветки.

Без явного разрешения не делай, если это не следует однозначно из TASK: удаление реальных данных, необратимые production-миграции, deploy, публикацию, отправку реальных сообщений внешним получателям, любые внешние необратимые действия.

## 12. Definition of Done

- требования и обязательные AC выполнены;
- реализация согласуется с существующей архитектурой;
- существенные ошибки и edge cases обработаны;
- релевантные проверки выполнены, вызванные изменениями падения исправлены;
- секреты не раскрыты;
- итоговый diff просмотрен, лишних изменений и незакрытых required TODO нет;
- значимые технические решения внесены в `ARCHITECTURE.md`;
- известные ограничения честно отражены в отчёте.

---

## 13. Отчёт

Сохраняй отчёт в `tasks/TASK-XXX-REPORT.md` и дублируй в ответе.

Разделы, по которым нечего сказать, не выдумывай — пиши `None` или опусти.

```
# TASK REPORT — TASK-XXX

## Status
COMPLETED / PARTIAL / BLOCKED

## Result
Что теперь фактически умеет система.

## Changes
Ключевые файлы и модули, суть изменений.

## Technical Decisions
Только значимые решения и причины. Указать, что внесено в ARCHITECTURE.md.

## Verification
- команда/проверка — PASS/FAIL/NOT RUN/BLOCKED — краткий результат

## UAT / E2E
Какие пользовательские сценарии реально пройдены, в каком окружении, с каким результатом.
Если не запускались — так и указать.

## Acceptance Criteria
Каждый AC отдельно с evidence.

## Errors & Fixes
Существенные проблемы, причины, исправления.

## Deviations
Отклонения от TASK и противоречия между TASK, PRODUCT.md и кодом.

## Known Issues / Risks
Ограничения, миграции, ручные действия, риски.

## Remaining Work
None, либо точный список.

## Future Improvements
Полезные идеи вне текущего scope.
```

## 14. Главное правило

Оптимизируй работу под **реально работающий и проверенный продукт**, а не под красивый отчёт.

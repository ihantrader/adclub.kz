# TASK REPORT — TASK-055

## Status
PARTIAL — часть A выполнена целиком (AC-1…AC-8, AC-10 — локально; задача CI `images` и деплой из CI проверятся первым прогоном после push), часть B — BLOCKED: нет VM, DNS, бакетов S3 и доступа SSH (AC-9 и «живые» половины AC-1, AC-6, AC-7). Перечень того, что нужно выдать, — в конце отчёта.

## Result
Проект разворачивается из репозитория одной командой:
- три образа (`api` — API, worker, серверная команда и шаг выпуска; `supplier-web`/`admin-web` — статика в Caddy со своим CSP; `ops` — резервные копии, проверка восстановления, sops + age); задача CI `images` публикует их в GHCR с тегами `sha-<7>` и `main`;
- стек staging `infra/docker/compose.staging.yml`: PostgreSQL 16, Redis (AOF, пароль), Meilisearch, api, worker, кабинет, админка, прокси Caddy (Let's Encrypt, HTTP→HTTPS, HSTS, CSP с хешем скрипта темы, сжатие, `/dev/*`, `/docs`, `/openapi.json` закрыты), `ops`; ротация логов, UTC;
- `deploy.sh`: образы по SHA → версия админки из метки образа → расшифровка секретов → данные → **миграции одноразовым контейнером нового образа до замены api/worker** → замена → `/ready`, `/health`, `/meta/client-policy`, кабинет и админка через прокси; откат `--rollback`;
- `.github/workflows/deploy-staging.yml`: после зелёного CI на push в `main` — по SSH на VM, `concurrency` без отмены, ручной запуск с SHA = откат; пока секретов SSH нет — notice, не красный прогон;
- секреты staging — `infra/secrets/staging.env.sops` (sops + age, получатели в `.sops.yaml`: ключ Product Owner и ключ CI); `secrets-init.mjs` генерирует и шифрует, ничего не печатая; API не стартует вне development/test с dev-значением любого секрета;
- ежедневный `pg_dump` (в одном снимке с числами строк) и копия бакета файлов в бакет резервных копий с хранением 14 дней; еженедельная проверка восстановления во временном контейнере PostgreSQL; итоги — `ops_run` и метрики `adclub_ops_*`;
- `TRUST_PROXY` — один доверенный hop по адресу прокси, с интеграционным тестом подделки заголовка;
- вход на staging — номера тестировщиков (до 10, до 31 дня, вне production; приложение, кабинет, админка — у админки ещё TOTP);
- `bootstrap-vm.sh`, `infra/MIGRATION.md`, таблица лимитов по IP при CGNAT с предложением умолчаний.

Первая же проверка восстановления нашла настоящий дефект: **дамп базы не восстанавливался** (`search_key` вызывал `search_text` без схемы, а `pg_restore` работает с пустым `search_path`). Исправлено миграцией `1792000000000_search-key-restorable.sql`.

## Changes
- **Образы:** `infra/docker/api.Dockerfile`, `web.Dockerfile` (+ `web/Caddyfile`, `web/csp.mjs`), `ops.Dockerfile` (+ `ops/lib.sh`, `db-backup.sh`, `files-backup.sh`, `restore-check.sh`, `idle.sh`), `.dockerignore`.
- **Стек:** `infra/docker/compose.staging.yml`, `staging.env` (адреса, без секретов), `proxy/Caddyfile`, `proxy/docs/{terms,privacy}.html` (заглушки «Страница готовится»); репетиция — `compose.staging.local.yml`, `rehearsal.env`.
- **Скрипты:** `infra/scripts/deploy.sh`, `compose.sh`, `backup.sh`, `restore-check.sh`, `bootstrap-vm.sh`, `secrets-init.mjs`, `rehearsal.sh`, `smoke-path.mjs`.
- **Секреты:** `.sops.yaml`, `infra/secrets/staging.env.sops`; закрытый ключ CI — секрет GitHub `SOPS_AGE_KEY` (задан 09.11.2026), ключ Product Owner — строка `SOPS_AGE_KEY_STAGING_OWNER` в `.env` (добавлена в конец, остальное в `.env` не тронуто).
- **CI:** `.github/workflows/ci.yml` — задача `images`; новый `.github/workflows/deploy-staging.yml`.
- **API:** `src/release.ts` (шаг выпуска: проверка схемы pg-boss, `up`, «ничего не осталось»), `src/healthcheck.ts`, `database/migrate-cli.ts` (`ADCLUB_MIGRATIONS_DIR`), `config/env.schema.ts` (`DEVELOPMENT_SECRET_VALUES`), `modules/operations/` (`ops_run`, `OpsRunMetrics`), `observability/metrics.service.ts`, `app.module.ts`, `orm-tables.ts`; служебный вход — `identity/login-code/review-login.ts` (область `tester`, `opens`), `login-code.service.ts`, `login-code.store.ts`, `identity/schema.ts`, `session/sign-in.service.ts`, `operator.ts` (`--tester`, `--phone`); `node-pg-migrate` — в `dependencies`.
- **Миграции:** `1791900000000_ops-runs.sql`, `1791950000000_staging-testers.sql`, `1792000000000_search-key-restorable.sql`; списки `testing/expected/migrations.ts`, `orm-tables.ts`, `schema-drift.test.ts`.
- **Тесты:** `config/env.schema.test.ts` (запрет dev-значений), `rate-limit/trust-proxy.integration.test.ts` (новый, вес в `integration-weights.json`), `identity/login-code/review-login.test.ts` (новый), `session.integration.test.ts` (номера тестировщиков), `database.integration.test.ts` (откат трёх миграций; помощник `rollBackThrough` вместо счёта `down` после промежуточного `up`).
- **Документы:** `ARCHITECTURE.md` 4.82 (I900–I915), правки 4.5 I36, 15.1, 15.3, 15.4, 15.5, версия 0.93; `CLAUDE.md` блок 0 — «Staging и деплой в dev»; `.env.example`; `infra/MIGRATION.md`; `.gitignore` (`.dev-staging/`).

## Technical Decisions
Все записаны в ARCHITECTURE 4.82:
- I900 образы: веб — статика в своём Caddy-образе (CSP едет со сборкой), образ веба принадлежит одному окружению (`adclub-<app>-staging`), версия админки — метка образа;
- I902 прокси — Caddy (TLS и продление без certbot и cron), brotli нет в стандартном Caddy — zstd/gzip; журнал доступа прокси выключен (токены в строке запроса);
- I903 `/docs`, `/openapi.json` — закрыты 404, не basic auth; документы клуба — `/docs/…` на домене кабинета из каталога на VM;
- I904 `TRUST_PROXY` — адрес прокси, а не число хопов;
- I905 миграции — `release.js` в одноразовом контейнере нового образа;
- I906–I908 секреты, запрет dev-значений, ротация;
- I909 резервные копии; **WAL-архив отложен** до managed PostgreSQL/prod (staging — тестовые данные, RPO сутки);
- I910 деплой и откат, bootstrap VM (`deploy` в группе `docker` = root на VM, отдельного sudo нет);
- I911 номера тестировщиков;
- I912 данные staging: через админку и импорт, **дамп dev-данных не переносится**;
- I913 таблица лимитов по IP; I914 что staging не проверяет; I915 репетиция.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS (1 предупреждение в `modules/ratings/supplier-ratings.service.ts` — старое, не из этой задачи)
- `pnpm typecheck` — PASS (20/20)
- `pnpm test` — PASS после исправления списка таблиц в `schema-drift.test.ts` (первый прогон: 1 падение — новая таблица `ops_run`); api — 70 файлов, 989 тестов
- `pnpm build` — PASS (12/12)
- `pnpm --filter @adclub/api openapi:check` — PASS («matches the contract and the served routes»)
- `pnpm --filter @adclub/api openapi:compat --snapshots` — PASS («Compatible with every supported app version: 1.0.0»; контракт не менялся)
- Интеграционные тесты изменённых модулей (Docker, Testcontainers):
  - `database/database.integration.test.ts` — PASS 61/61 (первый прогон — FAIL 51: счёт `down` после промежуточного `up` сбился из-за трёх новых миграций; исправлено помощником `rollBackThrough`)
  - `database/schema-drift.integration.test.ts` — PASS
  - `rate-limit/trust-proxy.integration.test.ts` — PASS 3/3
  - `modules/identity/session/session.integration.test.ts -t "store review"` — PASS 7/7 (в том числе 2 новых про тестировщиков)
  - `observability/observability.integration.test.ts`, `modules/search-index/search-index.integration.test.ts` — PASS
  - `modules/showcase/catalog-search.integration.test.ts` (затронут `search_key`) — PASS 18/18
- `bash -n` всех скриптов — PASS; shellcheck 0.10 (`-S warning`) — PASS после пометки `SC2034` в `ops/lib.sh`; actionlint 1.7.7 (`ci.yml`, `deploy-staging.yml`) — PASS
- Задача CI `images` и `deploy-staging` — NOT RUN локально (запустятся после push); идентификатор прогона — ниже.

### Сборка образов (`bash infra/scripts/rehearsal.sh build final`, 2 мин 58 с)
```
adclub-api:final 560MB
adclub-ops:final 223MB
adclub-admin-web:final 86.2MB
adclub-supplier-web:final 86MB
adclub-api user=node health=["CMD","node","dist/healthcheck.js"] revision=cc35788… version=0.1.0 layers=20
adclub-ops user=ops revision=cc35788… layers=4
adclub-supplier-web user=65534:65534 health=["CMD","wget","-q","--spider","http://127.0.0.1:8080/"] version=0.1.0
adclub-admin-web user=65534:65534 health=[…] version=0.1.0
csp: 1 inline script(s) hashed, connect-src https://localhost:8443   (кабинет)
csp: 0 inline script(s) hashed, connect-src https://localhost:8443   (админка)
```
Содержимое образа `api` (`docker run --entrypoint sh adclub-api:local`): `uid=1000(node)`; в `/repo/apps/api` — только `dist`, `node_modules`, `package.json`; файлов `*.ts` (кроме `*.d.ts`) вне `node_modules` нет; `.env*` нет; production-зависимости — 185 МБ (`node-pg-migrate`, `sharp`, AWS SDK, Nest…), dev-зависимостей (vitest, tsx, testcontainers, typescript) нет. Без окружения процесс отказывается стартовать с перечнем недостающих переменных.

### Репетиция стека (`bash infra/scripts/rehearsal.sh deploy final`)
```
deploy: admin panel 0.1.0
deploy: secrets decrypted (14 variables)
deploy: data services
deploy: migrations (one-off container of adclub-api:final)
release: pg-boss schema version 42 matches the migrations
release: 54 migrations applied, 0 pending
deploy: replacing api, worker, web clients, proxy, ops
deploy: /ready: 200
deploy: /health: 200
deploy: /meta/client-policy (admin-web/0.1.0): 200
deploy: cabinet: 200
deploy: admin panel: 200
deploy: release 49d0b09 is live (admin panel 0.1.0)
```

## UAT / E2E
Окружение — стек staging из образов на машине разработки (Docker Desktop, Windows), прокси с локальным CA Caddy: API `https://localhost:8443`, кабинет `:8444`, админка `:8445`, MinIO вместо S3.

1. **Путь «вход сотрудником → заявка → выдача по коду» против контейнеров** (`NODE_TLS_REJECT_UNAUTHORIZED=0 node infra/scripts/smoke-path.mjs`, все запросы через прокси, кабинет — cookie-сессией с его Origin, приложение — токенами):
   ```
   smoke: employee signed in to the cabinet (refresh cookie: set)
   smoke: offer on sale: 12500 ₸, visible to users: true
   smoke: user placed order № 1002 (created), the code is shown to the user
   smoke: employee accepted it: accepted
   smoke: given out by the code: given_out
   smoke: the user sees: completed
   ```
   (первый прогон — заявка № 1001, тот же итог). Вход — номерами тестировщиков с постоянным кодом.
2. **Кабинет и админка по HTTPS в настоящем Chrome** (headless Chrome по DevTools Protocol, сертификат репетиции принят только для этого запуска; встроенная панель браузера сайт с непроверенным CA не открывает — доверять CA Caddy в системе я не стал): обе страницы рендерятся («Вход в кабинет поставщика», «Вход в админку»), шрифт Onest загружен (`document.fonts.check('16px Onest') = true`), service worker кабинета зарегистрирован, сохранённая тёмная тема применяется встроенным скриптом (`data-theme="dark"`); нарушений CSP для скриптов нет, кроме `script-src eval` — это проверка zod 4 через `new Function` в try/catch (работает без JIT, см. Known Issues). Вход сотрудником через интерфейс кабинета (номер → код тестировщика) открыл кабинет «Автомаркета» (меню «Заявки, Предложения, Сканер, Прайс…»; снимок экрана — в сессии).
3. **Заголовки прокси** (`curl -k -I`):
   ```
   http://localhost:8080/ready → 308 https://localhost:8443/ready
   https://localhost:8443/ready: 200; Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; Strict-Transport-Security: max-age=0 (в репетиции; staging — 31536000); X-Content-Type-Options: nosniff; X-Frame-Options: DENY; Referrer-Policy: strict-origin-when-cross-origin; Cross-Origin-Opener-Policy: same-origin; без Server и X-Powered-By
   https://localhost:8444/: Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-XOlf0M/+MkcR7o9YwzI58Tk63c1n6VjHFPiGwVIZk5U='; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob: https:; connect-src 'self' https://localhost:8443; manifest-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
                         Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()
   /dev/login-codes, /dev/messages, /dev/pushes, /dev/payment/card, /docs, /docs/, /openapi.json, //dev/login-codes, /./dev/login-codes, /dev/login-codes/, /%64ev/login-codes, /openapi.json?x=1 → 404
   мимо прокси (из сети стека): /dev/* → 404 (не смонтированы в staging), /docs и /openapi.json → 200 (их закрывает прокси)
   gzip: JS кабинета 2 005 451 → 489 480 байт; админки 2 364 785 → 591 744
   ```
4. **`TRUST_PROXY` в стеке:** запрос через прокси с `X-Forwarded-For: 203.0.113.77` посчитан по настоящему адресу соединения (`rl:login-code:requests:ip:172.31.250.128` — адрес, с которого Docker Desktop доставляет соединения в Caddy; поддельного ключа нет).
5. **Документы клуба:** `https://localhost:8444/docs/privacy.html` → «Политика конфиденциальности · Страница готовится.»
6. **dev-заполнение в `staging`:** `dev:catalog:seed`, `dev:vehicles:seed`, `dev:compatibility:seed`, `dev:suppliers:seed`, `dev:catalog:arrange`, `dev:supplier:create` в контейнере `api` — все отказывают («…for development and tests only»). Для данных репетиции (только локально) заполнение запускалось с `-e NODE_ENV=development`.

Часть B (телефон Android с `preview-apk` против staging, вход администратора с TOTP на staging) — не выполнялась: сервера нет.

## Acceptance Criteria
- **AC-1 — образы — PASS локально / CI — после push.** Сборка всех четырёх образов — вывод выше; `api` не root (`User=node`), `HEALTHCHECK` `dist/healthcheck.js`, нет исходников, dev-зависимостей и `.env` (проверено в контейнере). Задача CI `images` добавлена (`.github/workflows/ci.yml`), actionlint чистый; публикация в GHCR и ссылка на пакеты — первым прогоном на push (идентификатор ниже; результат не дожидался — правило TASK-076).
- **AC-2 — стек локально — PASS.** `deploy.sh` поднял стек с самоподписанным TLS, `/ready` 200 через прокси; кабинет и админка открываются по HTTPS (Chrome); путь «вход сотрудником → заявка → выдача по коду» — п. 1 UAT.
- **AC-3 — прокси — PASS.** HTTP→HTTPS 308, HSTS, CSP без `unsafe-inline` для скриптов (хеш скрипта темы), тема и шрифты работают; `/dev/*`, `/docs`, `/openapi.json` — 404 (решение «закрыть, не basic auth» — I903); `TRUST_PROXY` — `trust-proxy.integration.test.ts` 3/3 и проверка подделки в стеке.
- **AC-4 — миграции до деплоя — PASS** (локально). Образ с намеренно сломанной миграцией: `release: FAILED … null value in column "note" … violates not-null constraint` → `deploy: the migration failed: api and worker keep running the previous release`, `deploy.sh exit=1`; после этого `api` — прежний образ, запущен в то же время (`adclub-api:local started 18:25:05`), `/ready` через прокси 200. С исправленной миграцией: `### MIGRATION 1791999999999_rehearsal-check (UP) ###` … `release: 54 migrations applied, 0 pending` → новые контейнеры, `/ready` 200, в базе `rehearsal_check.note = fixed`. Откат одной командой: `rehearsal.sh rollback` → `deploy: rolling back to d24af81…` → прежний образ, все проверки 200. (Временная миграция репетиции в репозиторий не попала и удалена из базы репетиции.)
- **AC-5 — секреты — PASS.** Расшифровка `staging.env.sops`: ключ Product Owner — 17 переменных, ключ CI — 17, посторонний ключ (репетиции) — `exit=1`, 0. `secrets-init.mjs` выводит только открытые ключи, имена файлов и число переменных. Тест `env.schema.test.ts` («refuses every secret set to a value public in this repository…», «…development password in the database and Redis addresses») — PASS; в сообщении — имя переменной, значения нет. Секретов в git нет: в коммитах этой задачи `staging.env.sops` — только `ENC[…]`, `.dev-staging/` и `.env` git-ignored (поиск по `git log -p` — после коммита, ниже).
- **AC-6 — резервные копии — PASS на MinIO** (часть A). `rehearsal.sh backup`: `db-backup: 614013 bytes; counts {"account":2,"supplier":1,…,"pgmigrations":54}`; `files-backup: {"count":1,"bytes":10}`, удалённый объект — в `files/removed/2026-11-09/…`. `rehearsal.sh restore-check`: `12 tables compared, 0 mismatches` → `release: 54 migrations applied, 0 pending` → `recorded ok=true`. Метрики: `adclub_ops_last_run_ok{kind="db_backup|files_backup|restore_check"} 1`, без токена `/metrics` → 401. `infra/MIGRATION.md` — пять шагов с командами. На бакете провайдера — часть B.
- **AC-7 — деплой из CI — PARTIAL.** `deploy-staging.yml` (после зелёного CI, SSH, `concurrency`, падение при сбое, ручной запуск с SHA для отката) — написан, actionlint чистый; `deploy.sh` прогнан локально против локального стека (вывод выше, сбой и откат — AC-4). Прогона по SSH нет — часть B.
- **AC-8 — лимиты и CGNAT — PASS.** Таблица — ниже и в ARCHITECTURE 4.82 I913; умолчания в коде не менялись.
- **AC-9 — staging живой — BLOCKED** (часть B, см. перечень).
- **AC-10 — документация и проверки — PASS** (ARCHITECTURE 4.82 и правки, CLAUDE.md, `.env.example`, `infra/MIGRATION.md`, списки `expected/migrations.ts` и `orm-tables.ts`; локальные проверки зелёные). Push в `main` — идентификатор прогона ниже.

### Таблица лимитов по адресу — на решение Product Owner
За одним IPv4 мобильного оператора (Kcell, Beeline, Tele2/Altel: сотни–тысячи абонентов на адрес) или за Wi-Fi встречи клуба окажется вся группа 50–100 человек, особенно в первый час после приглашения. Вошедшие в каталоге считаются по учётной записи; остальное — по адресу.

| Настройка | Сейчас | Сработает на группе 50–100 за одним адресом? | Предложение |
|---|---|---|---|
| `login_code_requests_per_ip` | 30 / ч | Да — 50–100 входов за час | **200 / ч** (защита — 5 кодов и 15 проверок на номер в час) |
| `login_code_sms_per_ip_daily` | 10 / сут | На грани — SMS только при отказе WhatsApp, 5–15 % из 100 | **30 / сут** |
| `session_refresh_per_ip` | 600 / ч | Вероятно — ~4 обмена/ч на активное приложение + веб ≈ 400–800 | **3000 / ч** (на сессию остаются 30/ч приложения, 300/ч веба) |
| `catalog_read_per_ip` (гости) | 300 / мин | Да, если 20–30 гостей листают одновременно | **1000 / мин** |
| `compatibility_check_per_ip` | 120 / мин | Возможно — по адресу для всех | **600 / мин** |
| `vehicle_document_per_ip` (гости) | 30 / сут | Да — первый запуск требует автомобиль, каждый новый человек распознаёт техпаспорт | **200 / сут** (расход держат 3 попытки на устройство и `guest_ai_daily_budget_usd`) |
| `supplier_lead_per_ip` | 10 / ч | Нет | без изменений (на выставке — поднять настройкой) |
| `whatsapp_webhook_per_ip`, `payment_webhook_per_ip` | 600 / мин | Нет — адреса провайдеров | без изменений |
| `admin_totp_verify_per_ip` | 20 / 15 мин | Нет | без изменений |

На staging значения ставятся `settings:set`; после запуска группы — смотреть `adclub_login_code_rate_limit_hits_total` и ответы 429 в метриках.

## Errors & Fixes
- **Дамп базы не восстанавливался** (найдено первой проверкой восстановления): `pg_restore` с пустым `search_path` не находил `search_text` внутри `search_key` → миграция `1792000000000_search-key-restorable.sql` (`public.search_text`), тест отката с `SET search_path = ''`.
- Фиксированный адрес прокси занимал другой контейнер («Address already in use») → `ip_range` в верхней половине подсети.
- `compose up --wait` отказывал worker'у без healthcheck → проверка `kill -0 1`.
- Git Bash переписывал `/ops/…` в `C:/Program Files/Git/ops/…` для `docker exec` → `MSYS2_ARG_CONV_EXCL` в `rehearsal.sh`; Node на Windows не читал `/c/…` в `version()` — проверка версии в `web.Dockerfile` поймала пустую версию, исправлено относительным путём.
- `database.integration.test.ts` считал число `down` после промежуточного `up` → помощник `rollBackThrough(<миграция>)`, счёт больше не растёт с каждой задачей.
- Сервер отдавал `X-Powered-By: Express` через прокси → убран на прокси.
- **Независимое ревью до коммита (ARCHITECTURE 4.82 I916)** нашло и исправлено:
  1. установка в образах `--offline` упала бы в CI со второй сборки (кэш-маунт не входит в кэш GHA) → `--prefer-offline`;
  2. `--rollback` после сбоя на шагах 6–7 вёл на выпуск раньше нужного → файл `attempted`; проверено: с незавершённой попыткой откат вернул `current` (e85e41b), без неё — `previous` (49d0b09);
  3. удалённые файлы стирались бы в тот же день (перенос сохраняет время оригинала) → срок по дате папки; проверено: папка `removed/2026-10-01` удалена, сегодняшняя оставлена (`removed days expired: 1`);
  4. скрипты хоста без бита исполнения не запустились бы из таймеров → коммит с `+x` и вызовы через `bash`, `TimeoutStartSec=2h`;
  5. ручной откат без токена реестра → локальные образы;
  6. недокачанный дамп становился «последним» → `.dump.partial` до успеха, проверка берёт только дамп с `.counts.json`; проверено: подложенные `…235959Z.dump` без чисел и `.dump.partial` пропущены, восстановлен настоящий, `0 mismatches`; ожидание временного PostgreSQL — 2 минуты;
  7. IPv6-клиенты делили бы один лимит (сеть Docker без IPv6) → на staging только A-записи (`staging.env`);
  8. SHA ручного запуска деплоя проверяется до команды на VM;
  9. пароли в аргументах процессов → `PGPASSWORD` в `ops`, пароль Redis — в файле конфигурации (`/tmp/redis.conf`, `-rw------- redis`; в `cmdline` процесса — `redis-server *:6379`);
  10. `.dev-staging` — в `.dockerignore`.
  После исправлений: сборка образов `final2`, деплой, сквозной путь (заявка № 1003, `given_out`, `completed`), резервная копия и проверка восстановления — снова зелёные; shellcheck и actionlint — чистые.

## Deviations
- **Провайдер:** во время работы Product Owner сменил хостинг на ps.kz (коммиты `dd7a951`, `cc35788`; Servercore — запасной). Конфигурация от провайдера не зависит; упоминания в `staging.env` и документах — ps.kz.
- **Вход на staging — расширение служебного входа TASK-077** (область `tester`): требование 2 задачи («отдельный список тестовых номеров с постоянными кодами, не больше 10, срок — месяц») выполнено изменением сервера с миграцией, а не только настройкой; в production область `tester` не включается и не открывает ничего.
- **WAL-архив** контейнерного PostgreSQL отложен с обоснованием (I909) — задача это допускала.
- **Проверка восстановления** запускает временный контейнер с хоста (systemd-таймер), а не из контейнера `ops`: у `ops` нет и не должно быть сокета Docker.
- **«sudo только на нужное»:** у `deploy` нет sudo, но он в группе `docker`, что на VM равносильно root — без этого деплой невозможен; записано в I910.
- **`.env`:** правило задачи «.env не менять» и указание «закрытые ключи только в .env» — ключ Product Owner добавлен новой строкой в конец `.env`, существующие строки не тронуты.
- **Браузерная проверка интерфейса** — headless Chrome по CDP, а не встроенная панель (она не открывает сайт с собственным CA Caddy).

## Known Issues / Risks
- **Привязку карты в кабинете на staging не пройти:** страница тестовой платёжной системы — `/dev/payment/card`, а `/dev/*` закрыт; меняется с эквайером (TASK-042).
- CSP фиксирует `script-src eval` — zod 4 пробует `new Function` (в try/catch, работает без JIT). Без последствий; `z.config({ jitless: true })` в веб-клиентах убрал бы шум (BACKLOG).
- Значения секретов живут в конфигурации запущенных контейнеров (`/var/lib/docker`, root и группа `docker`) — иначе контейнер не пережил бы перезапуск Docker.
- Дампы в бакете не шифруются (бакет приватный, в РК); шифрование age-ключом проверки восстановления — BACKLOG.
- Размер бандлов: JS кабинета 2,0 МБ (gzip 489 КБ), админки 2,4 МБ (gzip 592 КБ) — оптимизация вне задачи.
- В `staging.env` `S3_ENDPOINT` — заглушка `https://s3.example.invalid`, `S3_REGION` — `us-east-1`: настоящие значения придут с бакетами ps.kz.
- Пока секретов SSH в GitHub нет, `deploy-staging` проходит с notice и ничего не деплоит.
- Миграция `staging-testers` откатом выключает строки тестировщиков (их коды перестают работать) — намеренно.

## Commits and CI
- `e2fb17b` — TASK-055: release step, testers' numbers, refusal of dev secrets, backup runs
- `5f7072d` — TASK-055: staging stack — images, compose, Caddy, secrets, backups, deploy
- Push в `main`; прогон CI **42685734018** (CI, `5f7072d`, на момент отчёта — `queued`; результат не дожидался — TASK-076). В нём впервые выполняется задача `images` (публикация в GHCR); после зелёного прогона запустится `deploy-staging` и, пока секретов SSH нет, завершится с notice «Staging is not configured yet».
- gitleaks 8.24.3 по обоим коммитам — «no leaks found»; `staging.env.sops` в коммите — только `ENC[…]`.

## Remaining Work (часть B — нужно от Product Owner)
1. **ps.kz:** VM staging (Ubuntu 24.04 LTS, 2 vCPU, 8 ГБ, 80 ГБ), публичный IPv4, вход по SSH для первичной настройки; два бакета S3 (`adclub-staging-files`, `adclub-staging-backups` — или другие имена, правка `staging.env`), ключ доступа S3, адрес S3 API и регион; есть ли версионирование бакетов по S3 API.
2. **DNS `adclub.kz`:** A-записи `api.staging`, `cabinet.staging`, `admin.staging` → IPv4 VM (или другие имена — правка `staging.env`); почтовый ящик для Let's Encrypt (`ACME_EMAIL`, сейчас `ops@adclub.kz`).
3. **Ключ OpenRouter для staging** (отдельный, с маленьким бюджетом); по желанию — DSN мониторинга и внешний пингер `/health`.
4. **Секреты GitHub** (агент задаст сам при доступе): `STAGING_SSH_HOST`, `STAGING_SSH_USER` (`deploy`), `STAGING_SSH_KEY`, `STAGING_SSH_KNOWN_HOSTS`; `SOPS_AGE_KEY` уже задан. Если пакеты GHCR приватные — ничего не нужно (деплой входит токеном прогона).
5. **Ключ age Product Owner** — перенести `SOPS_AGE_KEY_STAGING_OWNER` из `.env` в менеджер паролей.
6. Номера телефонов администраторов и тестировщиков для staging (до 10).

После выдачи: `bootstrap-vm.sh`, ключи S3 и OpenRouter в `staging.env.sops` (`sops edit`), секреты SSH → первый деплой, Let's Encrypt, `admin:grant`, номера тестировщиков, настройки (лимиты по таблице, «Документы и поддержка», маленький `ai_daily_budget_usd`), резервная копия и проверка восстановления на настоящем бакете, `eas env:create --environment preview|development --name EXPO_PUBLIC_API_URL --value https://api.staging.adclub.kz`, пересборка `preview-apk`, проход на телефоне Android.

## Future Improvements
- `z.config({ jitless: true })` в веб-клиентах (убрать `script-src eval` из отчётов CSP).
- Шифрование дампов (age), WAL-архив с prod-задачей.
- Перенос `smoke-path.mjs` в шаг после деплоя (с номерами тестировщиков) — когда staging появится.
- Сделать APNs необязательным при `PUSH_PROVIDER=live` (долг TASK-056) — пригодится для push на staging только с Android.

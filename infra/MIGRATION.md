# Переезд к другому провайдеру в РК

Регламент из ARCHITECTURE 15.1 (решение D1, D-010) с командами TASK-055 (ARCHITECTURE 4.82). Цель — переезд за дни, не недели: в стеке только стандартные компоненты (Docker Compose, PostgreSQL 16, Redis, Meilisearch, S3 API, Caddy), ничего фирменного у провайдера. Прогон регламента на staging — раз в квартал.

Обозначения: «старый» — текущий провайдер, «новый» — тот, к которому переезжаем. Команды на VM выполняются пользователем `deploy` из `/opt/adclub`; `compose.sh` — `releases/$(cat current)/infra/scripts/compose.sh`.

## Что нужно у нового провайдера

- VM: Ubuntu 24.04 LTS, 2 vCPU, 8 ГБ, 80 ГБ (staging; prod — по 15.1), публичный IPv4, доступ по SSH ключом.
- Два бакета S3 (файлы и резервные копии) и ключ доступа к ним; адрес S3 API и регион.
- Всё в ЦОД на территории РК (8.5).

## Шаг 1. Поднять VM и стек из `infra/`

1. Первичная настройка VM (один раз, root):

   ```bash
   sudo bash bootstrap-vm.sh "<открытый SSH-ключ деплоя CI>"
   ```

   Скрипт — `infra/scripts/bootstrap-vm.sh` (скопировать на VM из репозитория).

2. Новые адреса S3 — в `infra/docker/staging.env` (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `BACKUP_S3_BUCKET`), ключи S3 — в секретах:

   ```bash
   SOPS_AGE_KEY=<ключ Product Owner> sops edit infra/secrets/staging.env.sops
   ```

   (sops и age — в образе `ops`: `docker run --rm -it -e SOPS_AGE_KEY -v "$PWD:/w" -w /w --entrypoint sops ghcr.io/ihantrader/adclub-ops:main edit infra/secrets/staging.env.sops`.) Закоммитить.

3. Секреты GitHub деплоя: `STAGING_SSH_HOST`, `STAGING_SSH_USER` (`deploy`), `STAGING_SSH_KEY`, `STAGING_SSH_KNOWN_HOSTS` (`ssh-keyscan <адрес>`). Запустить workflow «Deploy staging» с SHA текущего выпуска — стек поднимется на новой VM с пустой базой и проверит `/ready` (на этом шаге DNS ещё смотрит на старую VM: проверка через прокси пройдёт после шага 4, поэтому первый деплой можно выполнить и вручную на VM с `ADCLUB_CURL_INSECURE=1` и адресами в `/etc/hosts`).

## Шаг 2. Перенести объекты хранилища (S3 → S3)

На любой машине с доступом к обоим хранилищам (или в контейнере `ops`):

```bash
export RCLONE_CONFIG_OLD_TYPE=s3 RCLONE_CONFIG_OLD_PROVIDER=Other RCLONE_CONFIG_OLD_ENDPOINT=<старый S3> \
       RCLONE_CONFIG_OLD_ACCESS_KEY_ID=<…> RCLONE_CONFIG_OLD_SECRET_ACCESS_KEY=<…>
export RCLONE_CONFIG_NEW_TYPE=s3 RCLONE_CONFIG_NEW_PROVIDER=Other RCLONE_CONFIG_NEW_ENDPOINT=<новый S3> \
       RCLONE_CONFIG_NEW_ACCESS_KEY_ID=<…> RCLONE_CONFIG_NEW_SECRET_ACCESS_KEY=<…>
rclone sync old:<бакет файлов> new:<бакет файлов> --checksum --progress
rclone sync old:<бакет резервных копий> new:<бакет резервных копий> --checksum
```

Первый проход — заранее, пока работает старый стек; второй — в окне шага 3 (досылает новое).

## Шаг 3. Финальная синхронизация базы (окно простоя)

1. На старой VM остановить запись: `compose.sh stop api worker` (прокси отвечает 502 — это и есть окно).
2. Свежий дамп и проверка, что он восстанавливается:

   ```bash
   infra/scripts/backup.sh db
   infra/scripts/restore-check.sh
   ```

3. Второй проход `rclone sync` шага 2.
4. На новой VM восстановить последний дамп в базу стека (база пустая, после шага 1 в ней только миграции — пересоздать):

   ```bash
   compose.sh stop api worker
   compose.sh exec -T postgres psql -U adclub -d postgres -c "DROP DATABASE adclub" -c "CREATE DATABASE adclub OWNER adclub"
   compose.sh exec -T ops sh -c 'source /ops/lib.sh; f=$(rclone lsf -R --files-only --include "*.dump" "$BACKUPS/db" | sort | tail -n 1); rclone cat "$BACKUPS/db/$f" | pg_restore --no-owner --no-privileges --exit-on-error --dbname="$DATABASE_URL"'
   ```

5. Миграции и запуск — повторный деплой того же SHA (workflow «Deploy staging» или `deploy.sh --sha <sha>`): `release.js migrate` подтвердит, что всё применено, `api` и `worker` стартуют.

Для prod с managed PostgreSQL вместо дампа — логическая репликация (`CREATE PUBLICATION` на старом, `CREATE SUBSCRIPTION` на новом) и переключение с окном в минуты; это решение prod-задачи.

## Шаг 4. Переключить DNS

A-записи `api.`, `cabinet.`, `admin.staging.adclub.kz` — на адрес новой VM (TTL заранее уменьшить до 300 с). Caddy получит сертификаты Let's Encrypt при первом обращении по новым именам. Проверка:

```bash
curl -sI https://api.staging.adclub.kz/ready
curl -s -o /dev/null -w '%{http_code}\n' https://cabinet.staging.adclub.kz/
```

## Шаг 5. Перестроить Meilisearch из базы

Индекс не копируется — он строится из PostgreSQL:

```bash
compose.sh exec api node dist/operator.js search:reindex
compose.sh exec api node dist/operator.js search:status
```

## После переезда

- Пройти путь «сотрудник → заявка → выдача по коду» (`infra/scripts/smoke-path.mjs` с номерами тестировщиков).
- Убедиться, что таймеры работают: `systemctl list-timers 'adclub-*'`; метрики `adclub_ops_last_run_ok{kind=…}` — 1 после первой ночи.
- Старую VM и бакеты удалить не раньше, чем пройдёт первая еженедельная проверка восстановления на новой.

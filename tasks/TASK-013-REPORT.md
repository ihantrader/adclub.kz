# TASK REPORT — TASK-013

## Status

COMPLETED

## Result

У позиции справочника есть фотографии, и это первая загрузка файлов в проекте.

- **Администратор загружает картинку** телом запроса (`POST /admin/catalog/items/{itemId}/photos`, `Content-Type: image/jpeg|image/png|image/webp`). Что это за файл, решает содержимое: первые байты называют формат, декодер подтверждает, что файл читается целиком. Векторные форматы не принимаются никогда (SVG — документ со скриптами), текстовый файл с именем `photo.jpg` отклоняется, как и обрезанный, пустой и слишком большой — каждый со своим понятным кодом, а не 500.
- **Хранится перекодированная картинка в трёх размерах** (`original`, `card` ≤ 1024 px, `thumb` ≤ 320 px). Перезапись снимает всё, что пришло с файлом: координаты съёмки, модель камеры, комментарии. Одна и та же картинка у одной позиции хранится один раз (SHA-256 сохранённого оригинала + частичный уникальный индекс в базе); у двух разных позиций это две независимые фотографии.
- **Источник известен всегда**: ссылка (`manufacturer`, `official_catalog`, `multi_store` — без адреса страницы такая загрузка отклоняется) или пометка «снято поставщиком» / «загружено администратором».
- **Публикует только человек**: `proposed` → `approved` / `rejected` (обязательно с причиной) / `deleted`. Клиентам отдаются только подтверждённые. Каждое решение — одна транзакция с записью в журнал действий; одновременные решения двух администраторов разводит `expectedVersion` (409).
- **Основная фотография и порядок**: основной может быть только подтверждённая фотография этой позиции (держит составной внешний ключ + сервис); отклонение или удаление основной передаёт роль следующей подтверждённой, последней — оставляет позицию без фото (клиент показывает заглушку). `PUT …/photos/order` задаёт порядок и основную одним запросом.
- **Выдача**: в списке и карточке позиции есть `photo` — подписанные ссылки на `thumb` и `card`; полноразмерный файл в списки не попадает никогда (он доступен только на экране модерации). Ссылка подписывается на один ключ и живёт `photo_link_ttl_minutes`; истёкшая заменяется новой при следующем запросе. Настройка `photo_display_mode`: `copy` — наша копия, `link` — адрес источника.
- **Удаление отложенное**: файлы отклонённой или удалённой фотографии живут `photo_removed_retention_days` (ошибочное удаление в пределах срока отменяется возвратом статуса), затем их убирает фоновая задача; вторая задача убирает файлы, на которые нет записей (прерванная загрузка). Обе идемпотентны.
- **Отказ хранилища**: загрузка отвечает 503 `SERVICE_UNAVAILABLE` с `retryable: true`, а дерево категорий, список и карточка позиции продолжают отвечать 200 — подпись ссылки не требует обращения к хранилищу.
- **Маршруты загрузки исключены из проверки «тело только JSON»** по признаку самого контракта; для остальных маршрутов (включая другие методы того же пути) 415 остаётся в силе.

Поиска изображений ИИ здесь нет (EPIC-17) — модель под него готова: `proposed_by`, `ai_score`, `ai_job_id`, `source_evidence`.

## Changes

**Контракт (`packages/contracts`)**

- `src/catalog-photos.ts` (новый): виды источника, статусы, режим показа, размеры-варианты, `ItemPhotoImage` (что видит клиент), `AdminItemPhoto` (что видит модератор), тело и строка запроса загрузки, смены статуса и порядка, `CatalogPhotoInvalidDetails`, константы (1024/320 px, принимаемые типы, 50 МБ потолка, 50 млн пикселей).
- `src/routes.ts`: у описания маршрута появилось поле `upload` (типы тела, предельный размер) — маршрут берёт либо JSON-тело, либо файл, но не оба; `ApiRouteRequestBody` для такого маршрута — байты; `isUploadRoute`/`uploadRoutePaths`; четыре новых маршрута фотографий.
- `src/openapi.ts`: тело-файл описывается как `format: binary` по пункту на каждый принимаемый тип; новые схемы в `components`.
- `src/catalog-items.ts`: `AdminCatalogItem.photo`, `AdminCatalogItemCard.photos`. `src/error.ts`: `CATALOG_PHOTO_INVALID`, `CATALOG_PHOTO_NOT_APPROVED`, `CATALOG_PHOTO_FILES_DELETED`. `src/audit.ts`: три действия и сущность `catalog_item_photo`.

**Клиент (`packages/api-client`)**: маршрут-загрузка принимает `Uint8Array`, `ArrayBuffer` или `Blob`, берёт тип из `Blob.type` или из `contentType` и отказывается отправить тип, которого маршрут не принимает.

**Сервер (`apps/api`)**

- `src/modules/catalog/photo-image.ts` — чистая проверка и подготовка картинки (определение формата по байтам, декодирование, очистка метаданных, три размера, контрольная сумма); `photo-storage.ts` — ключи `catalog-photos/<itemId>/<photoId>/<variant>.<ext>`, подписанные ссылки, удаление, перечисление; `catalog-photos.service.ts` — загрузка, модерация, порядок, выдача; `catalog-photos.controller.ts` — четыре маршрута; `photo-jobs.ts` + `photo-cleanup.ts` — свипер `catalog.delete-photo-files` и часовая `catalog.cleanup-photo-files`.
- `src/common/http/upload-routes.ts`, `upload-body.middleware.ts` — какие запросы несут файл (по контракту) и чтение тела байтами с остановкой по пределу; `json-body.middleware.ts` пропускает ровно эти запросы.
- Встроено в существующее: `catalog-items.service.ts` (фото в списке и карточке), `schema.ts` (`item_photo`, `item_photo_file`, `catalog_item.primary_photo_id`), `catalog.module.ts`, `translation-runner.ts` (регистрация задач в worker), `background-jobs.ts`, `operator.ts` (`StorageModule`), реестр настроек (четыре настройки группы «Фото»).
- `infra/migrations/1790050000000_create-item-photos.sql` — таблицы, ограничения (у отклонённой обязательна причина; у найденной в интернете обязателен адрес источника; `removed_at` согласован со статусом), индексы, составной внешний ключ основной фотографии; миграция обратима.

**Инфраструктура**: `infra/docker/compose.dev.yml` — одноразовый `minio-init`, создающий бакет.

**Документы**: ARCHITECTURE.md 0.25 (новый раздел 4.22, уточнены 5.2, 14, 15.2), CLAUDE.md блок 0.

## Technical Decisions

Значимые решения внесены в **ARCHITECTURE.md, раздел 4.22 (I199–I205)**; ниже — суть и причина.

1. **Файл идёт телом запроса, а не multipart и не presigned URL** (I199). Multipart потребовал бы парсера ради одного поля, а всё, что не байты, помещается в строку запроса и проверяется обычной zod-схемой. Это же закрывает замечание приёмки TASK-009.A: маршруты загрузки исключены из «тело только JSON». Прежняя запись 15.2 («загрузка по presigned URL») уточнена: так грузит администратор, presigned остаётся для крупных файлов пользователя и прайсов.
2. **Три размера готовятся при загрузке, а не по запросу** (I199). Преобразование на лету — это сервис, который надо держать доступным, кэшировать и защищать от перебора размеров; размеров три и они известны заранее.
3. **Перекодирование вместо вырезания метаданных** (I199). Одна операция и очищает файл, и доказывает, что это картинка; заодно применяется ориентация из EXIF.
4. **Контрольная сумма — от сохранённого оригинала, а не от присланных байтов** (I200). Два снимка одного файла с разными EXIF — это одна картинка, и она не заводится дважды.
5. **Порядок и основная фотография — один маршрут** (I201): первая в списке и есть основная. Отдельная «сделать основной» не нужна.
6. **Удаление файлов отложено, уборка — отдельная задача** (I203). Ошибочное удаление отменяется в пределах срока; файлы прерванной загрузки — другой случай (записи о них нет вообще), и порог по времени не даёт принять за мусор загрузку, идущую прямо сейчас.
7. **Исключение из проверки тела выводится из контракта** (I204), а не из списка путей в коде: добавление маршрута-загрузки не требует править второе место, а для остальных маршрутов проверка остаётся.
8. **Подпись ссылки — арифметика, а не запрос к хранилищу** (I202, I205): поэтому чтение справочника не зависит от доступности хранилища.
9. **Новая зависимость `sharp`** — в проекте не было обработки изображений, а требуются декодирование, размеры и уменьшенные варианты; бинарники под все платформы есть в lock-файле.

## Verification

| Проверка | Статус | Результат |
|---|---|---|
| `pnpm format:check` | PASS | All matched files use Prettier code style |
| `pnpm lint` | PASS | 12 задач успешно |
| `pnpm typecheck` | PASS | 18 задач успешно |
| `pnpm test` | PASS | 15 задач; `apps/api` 413 тестов (из них 14 новых — `photo-image.test.ts`), `@adclub/contracts` 84, `@adclub/api-client` 27, остальные пакеты без изменений |
| `pnpm test:integration` (`--maxWorkers=3`) | PASS | 14 файлов, **313 тестов**, из них 31 новый (`catalog-photos.integration.test.ts`) |
| `pnpm build` | PASS | 11 задач успешно |
| `pnpm --filter @adclub/api openapi:check` | PASS | `openapi.json` совпадает с контрактом и обслуживаемыми маршрутами |
| `pnpm --filter @adclub/api openapi:compat --base HEAD` | PASS | «No breaking changes to report» — изменение аддитивно, трейлер не нужен |
| `pnpm --filter api migrate` → `migrate:down` → `migrate` | PASS | миграция применяется, откатывается и применяется снова; откат проверен и тестом (см. AC-12) |
| CI на `main` | PASS | run **35530341048**, коммит `4718f0c` — **success с первой попытки** (`gh run view 35530341048`) |
| CI коммита с отчётом | — | номер и статус дописаны отдельным коммитом, как в TASK-053.A |

**Важно о локальном прогоне интеграционных тестов.** На машине разработки (12 ядер, Docker Desktop под Windows) `pnpm test:integration` с параллелизмом по умолчанию падает случайными `ECONNRESET` в разных файлах: 14 файлов поднимают свои контейнеры почти одновременно. С `--maxWorkers=3` (столько же параллельных файлов, сколько на 4-ядерном раннере GitHub) прогон зелёный целиком. Это ограничение локальной среды, а не продукта; конфигурация тестов не менялась.

## UAT / E2E

Все сценарии раздела «Что должно реально работать» пройдены вручную в dev: PostgreSQL, Redis и MinIO из `compose.dev.yml`, API (`pnpm --filter api dev`) и worker (`pnpm --filter api worker`), сессия администратора через настоящий вход с TOTP, позиция из `dev:catalog:seed` (колодки Geely `04465-0K090`).

1. **Загрузка → кандидат → подтверждение → основная.** `POST …/photos` с `--data-binary @pads-red.jpg` → **201**, статус `proposed`, `photo: null` у позиции. Подтверждение → `isPrimary: true`; в карточке позиции `item.photo` указывает на неё; ссылки открываются: `card` — 200, `image/jpeg`, 2632 байта; `thumb` — 200, 553 байта. В списке позиций приходят `thumb.jpg` и `card.jpg`, строки `original.jpg` в ответе списка нет.
2. **Подделанное расширение и SVG.** Текстовый файл с именем `photo.jpg` → **400** `CATALOG_PHOTO_INVALID{reason: "not_an_image"}`; SVG под видом `image/png` → **400** `{reason: "unsupported_format", detected: "svg"}`; SVG со своим типом → **415** `UNSUPPORTED_MEDIA_TYPE`. Повторная загрузка того же файла → **200**, второй записи и вторых файлов нет.
3. **Отклонение основной и последней.** Две подтверждённые фотографии; отклонение основной → основной стала вторая (`primary: 0903d244`); отклонение последней → `photo: null`, позиция без фото.
4. **Отложенное удаление.** После отклонений в MinIO остаются 6 объектов; `jobs:run catalog.delete-photo-files` при сроке 7 дней — объекты на месте; `settings:set photo_removed_retention_days 0` и повторный запуск → объектов 0, у обеих записей `files_deleted_at`, строк `item_photo_file` — 0, сами записи остались.
5. **Файлы без записей.** Положенный «вручную» объект под префиксом фотографий не удаляется, пока `photo_orphan_retention_hours = 24`; после `settings:set … 0` (и ~30 с на кэш настроек worker'а) `jobs:run catalog.cleanup-photo-files` удаляет именно его, файлы живой фотографии остаются; в логе worker'а — `Photo files without a record deleted files=1`.
6. **Остановка хранилища.** `docker stop adclub-dev-minio-1` → загрузка **503** `SERVICE_UNAVAILABLE`, `retryable: true`; `/catalog/categories` — 200, карточка позиции — 200, `/health` — 200, `/ready` — 503 (`s3: error`). После `docker start` загрузка снова **201**.
7. **`photo_display_mode`.** Фотография с адресом источника: при `copy` — `mode: "copy"`, ссылка на `card.jpg`, размеры и `expiresAt` заполнены, файл открывается; при `link` — `url` и `thumbUrl` равны адресу источника, `width`/`height`/`expiresAt` — `null`. В обоих режимах администратор видит нашу копию.

После прогона все изменённые в dev настройки возвращены к умолчаниям (`settings:reset`).

Экранов админки нет (TASK-035), поэтому браузерный E2E не запускался; сценарии пройдены по API, как и предполагает задача.

## Acceptance Criteria

- **AC-1 — PASS.** Загрузка работает (UAT 1; `catalog-photos.integration.test.ts` → «stores a picture as a candidate with three sizes and no camera data»). Фактическая проверка содержимого: «refuses a file that is not a picture, whatever it is called or declared», «refuses a vector picture: as bytes behind a raster type, and by its own type» (400 `unsupported_format` + `detected: "svg"` и 415), «refuses an empty body and a picture that breaks off», «refuses a file above the size limit with 413, not 500». Юнит-тесты формата и подготовки — `photo-image.test.ts` (14 тестов, в том числе GIF, BMP, TIFF, PDF, SVG за меткой порядка байтов и за комментарием).
- **AC-2 — PASS.** «stores the same picture only once for one item» (повтор → 200, одна запись, три объекта) и «keeps one picture on two items as two photos of their own» (6 объектов). Метаданные: в интеграционном тесте загружается JPEG с `Make: ACME` и GPS, после чего **у всех трёх объектов в MinIO** `exif` отсутствует и байты не содержат ни `ACME`, ни `GPSLatitudeRef`; в юнит-тесте одна и та же картинка с разными EXIF даёт одну контрольную сумму.
- **AC-3 — PASS.** Источник обязателен для найденных в интернете («asks for the page a picture found on the internet came from»), адрес не-`http` отклоняется. Статусы и видимость — «shows a client only what a person approved»; причина отклонения обязательна — «refuses a photo only with a reason…» (400 без `reason`). Журнал в той же транзакции — «writes every decision to the journal in the transaction of the decision»; при отказе записи нет — «writes nothing to the journal when the decision is refused» (409 по версии, в журнале по-прежнему одна запись). Конкурентные решения — «refuses the second of two administrators deciding on one photo».
- **AC-4 — PASS.** «makes the first approved photo the primary one» (проверяется и `catalog_item.primary_photo_id` в базе), «hands the role to the next approved photo when the primary one is refused», «leaves the item without a picture when the last photo is removed», «puts the approved photos in the order asked for, the first one primary», «refuses an order that leaves a photo out or names one that is not approved», «keeps the photos of an item that is archived and restored». То же пройдено в dev (UAT 3).
- **AC-5 — PASS.** «gives links that open the picture and expire»: подписанная ссылка открывается (200), ссылка со сроком 1 с через 1,5 с даёт **403**, следующий ответ API несёт новую рабочую ссылку. «does not let a link reach another file»: та же подпись с подставленным чужим ключом — 403, и выдуманный ключ — 403.
- **AC-6 — PASS.** «never sends the full-size picture to a list»: в ответе списка нет подстроки `original.jpg`, `thumbUrl` ведёт на `thumb.jpg`, `url` — на `card.jpg`; скачанный `thumb` меньше оригинала, его длинная сторона — 320 px; полноразмерная ссылка есть только в `originalUrl` ответа модерации.
- **AC-7 — PASS.** «serves our copy with copy and the source address with link» (оба режима, включая то, что администратор и в режиме `link` видит нашу копию) и «serves our copy in link mode too when the photo has no source address». В dev — UAT 7.
- **AC-8 — PASS.** «keeps the files until the retention, then removes them» (при сроке 7 дней объекты на месте, при 0 — удалены, `files_deleted_at` заполнен, строк файлов 0, **повторный запуск безопасен**), «does not bring back a photo whose files are gone» (409 `CATALOG_PHOTO_FILES_DELETED`), «removes files no record points at, and leaves the ones that have a record» (повторный запуск ничего не портит). Сроки берутся из настроек. В dev — UAT 4 и 5.
- **AC-9 — PASS.** «answers the upload with a repeatable error and goes on serving the catalog»: хранилище отключается TCP-форвардером, загрузка — 503 с `retryable: true`, `/catalog/categories`, карточка позиции, список фотографий и `/health` отвечают 200, после возврата хранилища загрузка снова 201. В dev — UAT 6 (с настоящей остановкой контейнера).
- **AC-10 — PASS.** «lets a picture through on the upload route and refuses one everywhere else»: картинка на маршруте загрузки — 201; тот же путь методом `GET` с телом-картинкой — 415; другой маршрут с телом-картинкой — 415; обычный JSON-маршрут — 201. Плюс `routes.test.ts` — «names every route whose body is a file, and only those».
- **AC-11 — PASS.** «serves the photo routes to an administrator only» (мобильная сессия — 403 `FORBIDDEN`, без сессии — 401 `AUTH_REQUIRED`, ничего не сохранено). Кроме того, все четыре маршрута попали в существующие матрицы доступа: `catalog.integration.test.ts` (32 админских маршрута каталога) и `catalog-items.integration.test.ts` (18 маршрутов брендов, позиций и дозаполнения) — обе матрицы теперь шлют на маршрут-загрузку настоящую картинку, чтобы отказ был про доступ, а не про тело.
- **AC-12 — PASS.** Контракт, OpenAPI (включая тело-файл) и клиент обновлены; `openapi:check` — PASS, `openapi:compat --base HEAD` — «No breaking changes to report» (трейлер не нужен). Миграция обратима: новый тест `database.integration.test.ts` → «rolls back the latest migration only (photos of items), keeping the items» (таблицы и колонка исчезают, позиция остаётся, `up` возвращает всё). Таблицы добавлены в сверку схемы (`ormTables`, `schema-drift.test.ts`) и в очистку между тестами. Существующие тесты не ослаблены — наоборот, три матрицы доступа и список фоновых задач расширены; перехват вывода интеграционных тестов чист (ни один тест не упал по утечке).
- **AC-13 — PASS.** Пять коммитов по D-024 (состав ниже), правки Product Owner отдельным коммитом. CI на `main`: run **35530341048** (`4718f0c`) — `success`, с первой попытки. Номер и статус прогона коммита с отчётом дописываются отдельным коммитом (как в TASK-053.A).
- **AC-14 — PASS.** ARCHITECTURE.md 0.25: новый раздел 4.22 (I199–I205), уточнены 5.2 (`item_photo`, `item_photo_file`, `catalog_item.primary_photo_id`), 14 (четыре настройки группы «Фото»), 15.2 (как на самом деле идёт загрузка), версия и история изменений. CLAUDE.md блок 0: модуль в описании структуры, `minio-init` в запуске dev, раздел «Фотографии позиций в dev», состав интеграционных тестов.

## Состав коммитов

| Коммит | Что в нём |
|---|---|
| `ae45561` | **Правки Product Owner** (D-024): `PROJECT_PLAN.md`, `PROJECT_STATE.md` |
| `6c823d8` | Зависимости: `apps/api/package.json` (`sharp`, `@aws-sdk/s3-request-presigner`, `testcontainers`), `pnpm-lock.yaml` |
| `4b9c998` | `infra/docker/compose.dev.yml` — создание бакета в dev |
| `b8c5a32` | Сама задача, 41 файл: контракт (`catalog-photos.ts`, `routes.ts`, `openapi.ts`, `catalog-items.ts`, `error.ts`, `audit.ts`, `index.ts` и их тесты), клиент (`create-api-client.ts` + тест), `apps/api/openapi.json`, миграция, модуль фотографий (`photo-image.ts` + тест, `photo-storage.ts`, `catalog-photos.service.ts`, `catalog-photos.controller.ts`, `photo-jobs.ts`, `photo-cleanup.ts`, интеграционный тест), чтение тела-файла (`upload-routes.ts`, `upload-body.middleware.ts`, `json-body.middleware.ts`, `app.module.ts`, `common/http/index.ts`), встраивание (`catalog-items.service.ts`, `schema.ts`, `catalog.module.ts`, `catalog/index.ts`, `translation-runner.ts`, `background-jobs.ts`, `operator.ts`, реестр настроек), обновлённые существующие тесты (`schema-drift.test.ts`, `database.integration.test.ts`, `catalog.integration.test.ts`, `catalog-items.integration.test.ts`, `access.integration.test.ts`, `sign-in-data-cleanup.integration.test.ts`, `testing/database.ts`) |
| `4718f0c` | `ARCHITECTURE.md` 0.25, `CLAUDE.md` |
| последний | `tasks/TASK-013-REPORT.md` (и отдельный коммит с номером его CI-прогона) |

## Errors & Fixes

1. **Сырые управляющие символы в исходнике.** Первая версия `photo-image.ts` сравнивала сигнатуры TIFF строками с ` `, и инструмент записи файла превратил экранирование в настоящие байты NUL (та же ошибка, что закрывали в TASK-011.A). Заменено на сравнение байтов, метка порядка байтов строится из кода символа; весь изменённый набор файлов проверен на управляющие символы.
2. **Путь запроса в middleware.** `req.path` внутри middleware, смонтированного на все маршруты, Express делает относительным к точке монтирования, и маршрут загрузки не узнавался — запрос получал 415 от проверки «тело только JSON». Путь берётся из `originalUrl` (`contractPathOf`).
3. **`express` не является прямой зависимостью `apps/api`.** Первая версия чтения тела использовала `express.raw` и падала при импорте в тестах. Тело читается вручную — это ещё и точнее: предел останавливает само чтение, а разбирать в байтах нечего.
4. **`TRUNCATE` между тестами.** Новый внешний ключ `catalog_item.primary_photo_id` сделал старый список таблиц неполным («cannot truncate a table referenced in a foreign key constraint»); добавлены `item_photo_file` и `item_photo`. Отдельно: в файле с работающим worker'ом `TRUNCATE` иногда встречался с проходом свипера — в тесте добавлен повтор, это особенность стенда, а не продукта.
5. **Списки, которые должны были вырасти.** Новые маршруты и задачи сломали четыре существующих утверждения (матрицы доступа в двух файлах, список миграций и список расписаний/задач). Все обновлены по существу, а матрицы доступа дополнены отправкой настоящей картинки на маршрут-загрузку.

## Deviations

1. **«Выдача фотографий встроена в существующие клиентские ответы справочника».** Клиентских ответов с позициями пока нет: `/catalog/categories` и `/catalog/categories/{id}/attributes` отдают дерево и описание фильтров, карточки позиций появятся с предложениями (EPIC-07/EPIC-10). Фотография встроена в существующие ответы **с позициями** — список `GET /admin/catalog/items` и карточку `GET /admin/catalog/items/{id}` — одним полем `photo`, которое строится единой функцией и обязано отдавать только подтверждённые фотографии; клиентские ответы EPIC-07 возьмут это же поле. Отдельного публичного файлового маршрута не появилось, как и требует задача. Это же соответствует разделу «Что должно реально работать», где проверяются «карточка позиции» и «список».
2. **ARCHITECTURE 15.2** описывала загрузку только через presigned URL прямо в хранилище. Задача требует загрузку через API (иначе исключение из проверки «тело только JSON» не имело бы смысла). Расхождение разрешено в пользу задачи, запись 15.2 уточнена, presigned оставлен как вариант для крупных файлов будущих задач.
3. **ARCHITECTURE 5.2** упоминала `item_photo.storage_key` (один объект). Объектов у фотографии три, поэтому ключ живёт в новой таблице `item_photo_file`; запись 5.2 обновлена.

## Known Issues / Risks

1. **Миграция.** `1790050000000_create-item-photos.sql` добавляет две таблицы и колонку; обратима, данных не трогает. Ручных действий не требует.
2. **Новый бакет в dev.** После `git pull` нужен `docker compose -f infra/docker/compose.dev.yml up -d`, чтобы отработал `minio-init`. В staging/production бакет создаётся вне приложения (TASK-055): приложение бакет не создаёт и не должно.
3. **`sharp` — нативная зависимость.** Бинарники под win32/linux/darwin есть в lock-файле, сборка на месте не требуется; на musl-образах (Alpine) подтянется `linuxmusl`-вариант. Стоит иметь в виду при подготовке образа развёртывания.
4. **Стоимость загрузки — память процесса.** Файл читается целиком в память (потолок 50 МБ на запрос) и обрабатывается в процессе API. При десятках одновременных загрузок это заметно; пока загружает только администратор, это не проблема. Загрузка поставщиком (EPIC-06) и импорт прайсов — повод вернуться к presigned-варианту.
5. **Локальные интеграционные тесты** на машине с большим числом ядер нужно запускать с `--maxWorkers=3` (см. «Verification») — иначе Docker Desktop не выдерживает числа одновременных контейнеров. На раннере CI параллелизм и так ограничен числом ядер.
6. **Авторские права.** Режим показа по умолчанию — `link` (PRODUCT 9.7): до заключения юриста наша копия клиентам не отдаётся, хотя и хранится для модерации. Переключение — настройка, без релиза.
7. **Число фотографий у позиции** ограничено 20; проверка выполняется до транзакции, так что при двух одновременных загрузках «двадцать первой» обе могут пройти. Последствие — на одну лишнюю фотографию у позиции, что безвредно.

## Remaining Work

None.

## Future Improvements

- **Экран «Фото» в админке** (A-CAT-05) — TASK-035: модель и маршруты под него готовы, включая `originalUrl` и порядок перетаскиванием.
- **Раздача через CDN** (TASK-055): сейчас каждая ссылка подписывается на час; с CDN-прокси перед бакетом подписи можно давать длиннее и снять нагрузку с API.
- **Фотография от поставщика** (EPIC-06) и **поиск изображений ИИ** (EPIC-17) ложатся на готовую модель: `proposed_by`, `ai_score`, `ai_job_id`, `source_evidence` уже есть, менять её не придётся.
- **Перцептивный хэш** вместо точной контрольной суммы поможет ловить «ту же картинку в другом качестве» — пригодится, когда кандидаты начнут приходить от ИИ из разных магазинов (ARCHITECTURE 9.7).
- **WebP для выдачи**: сейчас варианты сохраняются в формате исходника; перевод `card` и `thumb` в WebP заметно сократил бы трафик мобильного приложения.
- **Метрики фотографий** (сколько ждёт модерации, сколько места занято) — вместе с дашбордами TASK-055.

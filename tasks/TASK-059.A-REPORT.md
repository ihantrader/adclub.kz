# TASK REPORT — TASK-059.A

## Status
COMPLETED (по всем AC с локальными проверками; на телефоне не проверялось — нативной сборки здесь нет, это вне задачи)

## Result
- **Шторка голоса и системный запрос разрешения.** Пока на экране системный вопрос о микрофоне, уход приложения из `active` (iOS — `inactive`, Android — `background`) шторку больше не закрывает. После каждого ожидания в `begin`, `allow`, `send` и в обработчиках записи проверяется, что шторка открыта и ничего нового не начато; иначе запись не начинается и ничего не отправляется. Если свернуть приложение во время записи, она по-прежнему отбрасывается.
- **Отмена во время старта записи.** Если отменить запись, пока `start()` ещё ждёт микрофон, оба порта (телефон и браузер) закрывают всё, что открылось с опозданием: поток со слушателем, режим записи, дорожки `MediaStream`. `AudioContext` и таймер подмены не создаются, обработчики не вызываются.
- **Предел `POST /speech/transcribe` по адресу.** Новый предел `speech_requests_per_ip`: 300 запросов за 600 с. Считается **до чтения тела**, в том числе запросы, отказанные с 400/413/415. Пробные попытки гостя он не трогает. Сверх предела — 429 `RATE_LIMITED`, `details.limit: "speech_requests_per_ip"`, `Retry-After`. В этом случае приложение пишет «Голосовой ввод временно недоступен» вместо M-AI-02.
- **`cleanSpeechText`.** Текст режется целыми символами в пределах длины строки поиска (она считается в единицах UTF-16), поэтому суррогатная пара больше не разрывается. Если обрезка по слову не оставила ни буквы, ни цифры, текст режется по символам. Пустой результат всегда даёт `heard: false`.

## Changes
- `apps/mobile/src/speech/voice-input.ts`: чистые правила `voiceOnAppState` и `voiceAnswerWanted`; в `voiceFailureOf` добавлен отказ по `speech_requests_per_ip` → `unavailable`.
- `apps/mobile/src/screens/catalog/VoiceSheet.tsx`: ссылки `open` и `asking`, проверка `wanted(token)` после каждого `await`, слушатель `AppState` работает через `voiceOnAppState`.
- `apps/mobile/src/speech/native-speech-core.ts` (новый): логика порта телефона `createNativeSpeechPortWith(deps)` с номером попытки. `native-speech-port.ts` теперь только подставляет `expo-audio` и `Linking`.
- `apps/mobile/src/speech/web-speech-port.ts`: окружение `WebSpeechEnv` (по умолчанию — браузер) и номер попытки.
- `apps/mobile/src/speech/speech-ports.test.ts` (новый): отмена посреди `start()` у обоих портов.
- `apps/api/src/rate-limit/route-limit-counter.ts` (новый): `RouteLimitCounter` (вынесен из guard'а) и `countedBeforeBody`. `upload-rate-limit.middleware.ts` (новый): `UploadRateLimitMiddleware`. `route-rate-limit.guard.ts` работает через общий счётчик и пропускает маршруты, посчитанные до тела. `app.module.ts`: новый промежуточный слой стоит перед `UploadBodyMiddleware`. `common/http/upload-routes.ts`: найденный маршрут несёт `rateLimit`.
- `packages/contracts`: имя `speech_requests_per_ip` в `rateLimitNameSchema`; `rateLimit` у `transcribeSpeech`. `apps/api/openapi.json` перегенерирован (+5 строк). `speech.controller.ts` привязан через `RateLimitedRoute`.
- `apps/api/src/modules/settings/registry/registry.ts`: `speech_requests_per_ip` (300, 10…100 000) и `speech_requests_per_ip_window_seconds` (600, 60 с…сутки), группа «Гость и помощник».
- `packages/domain/src/speech/speech-text.ts` и `speech.test.ts` — обрезка текста.
- `ARCHITECTURE.md` 1.17: I1051–I1054 в разделе 4.90 и таблица 14. `CLAUDE.md` — «Голос в dev».

## Technical Decisions
- **Предел считается промежуточным слоем, а не guard'ом.** Тело маршрута с файлом читает `UploadBodyMiddleware`, а он срабатывает раньше любого guard'а. Поэтому guard увидел бы только запросы, прошедшие чтение и проверку типа: 415 и транспортный 413 до него не доходят, а тело до 4 МБ уже прочитано. Механизм пределов остался один (настройки, Redis, 429, поведение без Redis — общий `RouteLimitCounter`). Разница только в месте счёта: правило `countedBeforeBody` (есть `upload`, предел только по адресу). Маршрут с пределом по учётной записи требует сессии, поэтому его по-прежнему считает guard. Внесено в ARCHITECTURE 4.90 I1053.
- **Вошедший с того же адреса упирается в тот же предел.** Промежуточный слой сессии не знает. Предел щедрый и защищает от потока запросов, а не от человека.
- **Порт телефона вынесен в чистое ядро с подставляемыми зависимостями.** Иначе его нельзя проверить юнит-тестом без React Native (I1052).
- **Сама шторка тоже страхует.** После `start()` она вызывает `cancel()`, если уже закрыта. Контрольный прогон показал, что со старым портом это закрывает утечку, но `AudioContext` всё равно успевает создаться; исправленный порт его не создаёт.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS (0 ошибок; одно старое предупреждение `isNotNull` в `ratings/supplier-ratings.service.ts`, не из этой задачи)
- `pnpm typecheck` — PASS (20/20)
- `pnpm test` — PASS (19/19)
- `pnpm build` — PASS (12/12)
- интеграционные тесты `src/modules/speech` — PASS (10/10, включая новый)
- интеграционные тесты `src/modules/settings` — PASS (17/17)
- интеграционный тест `src/rate-limit` (`trust-proxy`, после переделки guard'а) — PASS (вместе со speech — 13/13)
- `openapi:generate`, `openapi:check` — PASS («matches the contract and the served routes»)
- `openapi:compat --snapshots` — PASS («Compatible with every supported app version: 1.0.0»)
- CI — запущен прогон **44110938286** (push в `main`), результат не ждал

## UAT / E2E
Безголовый Chrome (Playwright, `channel: "chrome"`), запущены `api-test-ai` (`AI_PROVIDER=test`) и `mobile-web`, телефон 390×844. Dev-контейнеры работают на 5433/9002, поэтому `env` в `.claude/launch.json` был временно поправлен; файл восстановлен, в коммит не попал.
- **Путь гостя M-CAT-05, ru/светлая и kk/тёмная.** Подмена `__adclubSpeech` (`ru-pads-atlas.wav`). Микрофон → «Поиск голосом» → «Продолжить» → «Говорите…» с уровнем → «Стоп» → в строке «Колодки на атлас», отметка «распознано», «Показаны результаты по «колодки»», 2 позиции. Ровно один запрос `/speech/transcribe`. Снимки — `tasks/TASK-059.A-shots/guest-*`.
- **Отмена посреди открытия настоящего микрофона.** Chrome с поддельным устройством; `getUserMedia` отвечает с задержкой 1,5 с; «Отмена» нажата сразу после появления «Говорите…». Итог: `{"transcribeRequests":0,"sheetClosed":true,"streams":1,"liveTracks":0,"audioContexts":0}` — поток, открывшийся после отмены, остановлен, `AudioContext` не создан, запроса нет. Chrome с этим флагом сразу считает микрофон разрешённым, поэтому шага «Продолжить» не было: отмена пришла во время `start()`, как и нужно по сценарию. Для сравнения тот же сценарий со старым `web-speech-port.ts` (и новой шторкой) дал `"audioContexts":1`. Снимки — `cancel-mic-*`.
- **Отмена во время загрузки файла подмены.** Файл отдаётся с задержкой 2 с, «Продолжить» → сразу «Отмена». Итог: `{"transcribeRequests":0,"sheetClosed":true,"recognised":false}`. Снимки — `cancel-file-*`.
- **На телефоне не проверено** (нативной сборки нет): системный запрос разрешения iOS и Android и поток `expo-audio`. Пункты 1 и 2 для телефона проверены только юнит-тестами логики и подменённой фабрики.

## Acceptance Criteria
- **AC-1 — PASS.** `apps/mobile/src/speech/voice-input.test.ts`, блок «the sheet when the app leaves and returns»: системный запрос (`asking` + `inactive`/`background` → keep), запись (`open` → discard), закрытая шторка (keep), `voiceAnswerWanted`. `speech-ports.test.ts`: телефон — отмена при установке режима звука и при `stream.start()` (поток остановлен и освобождён, слушателей 0, режим выключен, обработчики не вызваны); браузер — отмена при `getUserMedia` (дорожки остановлены, `AudioContext` 0) и при загрузке файла (таймеров 0). `speech.test.ts`: суррогатная пара и пустой результат. Мобильные 16/16, domain 15/15.
- **AC-2 — PASS.** `speech.integration.test.ts`, тест «stops a flood of refused bodies…»: десять ответов 400/415/413 с одного адреса, затем 429 `speech_requests_per_ip` с `Retry-After` — и на мусор, и на настоящую запись, и для вошедшего с того же адреса. ИИ не вызывался, `ai_job` пуст, первая настоящая запись гостя даёт `remaining: 4` из 5. Сверки настроек: `pnpm test` (registry) и интеграционные `settings` (17/17) — PASS.
- **AC-3 — PASS.** Подробности — в UAT выше; снимки — `tasks/TASK-059.A-shots/` (12 файлов).
- **AC-4 — PASS.** `openapi.json` +5 строк (`x-rate-limit` у маршрута и новое значение перечисления); `openapi:check` и `openapi:compat --snapshots` — PASS.
- **AC-5 — PASS.** Результаты — в Verification выше. CI не ждал.
- **AC-6 — PASS.** ARCHITECTURE 1.17: I1051–I1054 (номера были свободны) и строка таблицы 14; CLAUDE.md «Голос в dev» — предел, проба и поведение шторки; этот отчёт; прогон CI 44110938286.

## Errors & Fixes
- Первый запуск `api-test-ai` с временным `env` упал: `S3_ENDPOINT` стал пустым. Адрес задан явно (`http://localhost:9002`).
- При правке CLAUDE.md однострочный `node -e` превратил `\n` в настоящий перенос строки. Исправлено скриптом из файла; переносов в тексте нет, «/usr/bin/bash» в ARCHITECTURE и CLAUDE.md тоже нет.

## Deviations
- В задаче сказано «через `RateLimitedRoute` и поле `rateLimit` контракта». Маршрут объявлен и привязан именно так, но предел по адресу у маршрутов с файлом считает промежуточный слой с тем же счётчиком, а не guard: guard срабатывает после чтения тела и не увидел бы отказы 415 и транспортный 413 (подробности — Technical Decisions, I1053).

## Known Issues / Risks
- На телефоне не проверялось (системный запрос разрешения, `expo-audio`). Нужно проверить на первой собственной сборке.
- Предел по адресу общий для гостей и вошедших. При 300 запросах за 10 минут на одном адресе оператора это не должно мешать людям; если помешает — меняется настройкой.

## Remaining Work
None.

## Future Improvements
- Предел по адресу до чтения тела стоит подключить и другим маршрутам с файлом: фото техпаспорта, панели и детали (`/garage/vehicle-document`, `/garage/dashboard`, `/catalog/part-photo`). Там те же отказы до счёта попыток. Механизм готов — достаточно объявить `rateLimit.limit` в контракте.

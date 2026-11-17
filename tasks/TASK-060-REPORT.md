# TASK REPORT — TASK-060

## Status
COMPLETED (на телефоне не проверялось — нативной сборки и телефона нет; это вне задачи)

## Result
Голос теперь есть во всех точках ввода SCREENS, путь звука к серверу один (`SpeechRecognitions`, `POST /speech/transcribe`), лимиты, правило «тратится ли попытка» и хранение — прежние.

- **Пробег** (M-GAR-07 и вопрос M-REM-02): микрофон в поле «км» → «Назовите пробег», пример «сорок пять тысяч двести» → число в поле с «распознано» → «Всё верно, сохранить» и «Сказать ещё раз». Нет числа — «Не поняли пробег», поле не меняется. «Меньше, чем в прошлый раз» — прежнее. В журнал идёт `source: text`.
- **Автомобиль** (M-START-05 и шторка M-GAR-02): «Сказать голосом» → «Назовите автомобиль», пример «Geely Atlas 2023, 1,5 турбо». Сопоставляет сервер — новый `POST /vehicles/match {text}`: без ИИ, гостю и любой сессии, с пределом частоты по адресу. Дальше — шаги и итог с «распознано», как после техпаспорта. Сохраняется автомобиль с отметкой «документ не подтверждён». Марки нет в справочнике — «Не поняли автомобиль», «Сказать ещё раз», «Выбрать из списка». Любая неудача голоса открывает «Выбрать из списка».
- **Помощник** (M-AI-01): микрофон в поле рядом с камерой. Текст ставится в поле, отправляет человек. Тратится голосовая попытка, диалог помощника — нет.
- **Цель распознавания**: `POST /speech/transcribe?purpose=search|mileage|vehicle|assistant`. Цель уточняет подсказку модели и задаёт длину текста. Целое сообщение помощнику приходит в новом поле `message` (до 1000 знаков), `text` по-прежнему не длиннее 100 — контракт только расширен.
- **«Одна буква»**: сервер отвечает `heard: false` (правило в `cleanSpeechText`), приложение своей проверки длины больше не держит.
- **Поток мусора на маршруты с фото** (`/garage/vehicle-document`, `/garage/dashboard`, `/catalog/part-photo`) отсекается до чтения тела — новая настройка `photo_requests_per_ip`, как `speech_requests_per_ip`. Пробные попытки гостя не тратятся.

## Changes
- **Домен** (`packages/domain`):
  - `speech/number-words.ts` — `numberWordsToDigits`: числа словами ru/kk/en в цифры;
  - `assistant/mileage-in-text.ts` — `mileageInText(text, { field: true })`;
  - `vehicle/vehicle-phrase.ts` — `readVehiclePhrase`, `vehicleNameSpans`, `vehicleNameSpellings`;
  - `speech/speech-text.ts` — правило «меньше двух букв или цифр — не расслышали» (`SPEECH_TEXT_MIN_SIGNS`);
  - тесты: `speech/number-words.test.ts`, `speech/speech.test.ts`.
- **Контракт** (`packages/contracts`):
  - `speech.ts` — `speechPurposeSchema`, `purpose` в запросе, `message` в ответе;
  - `vehicle-document.ts` — `vehicleMatchBodySchema`, `vehicleMatchResponseSchema`;
  - `routes.ts` — маршрут `matchVehicleText`, `rateLimit` у трёх маршрутов с фото;
  - `login-code.ts` — имена пределов `photo_requests_per_ip`, `vehicle_match_per_ip`;
  - `openapi.ts`; `apps/api/openapi.json` перегенерирован.
- **Сервер** (`apps/api`):
  - `modules/speech/speech.service.ts`, `speech.controller.ts` — цель и длина;
  - `modules/ai/*` — `SpeechInput.purpose`, подсказка по цели `speechSystem`, тестовая реализация записывает цель; `test-speech.ts` — ответы новых образцов и `TEST_SPEECH_MADE`;
  - `modules/vehicle-document/vehicle-matching.ts` — `VehicleMatching`: одна часть «ниже модели» для техпаспорта и голоса; `VehicleDocumentService` использует её;
  - `vehicle-match.controller.ts` — новый маршрут;
  - три контроллера фото переведены на `RateLimitedRoute`;
  - настройки `photo_requests_per_ip`, `vehicle_match_per_ip` (+ окна);
  - замер `ai:eval:speech` передаёт модели цель образца.
- **Приложение** (`apps/mobile`):
  - `screens/voice/VoiceSheet.tsx` — общая шторка, перенесена из `screens/catalog`;
  - `screens/voice/VoiceInput.tsx` — шторка вместе с M-AI-02 и входом;
  - `speech/voice-input.ts` — `VoiceAccepted`, `voiceFailureOpensList`, `voiceOutcomeOf` по `heard` сервера и `message`;
  - `services/speech.ts` — цель и `matchVehicleText`;
  - `navigation/car-adding.tsx` — «Сказать голосом», `CarVoice`;
  - `garage/document-flow.ts` — `recognitionStart` для голоса, `source: "voice"`;
  - `screens/garage/CarSummaryView.tsx` — «документ не подтверждён», без «Переснять»;
  - экраны с микрофоном: `CarMileageScreen.tsx`, `catalog/HomeHintCard.tsx`, `assistant/AssistantScreen.tsx`; `catalog/SearchScreen.tsx` переведён на общую шторку;
  - переводы kk/ru/en (21 ключ).
- **Образцы речи**:
  - восемь новых WAV в `ai-eval/speech/samples` (коды 40–47), `samples.json`;
  - `scripts/speech-samples.mjs` — образцы с целью, `--only`, `--check` сравнивает данные.
- **Документы**:
  - `ARCHITECTURE.md` 1.19 — раздел 4.91 (I1056–I1067), таблица 14, пометка в I1043;
  - `CLAUDE.md` — «Голос в dev» дополнен.

## Technical Decisions
Внесены в ARCHITECTURE 4.91:
- **Длина текста для помощника (I1057).** Поднять `maxLength` у `text` ответа нельзя: `openapi:compat --base HEAD` считает это ломающим изменением. Поэтому `text` остаётся до 100 знаков, а целое сообщение приходит в новом необязательном поле `message`.
- **Пробег (I1060).** Одна функция `mileageInText`: с режимом поля и с числами словами.
- **Сопоставление автомобиля (I1061).** «Ниже модели» — общий метод `VehicleMatching.belowModel` для техпаспорта и голоса, без второй копии. Марка и модель ищутся по отрезкам фразы в обеих письменностях.
- **Автомобиль голосом (I1062).** Идёт путём техпаспорта с `source: "voice"`, сохраняется с отметкой «документ не подтверждён».
- **Шторка (I1063).** `accept` возвращает действие после закрытия шторки или состояние.
- **Фото (I1065).** Один предел `photo_requests_per_ip` на три маршрута.

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS
- `pnpm typecheck` — PASS
- `pnpm test` — PASS, 19/19 задач Turborepo. В первом прогоне, параллельно со сборкой, один тест приложения (`no-catalog-without-car.test.ts`, сканирует исходники) упал по таймауту 5 с. Отдельно он проходит за 0,5 с, повторный полный `pnpm test` — зелёный.
- `pnpm build` — PASS
- `node scripts/speech-samples.mjs --check` (`pnpm speech:samples --check`) — PASS, «speech samples: 33 up to date»
- `pnpm --filter @adclub/api openapi:generate`, `openapi:check` — PASS
- `openapi:compat --base HEAD` — PASS («Contract is backward compatible with HEAD»)
- `openapi:compat --snapshots` — PASS («Compatible with every supported app version: 1.0.0»)
- Интеграционные изменённых модулей, по очереди (`--no-file-parallelism`): `speech`, `vehicle-document`, `garage` (`photo-recognition`, `garage`), `vehicles`, `settings` — PASS, 6 файлов, 111 тестов.
- CI: прогон 44162124332 запущен после push в `main`. Результата не ждал — по правилам проекта его смотрит архитектор при приёмке.

## UAT / E2E
Безголовый Chrome (Playwright, `channel: "chrome"`), 390×844, `api-test-ai` (`AI_PROVIDER=test`) и `mobile-web`. Запись подменялась через `__adclubSpeech` файлами образцов, их раздавал локальный сервер с CORS. Dev-контейнеры работают на 5433/9002, поэтому `env` в `.claude/launch.json` был временно поправлен; файл восстановлен и в коммит не попал. Снимки — `tasks/TASK-060-shots/` (40 файлов).

**Гость, ru светлая и kk тёмная** (`guest-*`):
1. M-START-05: «Сказать голосом» есть, «Выбрать из списка» нет.
2. Пояснение «Назовите автомобиль» → «Говорите…» с примером → итог: Geely, Atlas, 2023, II (FX11) с «распознано».
3. «Всё верно, сохранить» → автомобиль в гараже, в карточке «Документ не подтверждён».
4. Пробег: микрофон → 45200 «распознано» → «Пробег сохранён». В карточке «45 200 км · сегодня · вручную».
5. «Добавить автомобиль» → «Сказать голосом» → `ru-car-unknown` → «Не поняли автомобиль» с «Сказать ещё раз» и «Выбрать из списка». Следующее открытие шторки M-GAR-02 показывает «Выбрать из списка».
6. AI Pilot: микрофон → «Скрипит при торможении, что посмотреть» в поле. Запросов `/assistant/messages` не было.
7. Шестая голосовая попытка гостя → M-AI-02 «Пробные запросы закончились».

Все запросы распознавания ушли с нужной целью (`purpose=vehicle|mileage|assistant`), сопоставление — двумя запросами `POST /vehicles/match`.

**Вошедший, M-REM-02, ru тёмная (+77010000367) и kk светлая (+77010000368)** (`reminder-*`):
1. Автомобиль голосом гостем, затем вход из гаража.
2. Показанию автомобиля аккаунта задана давность 40 дней (SQL).
3. На главной каталога вопрос «Какой сейчас пробег…» → микрофон → `ru-mileage-words` («Сто двадцать тысяч» словами) → 120 000 «распознано» → «Пробег сохранён».
4. В `mileage_log` последняя запись — `120000 text`.

Для прогонов `speech_per_ip` временно поднимался до 500: все гости headless — это 127.0.0.1, и предел 30 в сутки кончился. После прохода вернул `settings:reset`.

Попутно видно: при исчерпанном пределе адреса M-START-05 показывает M-AI-02, и появляется «Выбрать из списка».

## Acceptance Criteria
- **AC-1 — PASS.** Юнит-тесты:
  - `packages/domain/src/speech/number-words.test.ts`:
    - числа словами ru/kk/en;
    - пробег в поле: «45 200», «45 тысяч», «45 тыс.», «сорок пять тысяч двести», «қырық бес мың екі жүз», «forty five thousand two hundred», «45 thousand», «км», «километров», «шақырым»; «45 или 46 тысяч» → null;
    - фраза автомобиля: год, объём «1,5», «1.5», «2.0T», «полтора литра», год словами, будущий и слишком старый год, «Tiggo 7 Pro», ничего кроме года, отрезки в обеих письменностях.
  - `packages/domain/src/speech/speech.test.ts` — одна буква или цифра → `heard: false`.
  - `apps/mobile/src/speech/voice-input.test.ts` — `voiceFailureOpensList` (все неудачи → список; пояснение, запись, распознавание — нет), `heard` сервера и `message`.
  - `apps/api/src/modules/ai/ai-gateways.test.ts` — подсказка по цели.
- **AC-2 — PASS.** Интеграционные:
  - `vehicle-document.integration.test.ts`, блок «a car named by voice»:
    - «Джили Атлас 2023» → Geely Atlas, II (FX11), `ai_job` пуст;
    - «Geely Coolray 2024 1.5» → двигатели 1,5 л кандидатами (JLH-3G15TD, без 2.0);
    - «Тойота», «Toyota Camry 2020», «2023 года», «атлас 2023» → `not_found`;
    - гость, мобильная сессия, `supplier-web` без сессии; 400 на пустой и длинный текст; лимит `vehicle_match_per_ip` → 429.
  - `speech.integration.test.ts`:
    - цель доходит до тестовой реализации;
    - помощник получает `message` длиннее 100, `text` ≤ 100;
    - поиск режет текст;
    - неизвестная цель — 400 без счёта;
    - одна буква — `heard: false`, попытка потрачена.
  - `photo-recognition.integration.test.ts` — поток мусора на три маршрута с фото → 429 `photo_requests_per_ip`, вошедший тоже, `ai_job` пуст, попытки гостя 3 из 3.
  - Сверки настроек — `registry.test.ts` («has exactly the keys ARCHITECTURE 14 lists»).
- **AC-3 — PASS.** Восемь образцов ru/en (голоса Irina, Zira, David). `pnpm speech:samples --check` — «33 up to date». `speech-fixtures.test.ts` — тестовая реализация узнаёт каждый образец по коду, WER 0.
- **AC-4 — PASS.** Проход в браузере — см. UAT. Снимки — `tasks/TASK-060-shots/`.
- **AC-5 — PASS.** `openapi:generate`, `openapi:check`, `openapi:compat --base HEAD` и `--snapshots` — без трейлера.
- **AC-6 — PASS.** См. Verification.
- **AC-7 — PASS.** ARCHITECTURE 4.91 (I1056–I1067) и таблица 14, CLAUDE.md «Голос в dev», этот отчёт.

## Errors & Fixes
- **`k` в «45200km».** `mileageInText` читала «k» как «тысячи»: 45 200 000 — вне диапазона, и такое число не находилось. Прежний тест проходил случайно: через «45,200» как 45.2 тыс. Теперь единица тысяч — целое слово, а запятая — разделитель тысяч.
- **`speech:samples --check` не сходился с файлом из репозитория.** Генератор сравнивал текст JSON, а файл отформатирован Prettier. Теперь сравниваются данные.
- **`maxLength` у `text`.** Увеличение `maxLength` контракт-проверка сочла ломающим. Сделано полем `message` (I1057).
- **Кириллица в curl.** Из Git Bash кириллица в `-d` уходит не в UTF-8, сервер видит мусор. Для проверки тело берётся из файла (записано в CLAUDE.md).

## Deviations
- **Поле `message`.** Задача просит «предел длины помощника» у ответа. Чтобы контракт остался аддитивным, текст помощника приходит в новом поле `message`, а не в `text` (I1057).
- **Кнопки после пробега голосом.** Задача называет их «Всё верно, сохранить» и «Переснять». У голоса вместо «Переснять» — «Сказать ещё раз»; кнопка фото остаётся.
- **«Не сейчас» в пояснении автомобиля.** Только закрывает шторку и список не открывает: список — следствие неудачи, а не выбора.

## Known Issues / Risks
- **Телефон не проверялся.** Нативной сборки и телефона нет: системный запрос микрофона, поток `expo-audio` и шторки на телефоне не проверены.
- **Замера нет.** Казахская речь не замерена (нет живых записей). Платный замер новых образцов не проводился.
- **Тесты под нагрузкой.** При параллельном запуске трёх интеграционных файлов один раз падали два теста `photo-recognition`: 500 у фото детали и гонка записи пробега. Отдельный прогон этого файла — 18/18, последовательный прогон всех шести — 111/111. Похоже на нехватку ресурсов при трёх наборах контейнеров сразу; причину 500 из перехваченного вывода установить не удалось.
- **Тестовые аккаунты.** В dev-базе остались автомобили и показания пробега у тестовых номеров +77010000367 и +77010000368.

## Remaining Work
None.

## Future Improvements
- Казахские голосовые образцы, когда будут живые записи (BACKLOG TASK-059).
- Модели и справочника автомобилей не хватает казахских написаний для голоса («Джили» есть, «Кулрей» есть, а у многих моделей написаний нет): «Не поняли автомобиль» будет чаще, чем нужно, пока справочник не пополнен.

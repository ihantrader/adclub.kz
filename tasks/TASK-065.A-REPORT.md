# TASK REPORT — TASK-065.A

## Status
COMPLETED

## Result
- Прайс, сопоставленный до «Неверно» и применённый после, больше не отменяет исправление. Строка, чья позиция пришла из памяти компании, при применении сверяется с памятью: памяти нет или она указывает на другую позицию — строка не применяется. Её исход — «Не применено: Сопоставление строки исправил администратор клуба — загрузите прайс заново» (`match_corrected`, ru/kk/en в итоге S-PRICE-04). Предложение, снятое исправлением (`match_corrected`), возвращается в продажу только по «Другой позиции» или «Верно» на этой позиции, выбранным в сверке после исправления. «Верно» после исправления снова пишет память `supplier_ai`, и строка уходит в аудит как новая.
- «Неверно» снимает только предложение, которое сделала строка. Аудит хранит исход строки (`row_outcome`), предложение знает, какой прайс его создал (`offer.created_import_id`). Исход `unchanged` и `updated` предложения, выставленного вручную, — предложение остаётся с причиной `not_by_row`. Причина показана в карточке и итоге A-MOD-04 и в «Исправлениях» S-MOD-01 (ru/kk/en).
- «Поставщики нажали «Верно»: M из N» считается при применении: счётчики лежат на загрузке (`price_import.ai_proposed_rows` / `ai_accepted_rows`), метрика складывает загрузки периода. Старые загрузки досчитывает миграция порциями по 50 загрузок.
- «Неверно» во время применения прайса ждёт блокировку не дольше 1 с, затем отвечает 409 `PRICE_MATCH_AUDIT_BUSY` с `retryable: true`. Админка пишет «Поставщик сейчас применяет прайс, повторите через минуту». Ничего не меняется.
- «Новое» во вкладке «Совместимость» кабинета считается как у «Исправлений»: по моменту, который сводка при открытии назвала просмотренным.

## Changes
- `infra/migrations/1792720000000_price-match-audit-hardening.sql`: `price_match_audit.row_outcome` (с заполнением из строк загрузки), `offer.created_import_id`, `price_import.ai_proposed_rows` / `ai_accepted_rows` (`CHECK`, досчёт циклом по 50 загрузок), индекс `price_import_applied_idx`.
- `packages/domain/src/price-import/price-match-audit.ts`: `priceAuditOfferIsRows`, причина `not_by_row` в `priceAuditOfferVerdict`; факты предложения — `rowOutcome`, `createdByImport`.
- `apps/api/src/modules/price-imports/price-apply-plan.ts`: `rememberedMatchGone`, `mayReturnCorrected`, причина `match_corrected`; в плане появились `decidedAt`, `aiProposed`, `withdrawnAt` и `PlanFacts.memory`.
- `price-review-data.ts`: `rememberedItems` — память ключей строк из памяти, порциями по 5 000 ключей, после блокировки предложений.
- `price-apply-runner.ts`: `created_import_id` у новых предложений; `aiProposals` и счётчики в том же `UPDATE`, что ставит `applied`; `row_outcome` в аудите.
- `price-match-audit.service.ts`: `lock_timeout` и `PRICE_MATCH_AUDIT_BUSY`; метрика по счётчикам загрузок; `keepReason` в «Исправлениях»; факты предложения для правила.
- Контракт: `match_corrected` в `priceRowNotAppliedReasonSchema`, `not_by_row` в `priceMatchAuditKeepReasonSchema`, `SupplierMatchCorrection.keepReason`, код `PRICE_MATCH_AUDIT_BUSY`. Всё аддитивно, `openapi.json` перегенерирован.
- Админка: `match-audit-words.ts` — тексты `not_by_row` и «Поставщик сейчас применяет прайс…».
- Кабинет: `moderation-rules.ts` — `decisionIsNew`, `proposalIsNew`, текст `keptNotByRow`; `Moderation.tsx` — «Совместимость» по `seenAt`; `review-rules.ts` — текст причины. i18n кабинета — два ключа на трёх языках.
- Тесты: доменный (`price-match-audit.test.ts`), план (`price-apply-plan.test.ts`, 4 новых), кабинет (`moderation-rules.test.ts`), админка (`match-audit-words.test.ts`), интеграционный (`price-match-audit.integration.test.ts`, 4 новых сценария). `testing/expected/migrations.ts` — новая миграция.
- `ARCHITECTURE.md` — I1123–I1129 в 4.94; `CLAUDE.md` — «Сверка и применение прайса в dev» и «Аудит сопоставлений в dev».

## Technical Decisions
Внесены в ARCHITECTURE 4.94, I1123–I1129. Версия и история ARCHITECTURE не менялись, таблица 14 — тоже (новых настроек нет).
- Как отличать предложение, созданное прайсом: столбец `offer.created_import_id`, который пишет применение. Старые предложения не размечаются: «нельзя различить» значит «остаётся» (I1126).
- Память читается после блокировки предложений, в том же порядке, в каком «Неверно» берёт блокировки: сначала предложение, потом память (I1123).
- Явное решение «после исправления» определяется сравнением `decided_at` строки с `withdrawn_at` предложения (I1124).
- `lock_timeout` 1 с покрывает все блокировки транзакции «Неверно» (I1128).

## Verification
- `pnpm format:check` — PASS
- `pnpm lint` — PASS (одно предупреждение `isNotNull` в `ratings/supplier-ratings.service.ts` было и до задачи)
- `pnpm typecheck` — PASS
- `pnpm test` (`turbo run test --continue`) — PASS, 19/19 задач: api 1146, domain 1425, supplier-web 174, admin-web 182, contracts 134, mobile 703 и др. Первый прогон `mobile` упал по таймауту файлового теста `no-catalog-without-car` (10,9 с при пределе 5 с) под нагрузкой параллельных интеграционных тестов; мобильное не менялось, повтор — 703/703
- `pnpm build` — PASS, 12/12
- Интеграционные: `price-match-audit.integration.test.ts` — PASS 7/7 (3 прежних + 4 новых); `price-review`, `price-imports`, `price-photos` — PASS 50/50
- `openapi:generate`, `openapi:check` — PASS (файл совпадает с контрактом и маршрутами)
- `openapi:compat --snapshots` — PASS (мобильное 1.0.0); `openapi:compat --base origin/main` — PASS
- Миграция на собственной базе `adclub_t065a` — PASS (`pnpm --filter api migrate`)
- CI — NOT RUN мной (по правилам не жду): прогон **44563689142** на коммите `61ffa5d`. Предыдущий прогон `main` (44549743430, коммит приёмки) был красным — к этой задаче не относится

## UAT / E2E
Экраны в браузере не проходились. Изменения в UI: тексты причин и «новое» во вкладке «Совместимость». Они проверены юнит-тестами логики кабинета и админки, ответы сервера — интеграционными тестами на настоящих PostgreSQL, Redis и MinIO с настоящим worker'ом.

## Acceptance Criteria
- **AC-1 — PASS.** Тест «a price list reviewed before «Неверно» does not bring the corrected match back; an explicit choice does»: две загрузки по памяти ждут сверки, «Неверно» на обеих строках, первая применяется — `notApplied: [{reason: match_corrected, rows: 2}]`, у строк `outcome_reason = match_corrected`, предложения остаются `withdrawn`, память не записана заново. Во второй загрузке «Другая позиция → Alfa» после исправления — `returned: 1`, предложение `active`; Bravo без решения — снова `match_corrected`. Третья загрузка: Bravo идёт к ИИ, «Верно» возвращает предложение, память снова `supplier_ai`, новая строка аудита `pending` с `row_outcome = returned`. Тексты причины — ru/kk/en (`result.reason.matchCorrected`). Юнит-тесты плана: 4 новых теста в `price-apply-plan.test.ts`, всего 18/18.
- **AC-2 — PASS.** Тест ««Неверно» withdraws only the offer the row made»: Alfa (выставлено вручную, исход `unchanged`) и Bravo (вручную, `updated`) — остаются с `keepReason: not_by_row`. Charlie (`created`) и Delta (`updated` по предложению, созданному прайсом, `created_import_id` = id первой загрузки) — сняты. Карточка до решения показывает `willWithdraw: false, keepReason: not_by_row`. У поставщика в «Исправлениях» — `keepReason: not_by_row`, тексты ru/kk/en проверены в `moderation-rules.test.ts`. Доменные случаи — `price-match-audit.test.ts` домена.
- **AC-3 — PASS.** Счётчики пишутся в том же `UPDATE`, что ставит `applied`. Тест «counts «Верно» of suppliers per import…»: независимый подсчёт по строкам (`{proposed: 6, accepted: 3}`) равен сумме счётчиков загрузок и метрике за 7, 30 и 90 дней. Затем счётчики обнуляются, выполняется блок `DO $$` миграции (циклом по 50 загрузок), и метрика снова равна независимому подсчёту. Запрос метрики — `sum` по `price_import` с частичным индексом по `applied_at`, строки прайсов не читает.
- **AC-4 — PASS.** Тест ««Неверно» while the supplier applies a price list»: отдельная транзакция держит `FOR UPDATE` на предложении, «Неверно» получает 409 `PRICE_MATCH_AUDIT_BUSY` с `retryable: true` быстрее 2 с; строка аудита — `pending`, версия 1, память на месте; после отката блокировки «Неверно» проходит. Текст админки — тест `match-audit-words.test.ts`.
- **AC-5 — PASS.** `proposalIsNew` и `decisionIsNew` в `moderation-rules.ts`, вкладка «Совместимость» получает `seenAt` сводки, как «Исправления». Юнит-тест ««новое» of a compatibility proposal»: одобренное и отклонённое после `seenAt` — «новое», ждущее — никогда.
- **AC-6 — PASS.** Проверки — в разделе Verification. CI не ждал, прогон 44563689142.
- **AC-7 — PASS.** ARCHITECTURE: строки I1123–I1129 в 4.94, версия и история не тронуты; таблица 14 без изменений (новых настроек нет). CLAUDE.md: «Сверка и применение прайса в dev» и «Аудит сопоставлений в dev». Отчёт — этот файл.

## Errors & Fixes
None существенных: новые тесты прошли с первого запуска.

## Deviations
- Тексты A-MOD-04 только на русском: админка одноязычная, как и остальные её тексты. В задаче для A-MOD-04 указаны ru/kk/en; на трёх языках — кабинет.
- «Блокировку во время применения» тест создаёт, держа `FOR UPDATE` на предложении в отдельной транзакции: это та же блокировка, что держит применение. Настоящее долгое применение на 50 000 строк не запускалось.

## Known Issues / Risks
- Вкладка «Запросы» кабинета по-прежнему считает «новое» только по серверному `isNew`. Особенность та же, что была у «Совместимости»; в задаче её не было.
- Если память ключа сменилась не исправлением, а другим применённым прайсом с «Другой позицией», исход строки тот же — `match_corrected`, и текст называет администратора. Других путей удалить или сменить память нет.
- Предложения, созданные прайсом до миграции, считаются выставленными вручную. «Неверно» с исходом `updated` по ним оставляет предложение (`not_by_row`).

## Remaining Work
None.

## Future Improvements
- Те же правила «новое» для вкладки «Запросы» (`decisionIsNew`).

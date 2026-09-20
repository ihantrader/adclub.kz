# Сравнение моделей на переводе справочника

Прогон 2026-09-20T19:57:20.973Z — 2026-09-20T20:00:29.643Z. Провайдер: openrouter. Набор: версия 1, 55 текстов, языки kk и en, по 10 текстов в вызове. Словарь терминов: да, 14 пар.

Файл создан командой `pnpm --filter api operator ai:eval:translate`; рядом лежит `.json` с теми же числами и со всеми переводами.

## Цена, время, отказы

| Модель | Цена прогона | Токены вход / выход | Время вызова мин / медиана / макс, с | Вызовов / отказов | Чем кончилось |
|---|---|---|---|---|---|
| `google/gemini-3.8-flash` | $0.021010 | 6112 / 4380 | 3.7 / 5.4 / 11.1 | 6 / 0 | ответила на всё |
| `openai/gpt-5.4-mini` | $0.013764 | 5463 / 2148 | 1.9 / 2.2 / 2.6 | 6 / 0 | ответила на всё |
| `z-ai/glm-5.3-flash` | $0.004257 | 5360 / 6904 | 8.2 / 17.3 / 50.5 | 6 / 0 | ответила на всё |

## Машинные проверки

| Модель | Ответила текстов | Проблемных текстов | missing | empty | too_long | control_characters | wrong_language | untranslated | russism | inconsistent_term | term_absent | duplicate | lowercase_name | Казахских букв | Title Case (en) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `google/gemini-3.8-flash` | 110 / 110 | 6 (6%) | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 62% | 18% |
| `openai/gpt-5.4-mini` | 110 / 110 | 9 (8%) | 0 | 0 | 0 | 0 | 0 | 9 | 0 | 0 | 0 | 0 | 0 | 60% | 17% |
| `z-ai/glm-5.3-flash` | 110 / 110 | 8 (7%) | 0 | 0 | 0 | 0 | 0 | 8 | 0 | 0 | 0 | 0 | 0 | 58% | 11% |

Проверки не оценивают смысл: `empty`, `too_long`, `control_characters`, `wrong_language` — то, что рабочий перевод отклоняет и не сохраняет; `untranslated` — казахский текст совпал с русским; `russism` — русская основа из словаря осталась внутри казахского названия; `inconsistent_term` — названия, которые передали термин не так, как большинство остальных; `term_absent` — известного написания термина в названии нет (может быть и синоним); `duplicate` — имя занято соседом. Доля казахских букв и Title Case — наблюдения, не ошибки.

### Что нашли проверки: `google/gemini-3.8-flash`

| Проверка | Язык | Пример | Русский | Что не так |
|---|---|---|---|---|
| untranslated | kk | cat-interior | Салон | left as the Russian text: "Салон" |
| untranslated | kk | cat-diagnostics | Диагностика | left as the Russian text: "Диагностика" |
| untranslated | kk | opt-synthetic | Синтетика | left as the Russian text: "Синтетика" |
| untranslated | kk | attr-axle | Ось | left as the Russian text: "Ось" |
| untranslated | kk | attr-material | Материал | left as the Russian text: "Материал" |
| untranslated | kk | opt-ceramic | Керамика | left as the Russian text: "Керамика" |

### Что нашли проверки: `openai/gpt-5.4-mini`

| Проверка | Язык | Пример | Русский | Что не так |
|---|---|---|---|---|
| untranslated | kk | cat-body | Кузов | left as the Russian text: "Кузов" |
| untranslated | kk | cat-electrics | Электрика | left as the Russian text: "Электрика" |
| untranslated | kk | cat-interior | Салон | left as the Russian text: "Салон" |
| untranslated | kk | cat-diagnostics | Диагностика | left as the Russian text: "Диагностика" |
| untranslated | kk | attr-approval | Допуск | left as the Russian text: "Допуск" |
| untranslated | kk | opt-synthetic | Синтетика | left as the Russian text: "Синтетика" |
| untranslated | kk | attr-axle | Ось | left as the Russian text: "Ось" |
| untranslated | kk | attr-material | Материал | left as the Russian text: "Материал" |
| untranslated | kk | opt-ceramic | Керамика | left as the Russian text: "Керамика" |

### Что нашли проверки: `z-ai/glm-5.3-flash`

| Проверка | Язык | Пример | Русский | Что не так |
|---|---|---|---|---|
| untranslated | kk | cat-body | Кузов | left as the Russian text: "Кузов" |
| untranslated | kk | cat-electrics | Электрика | left as the Russian text: "Электрика" |
| untranslated | kk | cat-interior | Салон | left as the Russian text: "Салон" |
| untranslated | kk | cat-diagnostics | Диагностика | left as the Russian text: "Диагностика" |
| untranslated | kk | opt-synthetic | Синтетика | left as the Russian text: "Синтетика" |
| untranslated | kk | attr-axle | Ось | left as the Russian text: "Ось" |
| untranslated | kk | attr-material | Материал | left as the Russian text: "Материал" |
| untranslated | kk | opt-ceramic | Керамика | left as the Russian text: "Керамика" |


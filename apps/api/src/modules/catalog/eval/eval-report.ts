import type { EvalModelResult, EvalRun } from "./eval-runner";
import { qualityChecks, type QualityCheck } from "./translation-quality";

/**
 * A saved run as a table to read (TASK-053.B requirement 6). The JSON
 * next to it holds everything, including the texts; this is what a person
 * opens to compare models, and what the next review compares against.
 */

function money(value: number): string {
  return `$${value.toFixed(6)}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** What stopped a model, in words, or how much of the set it answered. */
function outcomeOf(result: EvalModelResult): string {
  if (result.quality === null) {
    const kinds = [...new Set(result.failures.map((failure) => failure.kind))];
    return `не отвечала (${kinds.join(", ") || "нет ответа"})`;
  }
  const kinds = [...new Set(result.failures.map((failure) => failure.kind))];
  return kinds.length === 0 ? "ответила на всё" : `частично (${kinds.join(", ")})`;
}

export function renderEvalRun(run: EvalRun): string {
  const lines: string[] = [];
  lines.push(`# Сравнение моделей на переводе справочника`);
  lines.push("");
  lines.push(
    `Прогон ${run.startedAt} — ${run.finishedAt}. Провайдер: ${run.provider}. Набор: версия ${run.dataVersion}, ${run.samples} текстов, языки ${run.options.languages.join(" и ")}, по ${run.options.batchSize} текстов в вызове. Словарь терминов: ${run.options.glossary ? `да, ${run.glossaryTerms} пар` : "нет"}.`,
  );
  lines.push("");
  lines.push(
    "Файл создан командой `pnpm --filter api operator ai:eval:translate`; рядом лежит `.json` с теми же числами и со всеми переводами.",
  );
  lines.push("");

  lines.push("## Цена, время, отказы");
  lines.push("");
  lines.push(
    "| Модель | Цена прогона | Токены вход / выход | Время вызова мин / медиана / макс, с | Вызовов / отказов | Чем кончилось |",
  );
  lines.push("|---|---|---|---|---|---|");
  for (const result of run.results) {
    const latency = [result.latencyMs.min, result.latencyMs.median, result.latencyMs.max]
      .map((value) => (value / 1000).toFixed(1))
      .join(" / ");
    lines.push(
      `| \`${result.model}\` | ${money(result.costUsd)}${result.costIsEstimate ? " (оценка)" : ""} | ${result.tokensIn} / ${result.tokensOut} | ${latency} | ${result.calls} / ${result.failedCalls} | ${outcomeOf(result)} |`,
    );
  }
  lines.push("");

  lines.push("## Машинные проверки");
  lines.push("");
  lines.push(
    `| Модель | Ответила текстов | Проблемных текстов | ${qualityChecks.join(" | ")} | Казахских букв | Title Case (en) |`,
  );
  lines.push(`|---|---|---|${qualityChecks.map(() => "---").join("|")}|---|---|`);
  for (const result of run.results) {
    const quality = result.quality;
    if (quality === null) {
      lines.push(
        `| \`${result.model}\` | — | — | ${qualityChecks.map(() => "—").join(" | ")} | — | — |`,
      );
      continue;
    }
    const counts = qualityChecks
      .map((check: QualityCheck) => String(quality.counts[check]))
      .join(" | ");
    lines.push(
      `| \`${result.model}\` | ${quality.answered} / ${quality.expected} | ${quality.problemTexts} (${percent(quality.problemShare)}) | ${counts} | ${percent(quality.observations.kazakhLetterShare)} | ${percent(quality.observations.enTitleCaseShare)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Проверки не оценивают смысл: `empty`, `too_long`, `control_characters`, `wrong_language` — то, что рабочий перевод отклоняет и не сохраняет; `untranslated` — казахский текст совпал с русским; `russism` — русская основа из словаря осталась внутри казахского названия; `inconsistent_term` — названия, которые передали термин не так, как большинство остальных; `term_absent` — известного написания термина в названии нет (может быть и синоним); `duplicate` — имя занято соседом. Доля казахских букв и Title Case — наблюдения, не ошибки.",
  );
  lines.push("");

  for (const result of run.results) {
    if (result.quality === null || result.quality.findings.length === 0) {
      continue;
    }
    lines.push(`### Что нашли проверки: \`${result.model}\``);
    lines.push("");
    lines.push("| Проверка | Язык | Пример | Русский | Что не так |");
    lines.push("|---|---|---|---|---|");
    for (const finding of result.quality.findings) {
      lines.push(
        `| ${finding.check} | ${finding.lang} | ${finding.sampleId} | ${finding.source} | ${finding.detail.replaceAll("|", "\\|")} |`,
      );
    }
    lines.push("");
  }

  if (run.results.some((result) => result.failures.length > 0)) {
    lines.push("## Отказы");
    lines.push("");
    lines.push("| Модель | Пакет | Вид отказа | Что ответил провайдер |");
    lines.push("|---|---|---|---|");
    for (const result of run.results) {
      for (const failure of result.failures) {
        lines.push(
          `| \`${result.model}\` | ${failure.batch} | ${failure.kind} | ${failure.message.replaceAll("|", "\\|")} |`,
        );
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * The translations of the named models side by side, for a person who
 * knows Kazakh to read (requirement 4). `sampleIds` keeps the comparison
 * to the same texts for every model.
 */
export function renderTranslationTable(
  run: EvalRun,
  models: string[],
  samples: { id: string; text: string }[],
): string {
  const lines: string[] = [];
  const results = models.map((model) => run.results.find((result) => result.model === model));
  lines.push(`| Русский | ${models.map((model) => `${model} (kk / en)`).join(" | ")} |`);
  lines.push(`|---|${models.map(() => "---").join("|")}|`);
  for (const sample of samples) {
    const cells = results.map((result) => {
      const kk = result?.texts[`${sample.id}:kk`] ?? "—";
      const en = result?.texts[`${sample.id}:en`] ?? "—";
      return `${kk} / ${en}`;
    });
    lines.push(`| ${sample.text} | ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

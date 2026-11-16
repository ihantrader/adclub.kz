import type { SpeechEvalRun } from "./speech-eval-runner";
import { SPEECH_ARTICLE_THRESHOLD, SPEECH_RU_WER_THRESHOLD } from "./speech-eval-score";

/** A saved run as a table to read (TASK-059); the JSON next to it holds everything. */

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export function renderSpeechEvalRun(run: SpeechEvalRun): string {
  const lines: string[] = [];
  lines.push("# Сравнение моделей на распознавании речи (голосовой ввод)");
  lines.push("");
  lines.push(
    `Прогон ${run.startedAt} — ${run.finishedAt}. Провайдер: ${run.provider}. Набор: ${run.set === "synthetic" ? "синтетический (`ai-eval/speech/samples.json`, голоса Windows, русский и английский)" : "живые записи (`ai-eval/speech/recordings/`)"}, версия ${run.dataVersion}, записей: ${run.samples}. Язык интерфейса, переданный подсказкой: ${run.languageHint}.`,
  );
  lines.push("");
  lines.push(
    `Порог (D-058, TASK-059): артикул точно ≥ ${percent(SPEECH_ARTICLE_THRESHOLD)}, WER на русском ≤ ${percent(SPEECH_RU_WER_THRESHOLD)}; казахский и смешанная речь — по живому набору. Файл создан командой \`pnpm --filter api operator ai:eval:speech\`; рядом — \`.json\` со всеми ответами.`,
  );
  lines.push("");
  lines.push("## Итог");
  lines.push("");
  const langs = [...new Set(run.results.flatMap((result) => Object.keys(result.score.werByLang)))]
    .filter((lang) => lang !== "none")
    .sort();
  lines.push(
    `| Модель | Порог | ${langs.map((lang) => `WER ${lang}`).join(" | ")} | Артикул точно | Тишина и шум — пусто | Цена за запрос | Цена прогона | Время мин / медиана / макс, с | Вызовов / отказов |`,
  );
  lines.push(`|---|---|${langs.map(() => "---|").join("")}---|---|---|---|---|---|`);
  for (const result of run.results) {
    const score = result.score;
    const latency = [result.latencyMs.min, result.latencyMs.median, result.latencyMs.max]
      .map((value) => (value / 1000).toFixed(1))
      .join(" / ");
    const wer = langs
      .map((lang) => {
        const bucket = score.werByLang[lang];
        return bucket ? `${percent(bucket.rate)} (${bucket.errors}/${bucket.words})` : "—";
      })
      .join(" | ");
    lines.push(
      `| \`${result.model}\` | ${score.passes ? "проходит" : "нет"} | ${wer} | ${score.articles.exact}/${score.articles.total} (${percent(score.articles.share)}) | ${score.silence.empty}/${score.silence.total} | $${result.costPerRequestUsd.toFixed(7)} | $${result.costUsd.toFixed(6)}${result.costIsEstimate ? " (оценка)" : ""} | ${latency} | ${result.calls} / ${result.failures.length} |`,
    );
  }
  for (const result of run.results) {
    lines.push("");
    lines.push(`## \`${result.model}\``);
    lines.push("");
    if (result.answeredBy.length > 0) {
      lines.push(`Отвечала: ${result.answeredBy.map((model) => `\`${model}\``).join(", ")}.`);
      lines.push("");
    }
    if (result.failures.length > 0) {
      lines.push("Отказы:");
      for (const failure of result.failures) {
        lines.push(`- ${failure.sampleId}: ${failure.kind} — ${failure.message}`);
      }
      lines.push("");
    }
    if (result.calls === result.failures.length) {
      lines.push("Модель не ответила ни на одну запись — оценки нет.");
    } else if (result.score.misses.length === 0) {
      lines.push("Ошибок нет.");
    } else {
      lines.push("| Запись | Услышано | WER | Артикул |");
      lines.push("|---|---|---|---|");
      for (const miss of result.score.misses) {
        lines.push(
          `| ${miss.id} | ${miss.heard.replace(/\|/gu, "\\|") || "(пусто)"} | ${percent(miss.wer)} | ${miss.article === undefined ? "" : miss.article ? "да" : "нет"} |`,
        );
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

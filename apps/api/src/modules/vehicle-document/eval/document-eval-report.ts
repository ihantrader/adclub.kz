import type { DocumentEvalRun } from "./document-eval-runner";
import { DOCUMENT_FIELDS, DOCUMENT_THRESHOLD } from "./document-eval-score";

/** A saved run as a table to read (TASK-057 requirement 2); the JSON next to it holds everything. */

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

const FIELD_TITLE: Record<(typeof DOCUMENT_FIELDS)[number], string> = {
  make: "Марка",
  model: "Модель",
  year: "Год",
  vin: "VIN",
  plate: "Госномер",
  engineVolumeCc: "Объём",
  color: "Цвет",
};

export function renderDocumentEvalRun(run: DocumentEvalRun): string {
  const lines: string[] = [];
  lines.push("# Сравнение моделей на распознавании техпаспорта");
  lines.push("");
  lines.push(
    `Прогон ${run.startedAt} — ${run.finishedAt}. Провайдер: ${run.provider}. Набор: версия ${run.dataVersion}, ${run.samples} синтетических снимков с выдуманными данными (\`ai-eval/vehicle-document/samples.json\`).`,
  );
  lines.push("");
  lines.push(
    `Порог (D-058, TASK-057): VIN и госномер ≥ ${percent(DOCUMENT_THRESHOLD.vin)} на читаемых снимках, вид документа ≥ ${percent(DOCUMENT_THRESHOLD.kind)} на всём наборе. Файл создан командой \`pnpm --filter api operator ai:eval:vehicle-document\`; рядом — \`.json\` со всеми ответами.`,
  );
  lines.push("");
  lines.push("## Итог");
  lines.push("");
  lines.push(
    "| Модель | Порог | Вид документа | VIN | Госномер | Отказ на чужом | Угадан скрытый VIN | Цена за скан | Цена прогона | Время мин / медиана / макс, с | Вызовов / отказов |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const result of run.results) {
    const { score } = result;
    const latency = [result.latencyMs.min, result.latencyMs.median, result.latencyMs.max]
      .map((value) => (value / 1000).toFixed(1))
      .join(" / ");
    lines.push(
      `| \`${result.model}\` | ${score.passes ? "проходит" : "нет"} | ${score.kind.correct}/${score.kind.total} (${percent(score.kind.share)}) | ${score.fields.vin.correct}/${score.fields.vin.total} (${percent(score.fields.vin.share)}) | ${score.fields.plate.correct}/${score.fields.plate.total} (${percent(score.fields.plate.share)}) | ${score.foreign.refused}/${score.foreign.total} | ${score.guessedHiddenVin} | $${result.costPerScanUsd.toFixed(6)} | $${result.costUsd.toFixed(6)}${result.costIsEstimate ? " (оценка)" : ""} | ${latency} | ${result.calls} / ${result.failures.length} |`,
    );
  }
  lines.push("");
  lines.push("## Точность по полям (читаемые техпаспорта)");
  lines.push("");
  lines.push(`| Модель | ${DOCUMENT_FIELDS.map((field) => FIELD_TITLE[field]).join(" | ")} |`);
  lines.push(`|---|${DOCUMENT_FIELDS.map(() => "---").join("|")}|`);
  for (const result of run.results) {
    lines.push(
      `| \`${result.model}\` | ${DOCUMENT_FIELDS.map((field) => {
        const value = result.score.fields[field];
        return `${value.correct}/${value.total}`;
      }).join(" | ")} |`,
    );
  }
  lines.push("");
  for (const result of run.results) {
    if (result.score.misses.length === 0 && result.failures.length === 0) continue;
    lines.push(`### Ошибки: \`${result.model}\``);
    lines.push("");
    if (result.score.misses.length > 0) {
      lines.push("| Снимок | Что | Ожидалось | Ответила |");
      lines.push("|---|---|---|---|");
      for (const miss of result.score.misses) {
        lines.push(
          `| ${miss.sampleId} | ${miss.what} | ${miss.expected} | ${miss.got.replaceAll("|", "\\|")} |`,
        );
      }
      lines.push("");
    }
    if (result.failures.length > 0) {
      lines.push("| Снимок | Отказ | Что ответил провайдер |");
      lines.push("|---|---|---|");
      for (const failure of result.failures) {
        lines.push(
          `| ${failure.sampleId} | ${failure.kind} | ${failure.message.replaceAll("|", "\\|")} |`,
        );
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

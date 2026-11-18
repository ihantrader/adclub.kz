import type { PhotoEvalRun } from "./photo-eval-runner";
import {
  DASHBOARD_THRESHOLD,
  PART_THRESHOLD,
  type DashboardScore,
  type PartScore,
  type Share,
} from "./photo-eval-score";
import { PRICE_PHOTO_THRESHOLD, type PricePhotoScore } from "./price-photo-score";

/** A saved run as a table to read (TASK-058); the JSON next to it holds everything. */

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function ratio(value: Share): string {
  return `${value.correct}/${value.total} (${percent(value.share)})`;
}

/** The photographed price pages (TASK-064): rows, not one value. */
function renderPricePhotoRun(run: PhotoEvalRun): string {
  const lines: string[] = [
    "# Сравнение моделей на чтении фото прайса",
    "",
    `Прогон ${run.startedAt} — ${run.finishedAt}. Провайдер: ${run.provider}. Набор: версия ${run.dataVersion}, ${run.samples} синтетических страниц (\`ai-eval/price-photo/samples.json\`).`,
    "",
    `Порог (D-058, TASK-064, ARCHITECTURE 4.93): артикул и цена точно ≥ ${percent(PRICE_PHOTO_THRESHOLD.exact)} строк читаемых страниц, ложных строк ≤ ${percent(PRICE_PHOTO_THRESHOLD.falseRows)} выданных, «не таблица» — без строк на каждой такой странице. Файл создан командой \`pnpm --filter api operator ai:eval:price-photo\`; рядом — \`.json\` со всеми ответами.`,
    "",
    "## Итог",
    "",
    "| Модель | Порог | Артикул и цена точно | Пропущено строк | Ложные строки | Отказ на «не таблица» | Сомнение отмечено | Тихие ошибки цены | Цена за страницу | Цена прогона | Время мин / медиана / макс, с | Вызовов / отказов |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const result of run.results) {
    const score = result.score as PricePhotoScore;
    const latency = [result.latencyMs.min, result.latencyMs.median, result.latencyMs.max]
      .map((value) => (value / 1000).toFixed(1))
      .join(" / ");
    lines.push(
      `| \`${result.model}\` | ${score.passes ? "проходит" : "нет"} | ${ratio(score.exact)} | ${score.missed} | ${ratio(score.falseRows)} | ${ratio(score.refusal)} | ${ratio(score.doubtMarked)} | ${score.silentErrors} | $${result.costPerScanUsd.toFixed(6)} | $${result.costUsd.toFixed(6)}${result.costIsEstimate ? " (оценка)" : ""} | ${latency} | ${result.calls} / ${result.failures.length} |`,
    );
  }
  lines.push("");
  for (const result of run.results) {
    if (result.score.misses.length === 0 && result.failures.length === 0) continue;
    lines.push(`### Ошибки: \`${result.model}\``, "");
    if (result.score.misses.length > 0) {
      lines.push("| Страница | Что | Ожидалось | Ответила |", "|---|---|---|---|");
      for (const miss of result.score.misses) {
        lines.push(
          `| ${miss.sampleId} | ${miss.what} | ${miss.expected.replaceAll("|", "\\|")} | ${miss.got.replaceAll("|", "\\|")} |`,
        );
      }
      lines.push("");
    }
    if (result.failures.length > 0) {
      lines.push("| Страница | Отказ | Что ответил провайдер |", "|---|---|---|");
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

export function renderPhotoEvalRun(run: PhotoEvalRun): string {
  if (run.kind === "price-photo") return renderPricePhotoRun(run);
  const dashboard = run.kind === "dashboard";
  const lines: string[] = [];
  lines.push(
    dashboard
      ? "# Сравнение моделей на чтении пробега с приборной панели"
      : "# Сравнение моделей на чтении артикула с фото детали",
  );
  lines.push("");
  lines.push(
    `Прогон ${run.startedAt} — ${run.finishedAt}. Провайдер: ${run.provider}. Набор: версия ${run.dataVersion}, ${run.samples} синтетических снимков (\`ai-eval/${run.kind}/samples.json\`).`,
  );
  lines.push("");
  lines.push(
    dashboard
      ? `Порог (D-058, TASK-058): точное значение пробега ≥ ${percent(DASHBOARD_THRESHOLD.value)} на читаемых панелях, отказ на «не панель» ≥ ${percent(DASHBOARD_THRESHOLD.refusal)}. Файл создан командой \`pnpm --filter api operator ai:eval:dashboard\`; рядом — \`.json\` со всеми ответами.`
      : `Порог (D-058, TASK-058): точный артикул ≥ ${percent(PART_THRESHOLD.article)} на читаемых этикетках, ложный артикул ≤ ${percent(PART_THRESHOLD.falseArticle)} на всём наборе. Файл создан командой \`pnpm --filter api operator ai:eval:part-photo\`; рядом — \`.json\` со всеми ответами.`,
  );
  lines.push("");
  lines.push("## Итог");
  lines.push("");
  lines.push(
    dashboard
      ? "| Модель | Порог | Пробег точно | Отказ на «не панель» | Ложные значения на нечитаемых | Угадано скрытое | Цена за скан | Цена прогона | Время мин / медиана / макс, с | Вызовов / отказов |"
      : "| Модель | Порог | Артикул точно | Ложный артикул | Второй артикул | Без артикула — без ответа | Угадан скрытый | Цена за скан | Цена прогона | Время мин / медиана / макс, с | Вызовов / отказов |",
  );
  lines.push(
    dashboard
      ? "|---|---|---|---|---|---|---|---|---|---|"
      : "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const result of run.results) {
    const latency = [result.latencyMs.min, result.latencyMs.median, result.latencyMs.max]
      .map((value) => (value / 1000).toFixed(1))
      .join(" / ");
    const money = `$${result.costPerScanUsd.toFixed(6)} | $${result.costUsd.toFixed(6)}${result.costIsEstimate ? " (оценка)" : ""}`;
    if (dashboard) {
      const score = result.score as DashboardScore;
      lines.push(
        `| \`${result.model}\` | ${score.passes ? "проходит" : "нет"} | ${ratio(score.value)} | ${ratio(score.refusal)} | ${ratio(score.falseValues)} | ${score.guessedHidden} | ${money} | ${latency} | ${result.calls} / ${result.failures.length} |`,
      );
    } else {
      const score = result.score as PartScore;
      lines.push(
        `| \`${result.model}\` | ${score.passes ? "проходит" : "нет"} | ${ratio(score.article)} | ${ratio(score.falseArticle)} | ${ratio(score.secondArticle)} | ${ratio(score.noArticle)} | ${score.guessedHidden} | ${money} | ${latency} | ${result.calls} / ${result.failures.length} |`,
      );
    }
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

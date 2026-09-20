import { AI_MODELS, type AiUsage } from "./ai-gateway";

/**
 * Prices per million tokens, USD, input and output (ARCHITECTURE 9.6, the
 * table "Модели и цены", checked against Anthropic's list in 2026-06 —
 * an assumption until TASK-055 sets up real spending control). A price
 * list of this kind goes stale: a model missing here has an unknown cost
 * (`null`) rather than a made-up one, and the daily budget counts it as
 * nothing.
 */
const PRICES_PER_MILLION: Record<string, { input: number; output: number }> = {
  [AI_MODELS.advanced]: { input: 5, output: 25 },
  [AI_MODELS.standard]: { input: 2, output: 10 },
  [AI_MODELS.light]: { input: 1, output: 5 },
};

/** The cost of a call in USD, rounded to a millionth of a dollar; `null` for an unknown model. */
export function estimateCostUsd(
  model: string,
  usage: Pick<AiUsage, "tokensIn" | "tokensOut">,
): number | null {
  const price = PRICES_PER_MILLION[model];
  if (!price) {
    return null;
  }
  const cost = (usage.tokensIn * price.input + usage.tokensOut * price.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

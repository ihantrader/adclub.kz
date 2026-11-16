import { readWav } from "@adclub/domain";

/**
 * What the test AI provider hears in the synthetic speech samples of
 * TASK-059 (`ai-eval/speech/samples`, written by `scripts/speech-samples.mjs`),
 * by the code in their `ICMT` chunk («adclub-speech-sample:N»). A recording
 * without it — any real recording in development — is heard as nothing.
 * `speech-fixtures.test.ts` checks this table against `samples.json`.
 *
 * Some answers are written as a model writes them — a capital, a full stop,
 * a service mark, quotes — so the server's cleaning has something to do.
 */
export const TEST_SPEECH: Readonly<Record<number, string>> = {
  1: "Колодки на атлас.",
  2: "Тормозные колодки для Geely Atlas",
  3: "Моторное масло 5W-30",
  4: "замена масла",
  5: "Салонный фильтр на Coolray",
  6: "свечи зажигания",
  7: "Аккумулятор 60 ампер",
  8: "Зимние шины 215/65 R17",
  9: "Пробег 45 200 километров",
  10: "Передний амортизатор",
  11: "Антифриз зелёный",
  12: "Щётки стеклоочистителя",
  13: "04465 0K090",
  14: "4050068800",
  15: "Компьютерная диагностика двигателя",
  16: "[шум двигателя] колодки на атлас",
  17: "04465-0K090",
  20: "Brake pads for Geely Atlas.",
  21: "Engine oil 5W-30",
  22: "Air filter",
  23: "Spark plugs for Coolray",
  24: "GDB3534",
  25: "MAN 67527",
  30: "",
  31: "(шум)",
};

const MARKER = /^adclub-speech-sample:(\d+)$/u;

/** The code of a synthetic sample, `null` for anything else. */
export function speechSampleCode(audio: Uint8Array): number | null {
  const read = readWav(audio);
  if (!read.ok || read.wav.comment === null) return null;
  const match = MARKER.exec(read.wav.comment);
  return match ? Number(match[1]) : null;
}

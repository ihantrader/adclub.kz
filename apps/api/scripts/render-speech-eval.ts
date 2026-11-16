// Renders the `.md` table of saved voice-input comparisons again from their
// `.json` (TASK-059): the report changed, the runs did not — nothing is called.
// Usage: pnpm --filter @adclub/api exec tsx scripts/render-speech-eval.ts <name> [<name> …]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { speechEvalDirectory } from "../src/modules/speech/eval/speech-eval-runner";
import { renderSpeechEvalRun } from "../src/modules/speech/eval/speech-eval-report";
import type { SpeechEvalRun } from "../src/modules/speech/eval/speech-eval-runner";

for (const name of process.argv.slice(2)) {
  const directory = join(speechEvalDirectory(), "results");
  const run = JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8")) as SpeechEvalRun;
  writeFileSync(join(directory, `${name}.md`), renderSpeechEvalRun(run), "utf8");
  console.log(`rendered ${name}.md`);
}

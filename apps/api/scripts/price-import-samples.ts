import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PRICE_SAMPLE_FILES } from "../src/modules/price-imports/testing/price-samples";

/**
 * Writes the example price lists of `apps/api/fixtures/price-imports`
 * (TASK-046 AC-5) from the builders the tests use; `--check` fails if a
 * committed file differs from what the builders give.
 */

const DIR = resolve(__dirname, "..", "fixtures", "price-imports");
const check = process.argv.includes("--check");

mkdirSync(DIR, { recursive: true });
let stale = 0;
for (const sample of PRICE_SAMPLE_FILES) {
  const path = resolve(DIR, sample.file);
  const bytes = sample.build();
  if (check) {
    let current: Buffer | null;
    try {
      current = readFileSync(path);
    } catch {
      current = null;
    }
    if (!current || !current.equals(bytes)) {
      stale++;
      console.error(`stale: ${sample.file}`);
    }
  } else {
    writeFileSync(path, bytes);
    console.log(`${sample.file} ${String(bytes.length)} bytes`);
  }
}
if (stale > 0) {
  console.error("Run: pnpm --filter @adclub/api price-imports:samples");
  process.exit(1);
}

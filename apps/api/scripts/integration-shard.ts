import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  listIntegrationFiles,
  parseShard,
  partitionProblems,
  planShards,
  shardLoad,
} from "../src/testing/integration-shards";

/**
 * Runs one part of the integration tests (TASK-076):
 *
 *   tsx scripts/integration-shard.ts run <index>/<count>     run the part
 *   tsx scripts/integration-shard.ts list <index>/<count>    print its files
 *   tsx scripts/integration-shard.ts check <count>           every file in exactly one part
 *
 * Before a part runs, the whole split is checked: if a file were missing
 * from all parts or in two, the part refuses to run and CI fails.
 */

const apiRoot = resolve(__dirname, "..");

function plan(count: number): { files: string[]; parts: string[][] } {
  const files = listIntegrationFiles(apiRoot);
  const parts = planShards(files, count);
  const problems = partitionProblems(files, parts);
  if (problems.length > 0 || files.length === 0) {
    throw new Error(`The integration tests are not split whole:\n${problems.join("\n")}`);
  }
  return { files, parts };
}

async function main(): Promise<number> {
  const [command, argument] = process.argv.slice(2);
  if (command === "check") {
    const { files, parts } = plan(Number(argument));
    console.log(
      `${files.length} integration test files in ${parts.length} parts: ${parts
        .map((part) => `${part.length} files / ~${shardLoad(part)} s`)
        .join(", ")}`,
    );
    return 0;
  }
  if (command !== "run" && command !== "list") {
    throw new Error("Usage: integration-shard.ts run|list <index>/<count>, or check <count>");
  }
  const { index, count } = parseShard(argument ?? "");
  const files = plan(count).parts[index - 1]!;
  if (command === "list") {
    console.log(files.join("\n"));
    return 0;
  }
  console.log(`Integration tests, part ${index}/${count}: ${files.length} files`);
  for (const file of files) {
    console.log(`  ${file}`);
  }
  const vitest = resolve(
    dirname(createRequire(__filename).resolve("vitest/package.json")),
    "vitest.mjs",
  );
  const child = spawn(
    process.execPath,
    [vitest, "run", "--config", "vitest.integration.config.ts", ...files],
    { cwd: apiRoot, stdio: "inherit" },
  );
  return new Promise((done) => {
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);

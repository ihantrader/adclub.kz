import "reflect-metadata";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { apiRoutes, buildOpenApiDocument } from "@adclub/contracts";
import { AppModule } from "../src/app.module";
import { listServedRoutes } from "../src/common/contract";
import { checkServedRoutesMatchContract, routeListingConfig } from "../src/openapi";

/**
 * `generate`: writes `apps/api/openapi.json` from `@adclub/contracts`.
 * `check`: fails if the committed file is stale (ARCHITECTURE 7.2).
 *
 * Both first boot the real `AppModule` (production mode, dependencies
 * pointed at closed local ports — nothing needs to be running) and
 * compare the routes Express actually serves with `apiRoutes`, so the
 * document can't describe routes the server doesn't have, or miss ones
 * it does.
 */

const SPEC_PATH = resolve(__dirname, "..", "openapi.json");
const GENERATE_COMMAND = "pnpm --filter @adclub/api openapi:generate";

async function listProductionRoutes() {
  const app = await NestFactory.create(AppModule.forRoot(routeListingConfig("production")), {
    logger: false,
  });
  try {
    await app.init();
    return listServedRoutes(app);
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "generate" && mode !== "check") {
    throw new Error("Usage: tsx scripts/openapi.ts <generate|check>");
  }

  const routes = Object.values(apiRoutes);
  const problems = checkServedRoutesMatchContract(await listProductionRoutes(), routes);
  if (problems.length > 0) {
    console.error("Server routes and the contract (apiRoutes) disagree:");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  const generated = `${JSON.stringify(buildOpenApiDocument(routes), null, 2)}\n`;

  if (mode === "generate") {
    writeFileSync(SPEC_PATH, generated);
    console.log(`Wrote ${SPEC_PATH}`);
    return;
  }

  let committed: string;
  try {
    committed = readFileSync(SPEC_PATH, "utf8").replace(/\r\n/g, "\n");
  } catch {
    console.error(`${SPEC_PATH} is missing. Run: ${GENERATE_COMMAND}`);
    process.exitCode = 1;
    return;
  }
  if (committed !== generated) {
    console.error(
      `${SPEC_PATH} is out of date with @adclub/contracts. Run: ${GENERATE_COMMAND} and commit the result.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`${SPEC_PATH} matches the contract and the served routes.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

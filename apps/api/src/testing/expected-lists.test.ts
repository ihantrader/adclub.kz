import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { apiRoutes } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { backgroundJobCatalog } from "../background-jobs";
import { defaultSettingValues } from "../modules/settings";
import { ADMIN_ROUTES } from "./expected/admin-routes";
import { EXPECTED_JOB_NAMES, EXPECTED_PERIODIC_SCHEDULES } from "./expected/background-jobs";
import { EXPECTED_MIGRATIONS } from "./expected/migrations";

/**
 * The integration tests compare a few complete lists — the admin routes, the
 * background jobs and their schedules, the migrations — with what the
 * application has. They run only in CI, where a missing line used to turn
 * the first run red. The same comparison is made here, with no containers,
 * so `pnpm test` shows it before the push (TASK-076).
 *
 * A failure here means: add the new route, job or migration to the list in
 * `src/testing/expected/`.
 */
describe("the complete lists the integration tests compare", () => {
  it("lists every /admin route of the contract (identity/access.integration.test.ts)", () => {
    const actual = Object.values(apiRoutes)
      .filter((route) => route.path.startsWith("/admin"))
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect([...ADMIN_ROUTES]).toEqual(actual);
  });

  it("lists every background job in the order of the catalog (sign-in-data-cleanup.integration.test.ts)", () => {
    const catalog = backgroundJobCatalog({ nodeEnv: "test" });
    expect([...EXPECTED_JOB_NAMES]).toEqual(catalog.map((job) => job.name));
  });

  it("lists the schedule of every periodic job with the default settings", async () => {
    const settings = defaultSettingValues();
    const reader = async <Key extends keyof typeof settings>(key: Key) => settings[key];
    const actual: { name: string; cron: string; timezone: string }[] = [];
    for (const job of backgroundJobCatalog({ nodeEnv: "test" })) {
      if (job.kind === "periodic") {
        actual.push({
          name: job.name,
          cron: await job.schedule(reader),
          timezone: "Asia/Almaty",
        });
      }
    }
    actual.sort((a, b) => a.name.localeCompare(b.name));
    expect([...EXPECTED_PERIODIC_SCHEDULES]).toEqual(actual);
  });

  it("lists every migration file of infra/migrations in the order they are applied (database.integration.test.ts)", () => {
    const files = readdirSync(resolve(__dirname, "../../../../infra/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.slice(0, -".sql".length))
      .sort();
    expect([...EXPECTED_MIGRATIONS]).toEqual(files);
  });
});

import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

/**
 * Loads the repo-root `.env` (never committed) into `process.env` before
 * anything reads configuration. Safe to call in every environment: values
 * already set in `process.env` are never overwritten, and a missing file
 * (staging/prod, where env vars come from the platform) is a silent no-op.
 *
 * Resolved relative to this file's location, not `process.cwd()`, because
 * pnpm/Turborepo run `apps/api` scripts with `apps/api` as the working
 * directory, not the repo root.
 */
export function loadEnvFile(): void {
  // `quiet: true`: dotenv otherwise prints a banner (with a random,
  // occasionally promotional tip) on every boot — noise we don't want in
  // production logs.
  loadDotenv({ path: resolve(__dirname, "..", "..", "..", "..", ".env"), quiet: true });
}

import { loadConfig, type AppConfig } from "../config";

/**
 * Config to boot `AppModule` only to list the routes production serves
 * (`openapi:generate`/`openapi:check`, the contract e2e test). Every
 * dependency points at a closed local port — nothing needs to run.
 *
 * Not `loadConfig({ NODE_ENV: "production" })`: production refuses the
 * test login code channels, the only ones until TASK-026. The served
 * route set depends only on `nodeEnv` and the dev outbox flag, so a
 * staging config (dev outbox off) presented as production lists exactly
 * the production routes.
 */
export function routeListingConfig(nodeEnv: "production" | "development"): AppConfig {
  const config = loadConfig({
    NODE_ENV: nodeEnv === "production" ? "staging" : "development",
    DATABASE_URL: "postgres://x:x@127.0.0.1:1/x",
    REDIS_URL: "redis://127.0.0.1:2",
    S3_ENDPOINT: "http://127.0.0.1:3",
    S3_ACCESS_KEY: "x",
    S3_SECRET_KEY: "x",
    S3_BUCKET: "x",
    LOGIN_CODE_HASH_SECRET: "route-listing-only-not-a-real-secret",
    SESSION_TOKEN_SECRET: "route-listing-only-not-a-real-secret",
    ADMIN_TOTP_ENCRYPTION_KEY: "route-listing-only-not-a-real-secret",
  });
  return { ...config, nodeEnv };
}

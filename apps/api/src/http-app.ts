import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AppConfig } from "./config";

/**
 * HTTP-level settings shared by `main.ts` and tests that boot the app, so
 * both see the same client IP resolution (rate limits by IP depend on it).
 */
export function configureHttpApp(app: NestExpressApplication, config: AppConfig): void {
  // Behind a reverse proxy the socket address is the proxy's; TRUST_PROXY
  // says which X-Forwarded-For hops to believe (Express `trust proxy`).
  app.set("trust proxy", config.http.trustProxy);
  // Permissive for now: no cookies/auth exist yet (TASK-001). Revisit with
  // an explicit origin allowlist once sessions are introduced (TASK-005).
  app.enableCors({ origin: true });
}

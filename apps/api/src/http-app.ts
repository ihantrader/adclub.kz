import type { NestExpressApplication } from "@nestjs/platform-express";
import { corsOptions } from "./common/http";
import type { AppConfig } from "./config";

/**
 * HTTP-level settings shared by `main.ts` and tests that boot the app, so
 * both see the same client IP resolution (rate limits by IP depend on it)
 * and the same CORS policy.
 */
export function configureHttpApp(app: NestExpressApplication, config: AppConfig): void {
  // Behind a reverse proxy the socket address is the proxy's; TRUST_PROXY
  // says which X-Forwarded-For hops to believe (Express `trust proxy`).
  app.set("trust proxy", config.http.trustProxy);
  // Only the web clients' origins (TASK-005); requests from other sites are
  // refused by OriginPolicyMiddleware (AppModule).
  app.enableCors(corsOptions(config));
}

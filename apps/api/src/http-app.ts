import type { NestExpressApplication } from "@nestjs/platform-express";
import { bodyParserException } from "./common/errors";
import { corsOptions } from "./common/http";
import { appJsonParserReads } from "./common/http/json-parser";
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
  // The JSON parser Nest registers by default reads every `application/json`
  // body to its end before any middleware of a module runs — the body of a
  // route that reads its own bytes (the provider's webhook, whose signature is
  // over exactly those bytes, TASK-024) would already be gone, and the reader
  // would wait for data that never comes. So the parser is registered here,
  // with everything it did before (`application/json`, the same limit) and
  // one exception: a route that takes its body as bytes is not its business.
  // Nor is a guest's body on a route of a guest's AI trial: its gate decides
  // before the body is read and reads it itself (TASK-066, `appJsonParserReads`).
  app.useBodyParser("json", { type: appJsonParserReads });
  // Nest's default form parser would read any `application/x-www-form-urlencoded`
  // body before a module's middleware — a guest's body on a route of the AI
  // trial included, before its gate (TASK-066). The API takes no form bodies
  // (`JsonBodyMiddleware` answers 415 by the header alone), so it reads none.
  app.useBodyParser("urlencoded", { type: () => false });
  // A body the parser refused (not JSON, too large, a foreign encoding)
  // becomes its contract error where Nest takes over errors of Express
  // middleware — before it turns a JSON syntax error into a plain 400 that
  // no longer says what it was (TASK-009.A). The parsers are registered at
  // `init`, after this, so an Express error handler here would come too
  // early to see them.
  const adapter = app.getHttpAdapter() as { mapException?: (error: unknown) => unknown };
  const mapException = adapter.mapException?.bind(adapter);
  if (mapException) {
    adapter.mapException = (error) => bodyParserException(error) ?? mapException(error);
  }
}

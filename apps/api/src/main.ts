import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { loadEnvFile, loadConfig, warnIgnoredVariables } from "./config";
import { AppModule } from "./app.module";
import { JsonLoggerService } from "./common/logging";
import {
  installGracefulShutdown,
  logStartupFailure,
  reportUnhandledFailures,
} from "./common/shutdown";
import { ErrorReporter } from "./observability";
import { configureHttpApp } from "./http-app";

loadEnvFile();

async function bootstrap() {
  const config = loadConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bufferLogs: true,
  });
  const logger = app.get(JsonLoggerService);
  app.useLogger(logger);
  warnIgnoredVariables(config, logger);
  reportUnhandledFailures({
    logger,
    reporter: app.get(ErrorReporter),
    context: "Bootstrap",
  });
  configureHttpApp(app, config);

  await app.listen(config.port);
  logger.log(`API listening on port ${config.port}`, "Bootstrap");

  // Not `app.enableShutdownHooks()`: that only wires OS signals to
  // `app.close()` and doesn't exit the process — installGracefulShutdown
  // (shared with the worker, TASK-005.A) also logs the marker
  // `verify:graceful-shutdown` checks for, bounds shutdown by a timeout,
  // and ignores a repeated signal.
  installGracefulShutdown({ logger, context: "Bootstrap", close: () => app.close() });
}

void bootstrap().catch((error: unknown) => {
  logStartupFailure("API process", "Bootstrap", error);
  process.exit(1);
});

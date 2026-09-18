import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadEnvFile, loadConfig, warnIgnoredVariables } from "./config";
import { WorkerModule } from "./worker.module";
import { JsonLoggerService } from "./common/logging";
import {
  installGracefulShutdown,
  logStartupFailure,
  reportUnhandledFailures,
} from "./common/shutdown";
import { ErrorReporter } from "./observability";

loadEnvFile();

async function bootstrap() {
  const config = loadConfig();

  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    bufferLogs: true,
  });
  const logger = app.get(JsonLoggerService);
  app.useLogger(logger);
  warnIgnoredVariables(config, logger);
  reportUnhandledFailures({ logger, reporter: app.get(ErrorReporter), context: "Worker" });
  logger.log("Worker process started", "Worker");

  // Keeps the event loop alive until a shutdown signal arrives (signal
  // listeners alone don't do this on every platform, see TASK-001-REPORT
  // I5) — also while the job queue waits for an unreachable database.
  const heartbeat = setInterval(() => {}, 1 << 30);

  installGracefulShutdown({
    logger,
    context: "Worker",
    close: async () => {
      clearInterval(heartbeat);
      await app.close();
    },
  });
}

void bootstrap().catch((error: unknown) => {
  logStartupFailure("worker process", "Worker", error);
  process.exit(1);
});

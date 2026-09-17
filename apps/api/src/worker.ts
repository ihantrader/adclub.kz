import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadEnvFile, loadConfig, ConfigValidationError } from "./config";
import { WorkerModule } from "./worker.module";
import { JsonLoggerService } from "./common/logging";
import { installGracefulShutdown } from "./common/shutdown";

loadEnvFile();

async function bootstrap() {
  const config = loadConfig();

  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    bufferLogs: true,
  });
  const logger = app.get(JsonLoggerService);
  app.useLogger(logger);
  logger.log("Worker process started", "Worker");

  // Keeps the event loop alive until a shutdown signal arrives (signal
  // listeners alone don't do this on every platform, see TASK-001-REPORT
  // I5). Replaced by real pg-boss job polling once background jobs exist.
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
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
  } else {
    console.error("Failed to start worker process:", error);
  }
  process.exit(1);
});

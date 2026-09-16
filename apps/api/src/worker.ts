import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadEnvFile, loadConfig, ConfigValidationError } from "./config";
import { WorkerModule } from "./worker.module";
import { JsonLoggerService } from "./common/logging";

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

  const shutdown = (signal: string) => {
    logger.log(`Received ${signal}, shutting down`, "Worker");
    clearInterval(heartbeat);
    void app.close().then(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
  } else {
    console.error("Failed to start worker process:", error);
  }
  process.exit(1);
});

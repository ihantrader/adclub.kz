import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const logger = new Logger("Worker");
  logger.log("Worker process started");

  // Keeps the event loop alive until a shutdown signal arrives (signal
  // listeners alone don't do this on every platform). Replaced by real
  // pg-boss job polling once background jobs exist (TASK-002+).
  const heartbeat = setInterval(() => {}, 1 << 30);

  const shutdown = (signal: string) => {
    logger.log(`Received ${signal}, shutting down`);
    clearInterval(heartbeat);
    void app.close().then(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void bootstrap();

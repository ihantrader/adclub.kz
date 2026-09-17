import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { loadEnvFile, loadConfig, ConfigValidationError } from "./config";
import { AppModule } from "./app.module";
import { JsonLoggerService } from "./common/logging";
import { configureHttpApp } from "./http-app";

loadEnvFile();

async function bootstrap() {
  const config = loadConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bufferLogs: true,
  });
  app.useLogger(app.get(JsonLoggerService));
  app.enableShutdownHooks();
  configureHttpApp(app, config);

  await app.listen(config.port);
  app.get(JsonLoggerService).log(`API listening on port ${config.port}`, "Bootstrap");
}

void bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
  } else {
    console.error("Failed to start API process:", error);
  }
  process.exit(1);
});

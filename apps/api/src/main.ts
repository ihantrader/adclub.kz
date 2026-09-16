import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadEnvFile, loadConfig, ConfigValidationError } from "./config";
import { AppModule } from "./app.module";
import { JsonLoggerService } from "./common/logging";

loadEnvFile();

async function bootstrap() {
  const config = loadConfig();

  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });
  app.useLogger(app.get(JsonLoggerService));
  app.enableShutdownHooks();
  // Permissive for now: no cookies/auth exist yet (TASK-001). Revisit with
  // an explicit origin allowlist once sessions are introduced (TASK-005).
  app.enableCors({ origin: true });

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

import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  // Permissive for now: no cookies/auth exist yet (TASK-001). Revisit with
  // an explicit origin allowlist once sessions are introduced (TASK-002+).
  app.enableCors({ origin: true });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger("Bootstrap").log(`API listening on port ${port}`);
}

void bootstrap();

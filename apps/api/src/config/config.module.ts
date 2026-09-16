import { Global, Module } from "@nestjs/common";
import type { AppConfig } from "./env.schema";

export const APP_CONFIG = Symbol("APP_CONFIG");

/**
 * Makes the already-validated `AppConfig` (parsed once in `main.ts`/
 * `worker.ts` before Nest boots — see `loadConfig`) available for
 * injection anywhere in the app via the `APP_CONFIG` token.
 */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig) {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

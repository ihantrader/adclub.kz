import { Global, Module, type DynamicModule } from "@nestjs/common";
import {
  AccountDirectory,
  LoginCodeSettingsSource,
  SessionSettingsSource,
  SignInSettingsSource,
} from "../identity";
import {
  AppSettings,
  defaultSettingsCacheOptions,
  SETTINGS_CACHE_OPTIONS,
  type SettingsCacheOptions,
} from "./app-settings";
import {
  SettingsLoginCodeSource,
  SettingsSessionSource,
  SettingsSignInSource,
} from "./identity-settings.sources";
import { SettingsChangeService } from "./settings-change.service";
import { SettingsController } from "./settings.controller";
import { SettingsStore } from "./settings.store";

export interface SettingsModuleOptions {
  /** Serve the admin routes (the API process only). */
  http: boolean;
  /** Tests shorten the cache lifetime; the processes keep the defaults. */
  cache?: Partial<SettingsCacheOptions>;
}

/**
 * Settings in data (ARCHITECTURE 14, 4.11): the registry, the cached
 * values every process reads (`AppSettings`), changes with history, the
 * admin routes, and the threshold sources of the identity module.
 * Global: any module reads `AppSettings` without importing this one.
 */
@Global()
@Module({})
export class SettingsModule {
  static forRoot(options: SettingsModuleOptions): DynamicModule {
    return {
      module: SettingsModule,
      controllers: options.http ? [SettingsController] : [],
      providers: [
        {
          provide: SETTINGS_CACHE_OPTIONS,
          useValue: { ...defaultSettingsCacheOptions, ...options.cache },
        },
        AccountDirectory,
        SettingsStore,
        AppSettings,
        SettingsChangeService,
        { provide: LoginCodeSettingsSource, useClass: SettingsLoginCodeSource },
        { provide: SessionSettingsSource, useClass: SettingsSessionSource },
        { provide: SignInSettingsSource, useClass: SettingsSignInSource },
      ],
      exports: [
        AppSettings,
        SettingsChangeService,
        LoginCodeSettingsSource,
        SessionSettingsSource,
        SignInSettingsSource,
      ],
    };
  }
}

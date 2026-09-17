import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config";
import { DevLoginCodeOutbox } from "./login-code/channels/dev-login-code-outbox";
import { LoginCodeChannels } from "./login-code/channels/login-code-channels";
import { TestLoginCodeChannels } from "./login-code/channels/test-login-code-channels";
import { DevLoginCodeOutboxController } from "./login-code/dev-login-code-outbox.controller";
import {
  ConfigLoginCodeSettingsSource,
  LoginCodeSettingsSource,
} from "./login-code/login-code-settings.source";
import { LoginCodeController } from "./login-code/login-code.controller";
import { LoginCodeService } from "./login-code/login-code.service";
import { LoginCodeStore } from "./login-code/login-code.store";

function createLoginCodeChannels(
  config: AppConfig,
  outbox: DevLoginCodeOutbox | undefined,
): LoginCodeChannels {
  switch (config.loginCode.channels) {
    case "test":
      return new TestLoginCodeChannels(config.loginCode.testFailingChannels, outbox);
  }
}

/**
 * Identity (ARCHITECTURE 5.1, 8): accounts and sign-in by one-time code
 * (TASK-004). Sessions (TASK-005) and roles (TASK-006) join this module.
 */
@Module({})
export class IdentityModule {
  static forRoot(config: AppConfig): DynamicModule {
    const devOutbox = config.loginCode.devOutbox;
    return {
      module: IdentityModule,
      controllers: [LoginCodeController, ...(devOutbox ? [DevLoginCodeOutboxController] : [])],
      providers: [
        // Replacement point for the settings table (TASK-007).
        { provide: LoginCodeSettingsSource, useClass: ConfigLoginCodeSettingsSource },
        ...(devOutbox ? [{ provide: DevLoginCodeOutbox, useValue: new DevLoginCodeOutbox() }] : []),
        // Replacement point for the real WhatsApp and SMS providers (TASK-026).
        {
          provide: LoginCodeChannels,
          useFactory: (outbox?: DevLoginCodeOutbox) => createLoginCodeChannels(config, outbox),
          inject: [{ token: DevLoginCodeOutbox, optional: true }],
        },
        LoginCodeStore,
        LoginCodeService,
      ],
      exports: [LoginCodeService],
    };
  }
}

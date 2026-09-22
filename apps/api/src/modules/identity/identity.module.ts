import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config";
import { AccountStore } from "./account/account.store";
import { AdminAccessRevoker } from "./admin/admin-access-revoker";
import { AdminAuthService } from "./admin/admin-auth.service";
import { AdminUserStore } from "./admin/admin-user.store";
import { AdminController } from "./admin/admin.controller";
import { OperatorService } from "./admin/operator.service";
import { DevLoginCodeOutbox } from "./login-code/channels/dev-login-code-outbox";
import { LoginCodeChannels } from "./login-code/channels/login-code-channels";
import { TestLoginCodeChannels } from "./login-code/channels/test-login-code-channels";
import { DevLoginCodeOutboxController } from "./login-code/dev-login-code-outbox.controller";
import { LoginCodeController } from "./login-code/login-code.controller";
import { LoginCodeService } from "./login-code/login-code.service";
import { LoginCodeStore } from "./login-code/login-code.store";
import { SessionController } from "./session/session.controller";
import { OptionalSessionGuard, SessionGuard } from "./session/session.guard";
import { SessionService } from "./session/session.service";
import { SessionStore } from "./session/session.store";
import { SignInStepController } from "./session/sign-in-step.controller";
import { SignInStepStore } from "./session/sign-in-step.store";
import { SignInStepsService } from "./session/sign-in-steps.service";
import { SignInService } from "./session/sign-in.service";
import { SupplierContextController } from "./supplier/supplier-context.controller";
import { SupplierContextService } from "./supplier/supplier-context.service";
import { SupplierMemberRemover } from "./supplier/supplier-member-remover";
import { SupplierMembershipStore } from "./supplier/supplier-membership.store";

function createLoginCodeChannels(
  config: AppConfig,
  outbox: DevLoginCodeOutbox | undefined,
): LoginCodeChannels {
  switch (config.loginCode.channels) {
    case "test":
      return new TestLoginCodeChannels(config.loginCode.testFailingChannels, outbox);
  }
}

/** Providers the operator command needs without the HTTP layer (`operator.ts`). */
export const identityOperatorProviders = [
  AccountStore,
  AdminUserStore,
  SupplierMembershipStore,
  SessionStore,
  SupplierMemberRemover,
  AdminAccessRevoker,
  OperatorService,
];

/**
 * Identity (ARCHITECTURE 5.1, 8): accounts, sign-in by one-time code
 * (TASK-004), sessions (TASK-005), roles and contexts — supplier
 * employees, administrators with a second factor, the access rule
 * (TASK-006). Thresholds (`LoginCodeSettingsSource`,
 * `SessionSettingsSource`, `SignInSettingsSource`) are provided by the
 * global settings module (TASK-007).
 *
 * Global: any module can protect its routes with `SessionRoute` without
 * importing this one again (a second `forRoot` would be a second
 * instance with its own controllers — Nest tells dynamic modules apart
 * by reference).
 */
@Module({})
export class IdentityModule {
  static forRoot(config: AppConfig): DynamicModule {
    const devOutbox = config.loginCode.devOutbox;
    return {
      module: IdentityModule,
      global: true,
      controllers: [
        LoginCodeController,
        SessionController,
        SignInStepController,
        SupplierContextController,
        AdminController,
        ...(devOutbox ? [DevLoginCodeOutboxController] : []),
      ],
      providers: [
        ...(devOutbox ? [{ provide: DevLoginCodeOutbox, useValue: new DevLoginCodeOutbox() }] : []),
        // Replacement point for the real WhatsApp and SMS providers (TASK-026).
        {
          provide: LoginCodeChannels,
          useFactory: (outbox?: DevLoginCodeOutbox) => createLoginCodeChannels(config, outbox),
          inject: [{ token: DevLoginCodeOutbox, optional: true }],
        },
        LoginCodeStore,
        LoginCodeService,
        ...identityOperatorProviders,
        SessionService,
        SessionGuard,
        OptionalSessionGuard,
        SignInStepStore,
        SignInStepsService,
        AdminAuthService,
        SignInService,
        SupplierContextService,
      ],
      // Other modules protect their routes with `SessionRoute` (SessionGuard).
      exports: [LoginCodeService, SessionService, SessionGuard, OptionalSessionGuard],
    };
  }
}

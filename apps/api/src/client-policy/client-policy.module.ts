import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ClientPolicyController } from "./client-policy.controller";
import { ClientPolicyService } from "./client-policy.service";
import { ClientPolicySource, SettingsClientPolicySource } from "./client-policy.source";
import { ClientVersionGuard } from "./client-version.guard";

/**
 * Client policy (ARCHITECTURE 7.4): the public `GET /meta/client-policy`
 * endpoint and the global minimum-version guard; values come from the
 * settings (TASK-007).
 */
@Module({
  controllers: [ClientPolicyController],
  providers: [
    { provide: ClientPolicySource, useClass: SettingsClientPolicySource },
    ClientPolicyService,
    { provide: APP_GUARD, useClass: ClientVersionGuard },
  ],
  exports: [ClientPolicyService],
})
export class ClientPolicyModule {}

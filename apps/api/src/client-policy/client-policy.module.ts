import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ClientPolicyController } from "./client-policy.controller";
import { ClubInfoController } from "./club-info.controller";
import { ClientPolicyService } from "./client-policy.service";
import { ClientPolicySource, SettingsClientPolicySource } from "./client-policy.source";
import { ClientVersionGuard } from "./client-version.guard";

/**
 * Client policy (ARCHITECTURE 7.4): the public `GET /meta/client-policy`
 * endpoint and the global minimum-version guard; values come from the
 * settings (TASK-007). Also `GET /meta/club-info` (TASK-077): the club's
 * documents and contact, from the settings `club_*`.
 */
@Module({
  controllers: [ClientPolicyController, ClubInfoController],
  providers: [
    { provide: ClientPolicySource, useClass: SettingsClientPolicySource },
    ClientPolicyService,
    { provide: APP_GUARD, useClass: ClientVersionGuard },
  ],
  exports: [ClientPolicyService],
})
export class ClientPolicyModule {}

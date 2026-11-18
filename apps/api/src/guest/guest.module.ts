import { Global, Module } from "@nestjs/common";
import { GuestActivity } from "./guest-activity";

/**
 * A guest's AI trial (TASK-066): the signs of the switch
 * `guest_attestation_required`. Global, as the limiter: the gate is a
 * middleware of the application module, and the operator command reads the
 * same counts.
 */
@Global()
@Module({
  providers: [GuestActivity],
  exports: [GuestActivity],
})
export class GuestModule {}

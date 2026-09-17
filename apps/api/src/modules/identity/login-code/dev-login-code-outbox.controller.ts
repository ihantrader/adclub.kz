import { Controller, Get, Inject } from "@nestjs/common";
import { DevLoginCodeOutbox, type DevOutboxEntry } from "./channels/dev-login-code-outbox";

/** Not part of the contract; excluded from the served-routes check. */
export const DEV_LOGIN_CODE_OUTBOX_PATH = "/dev/login-codes";

/**
 * Development only (`LOGIN_CODE_DEV_OUTBOX`, never in production): the
 * latest codes sent by the test channels, newest first. No filter
 * parameter on purpose — a phone number in the URL would land in the
 * access log.
 */
@Controller()
export class DevLoginCodeOutboxController {
  constructor(@Inject(DevLoginCodeOutbox) private readonly outbox: DevLoginCodeOutbox) {}

  @Get(DEV_LOGIN_CODE_OUTBOX_PATH)
  list(): { note: string; messages: DevOutboxEntry[] } {
    return {
      note: "Development only: login codes sent by the test channels (latest 20, this API process).",
      messages: this.outbox.list(),
    };
  }
}

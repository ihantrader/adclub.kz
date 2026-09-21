import { Controller, Get, Inject } from "@nestjs/common";
import { DevInvitationOutbox } from "./supplier-invitations";

/** Not part of the contract; excluded from the served-routes check (as `/dev/login-codes`). */
export const DEV_SUPPLIER_INVITATIONS_PATH = "/dev/supplier-invitations";

type DevInvitations = Awaited<ReturnType<DevInvitationOutbox["latest"]>>;

/**
 * Development only (the same switch as `/dev/login-codes`, never in
 * production): the latest invitations to employees with their text, as
 * the test channel sent them. No filter parameter: a number in the URL
 * would land in the access log.
 */
@Controller()
export class DevSupplierInvitationsController {
  constructor(@Inject(DevInvitationOutbox) private readonly outbox: DevInvitationOutbox) {}

  @Get(DEV_SUPPLIER_INVITATIONS_PATH)
  async list(): Promise<{ note: string; messages: DevInvitations }> {
    return {
      note: "Development only: invitations to employees, newest first (latest 20; the worker sends them through the test channel).",
      messages: await this.outbox.latest(),
    };
  }
}

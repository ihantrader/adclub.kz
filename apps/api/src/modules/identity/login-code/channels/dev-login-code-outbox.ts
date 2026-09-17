import type { LoginCodeChannel } from "@adclub/contracts";

export interface DevOutboxEntry {
  sentAt: string;
  channel: LoginCodeChannel;
  phone: string;
  code: string;
  expiresAt: string;
}

const MAX_ENTRIES = 20;

/**
 * Development and tests only: the codes the test channels "sent", so a
 * developer or the Product Owner can sign in without a real phone
 * (`GET /dev/login-codes`). In memory of one API process; never created
 * in production (config validation refuses `LOGIN_CODE_DEV_OUTBOX` there).
 */
export class DevLoginCodeOutbox {
  private readonly entries: DevOutboxEntry[] = [];

  record(entry: DevOutboxEntry): void {
    this.entries.unshift(entry);
    this.entries.length = Math.min(this.entries.length, MAX_ENTRIES);
  }

  /** Newest first. */
  list(): DevOutboxEntry[] {
    return [...this.entries];
  }
}

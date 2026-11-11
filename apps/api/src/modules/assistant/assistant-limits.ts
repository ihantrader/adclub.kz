import { Inject, Injectable } from "@nestjs/common";
import type { AssistantLimits } from "@adclub/contracts";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { rateLimitedException, serviceUnavailableException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { RateLimiterService, RateLimiterUnavailableError } from "../../redis";
import { AppSettings } from "../settings";
import { assistantDialog, type AssistantDialogRow } from "./schema";

/**
 * Who talks to the assistant, as its limits see it (TASK-062; PRODUCT 6.6,
 * 8.3): a signed-in person by the account; a guest by the device the app
 * made an id for (and by the address — the guard of the contract counts the
 * messages of an address, `assistant_guest_per_ip`).
 */
export type Asker = { kind: "account"; accountId: string } | { kind: "guest"; deviceId: string };

/** A guest's trial dialogs don't run out with a day: the device's window is a year (as the photos'). */
const DEVICE_WINDOW_SECONDS = 365 * 24 * 60 * 60;

/** The start of the Almaty day (ARCHITECTURE 13.3): an account's dialogs are counted by it. */
const ALMATY_DAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty')`;

/** Seconds until the next Almaty midnight — when an account's day of dialogs starts again. */
function secondsToAlmatyMidnight(now: Date): number {
  const almaty = new Date(now.getTime() + 5 * 3600 * 1000);
  const next = Date.UTC(almaty.getUTCFullYear(), almaty.getUTCMonth(), almaty.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - almaty.getTime()) / 1000));
}

function deviceKey(deviceId: string): string {
  return `assistant:device:${deviceId}`;
}

/** What was counted for a dialog, to give it back when the provider could not serve the turn. */
export type Charge = { kind: "account"; dialogId: string } | { kind: "guest"; key: string };

/**
 * The dialogs of the assistant, counted once per dialog (ARCHITECTURE
 * 8.6.2): a guest's trial ones per device for good
 * (`guest_limits.assistant_dialogs`, in Redis like the photo recognitions —
 * a count, no content), a signed-in person's per Almaty day
 * (`assistant_daily_dialogs_per_user`, the charged dialogs of the account
 * in the database, under a lock of the account so two first messages at
 * once can't both pass the last one). A dialog is counted with its first
 * turn that goes to the model, and given back when the provider could not
 * serve it (`refund`) — that is not the person's doing. Without Redis a
 * guest is not served (every turn costs money; an uncounted one is not
 * allowed).
 */
@Injectable()
export class AssistantLimitsService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RateLimiterService) private readonly limiter: RateLimiterService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  /** What is left now; nothing is counted. */
  async left(asker: Asker, dialog: AssistantDialogRow | null): Promise<AssistantLimits> {
    const turnsLimit = await this.settings.get("assistant_max_turns");
    const turnsLeft = dialog === null ? null : Math.max(0, turnsLimit - dialog.turns);
    if (asker.kind === "account") {
      const limit = await this.settings.get("assistant_daily_dialogs_per_user");
      const used = await this.accountDialogsToday(asker.accountId);
      return {
        scope: "account",
        dialogsLeft: Math.max(0, limit - used),
        dialogsLimit: limit,
        turnsLeft,
        turnsLimit,
      };
    }
    const limit = (await this.settings.get("guest_limits")).assistant_dialogs;
    let used: number;
    try {
      used = (await this.limiter.peek(deviceKey(asker.deviceId))).count;
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) throw serviceUnavailableException();
      throw error;
    }
    return {
      scope: "guest",
      dialogsLeft: Math.max(0, limit - used),
      dialogsLimit: limit,
      turnsLeft,
      turnsLimit,
    };
  }

  /**
   * Refuses a new dialog when none is left, before anything is opened (so a
   * person over the limit keeps the dialog they have); the count itself is
   * `charge`, with the turn.
   */
  async assertDialogLeft(asker: Asker): Promise<void> {
    const left = await this.left(asker, null);
    if (left.dialogsLeft > 0) return;
    if (asker.kind === "account") {
      throw rateLimitedException(
        "assistant_daily_dialogs_per_user",
        secondsToAlmatyMidnight(new Date()),
      );
    }
    throw rateLimitedException("assistant_dialogs_per_device", DEVICE_WINDOW_SECONDS);
  }

  /**
   * Counts the dialog: over the limit — 429 with the limit's name
   * (`details.limit`, so the app shows the right variant of M-AI-02).
   */
  async charge(asker: Asker, dialogId: string): Promise<Charge> {
    if (asker.kind === "account") {
      const limit = await this.settings.get("assistant_daily_dialogs_per_user");
      return this.database.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('assistant_dialogs'), hashtext(${asker.accountId}))`,
        );
        const [row] = await tx
          .select({ used: count() })
          .from(assistantDialog)
          .where(
            and(
              eq(assistantDialog.accountId, asker.accountId),
              eq(assistantDialog.charged, true),
              gte(assistantDialog.createdAt, ALMATY_DAY_START),
            ),
          );
        if ((row?.used ?? 0) >= limit) {
          throw rateLimitedException(
            "assistant_daily_dialogs_per_user",
            secondsToAlmatyMidnight(new Date()),
          );
        }
        await tx
          .update(assistantDialog)
          .set({ charged: true, updatedAt: sql`now()` })
          .where(eq(assistantDialog.id, dialogId));
        return { kind: "account", dialogId } as const;
      });
    }
    const max = (await this.settings.get("guest_limits")).assistant_dialogs;
    const key = deviceKey(asker.deviceId);
    try {
      const hit = await this.limiter.hit(key, { max, windowSeconds: DEVICE_WINDOW_SECONDS });
      if (!hit.allowed) {
        await this.limiter.undo(() => this.limiter.refund(key));
        throw rateLimitedException("assistant_dialogs_per_device", hit.retryAfterSeconds);
      }
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) throw serviceUnavailableException();
      throw error;
    }
    try {
      await this.database.db
        .update(assistantDialog)
        .set({ charged: true, updatedAt: sql`now()` })
        .where(eq(assistantDialog.id, dialogId));
    } catch (error) {
      // Counted in Redis but not marked: given back, or a trial dialog would be lost for good.
      await this.limiter.undo(() => this.limiter.refund(key));
      throw error;
    }
    return { kind: "guest", key };
  }

  /** Gives a dialog back: the provider could not serve its first turn. Best effort. */
  async refund(charge: Charge, dialogId: string): Promise<void> {
    if (charge.kind === "guest") {
      await this.limiter.undo(() => this.limiter.refund(charge.key));
    }
    await this.database.db
      .update(assistantDialog)
      .set({ charged: false, updatedAt: sql`now()` })
      .where(eq(assistantDialog.id, dialogId));
  }

  private async accountDialogsToday(accountId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ used: count() })
      .from(assistantDialog)
      .where(
        and(
          eq(assistantDialog.accountId, accountId),
          eq(assistantDialog.charged, true),
          gte(assistantDialog.createdAt, ALMATY_DAY_START),
        ),
      );
    return row?.used ?? 0;
  }
}

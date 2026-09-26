import { Inject, Injectable, Logger } from "@nestjs/common";
import { maskPhone } from "@adclub/domain";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DatabaseService, type DbExecutor } from "../../database";
import { defineJob, type JobHandler } from "../../jobs";
import {
  messageButtonPress,
  outboundMessage,
  type ButtonPressOutcome,
  type MessageButtonPressRow,
  type OutboundMessageRow,
} from "./schema";

/**
 * Acting on a press of a button (TASK-025 requirement 3). The webhook stores
 * the press (TASK-024) and puts this job on the queue in the same
 * transaction; the worker decides it here, out of the provider's request, so
 * the provider gets its 200 at once whatever the press leads to.
 *
 * Messaging knows nothing of orders, so it does not decide: the module that
 * owns a button registers a handler for it (`ButtonPressHandlers`, the same
 * shape as `MessageSubjects`), and the handler runs **inside the transaction
 * that records the outcome on the press**. Whatever the handler does — a move
 * of an order, a reply message — and the outcome are committed together or
 * not at all, and the press is locked while it is decided: a press is dealt
 * with once, however many times its job runs.
 */

export interface ButtonPressContext {
  press: MessageButtonPressRow;
  /** The message the press answers, when it is one of ours. */
  message: OutboundMessageRow | undefined;
}

export interface ButtonPressHandler {
  /** Decides the press and does what it means; the answer is kept on the press. */
  handle(tx: DbExecutor, context: ButtonPressContext): Promise<ButtonPressOutcome>;
}

/** The handlers of buttons in this process, by the button's name. */
@Injectable()
export class ButtonPressHandlers {
  private readonly handlers = new Map<string, ButtonPressHandler>();

  register(buttons: readonly string[], handler: ButtonPressHandler): void {
    for (const button of buttons) {
      if (this.handlers.has(button)) {
        throw new Error(`The button ${button} has two handlers`);
      }
      this.handlers.set(button, handler);
    }
  }

  get(button: string | null): ButtonPressHandler | undefined {
    return button === null ? undefined : this.handlers.get(button);
  }
}

/** Decides one stored press (`message_button_press`). */
export const applyButtonPressJob = defineJob({
  name: "messaging.apply-button-press",
  payload: z.object({ pressId: z.uuid() }),
  timeoutSeconds: 60,
  retry: { limit: 5, delaySeconds: 5, backoff: true, maxDelaySeconds: 300 },
  singleton: false,
});

@Injectable()
export class ButtonPressApplier implements JobHandler<{ pressId: string }> {
  private readonly logger = new Logger("Messaging");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ButtonPressHandlers) private readonly handlers: ButtonPressHandlers,
  ) {}

  async run({ pressId }: { pressId: string }): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [press] = await tx
        .select()
        .from(messageButtonPress)
        .where(eq(messageButtonPress.id, pressId))
        .for("update");
      if (!press || press.appliedAt !== null) {
        // Gone with its webhook delivery, or decided already: nothing twice.
        return;
      }
      const [message] = press.messageId
        ? await tx.select().from(outboundMessage).where(eq(outboundMessage.id, press.messageId))
        : [];
      const handler = this.handlers.get(press.buttonName);
      const outcome: ButtonPressOutcome = handler
        ? await handler.handle(tx, { press, message })
        : "no_handler";
      await tx
        .update(messageButtonPress)
        .set({ appliedAt: new Date(), outcome })
        .where(eq(messageButtonPress.id, press.id));
      this.logger.log(
        `Button press decided press=${press.id} button=${press.buttonName ?? "unknown"} outcome=${outcome} from=${maskPhone(press.fromPhone)}`,
      );
    });
  }
}

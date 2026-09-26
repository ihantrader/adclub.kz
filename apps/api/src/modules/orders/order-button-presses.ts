import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import {
  ButtonPayloads,
  ButtonPressHandlers,
  type ButtonPressContext,
  type ButtonPressHandler,
  type ButtonPressOutcome,
} from "../messaging";
import { noticeMembers, ORDER_BUTTONS, ORDER_SUBJECT, OrderNotices } from "./order-notices";
import { databaseNow, OrderTransitions } from "./order-transitions";
import { customerOrder } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * «Подтвердить» and «Отказать» of W-01 pressed in WhatsApp (TASK-025
 * requirements 2 and 3; PRODUCT 10.1, 12.6, 15; SCREENS 8.5). **A press is
 * the same action as the button of the cabinet, taken by the same state
 * machine**: it reaches the order only through `OrderTransitions.move`, as
 * the employee the message was addressed to, through the channel
 * `whatsapp` — there is no second way to the status of an order.
 *
 * Before anything is moved, the press has to prove what it is:
 *
 * 1. the payload is one the server signed, for this button, and not past its
 *    time (`ButtonPayloads`) — otherwise `invalid_payload` or `expired`;
 * 2. it answers a message of this very order sent to the number it came
 *    from — otherwise `phone_mismatch` or `foreign_message`;
 * 3. the employee of the payload belongs to the order's company and has this
 *    number — otherwise `foreign_message` or `phone_mismatch`;
 * 4. the employee is still one — otherwise the press is not applied and the
 *    answer says only that there is no access any more (`member_removed`).
 *
 * None of these is answered to anybody but the fourth: a message to a number
 * that did not prove itself would be a message to whoever sent the event.
 * Then the move, **only from «Создана»** — the buttons belong to the notice
 * of a new order: an accepted one is declined from the cabinet, with a
 * reason, not by a button of a notice about something that has moved on.
 *
 * - moved: «Подтвердить» → W-02 with the customer's phone (it opens by this
 *   accept); «Отказать» → no message (the order is declined without a reason,
 *   like a decline of the cabinet with none; «нет в наличии» and withdrawing
 *   the offer belong to the cabinet);
 * - the same employee already made this move (a second tap): nothing new;
 *   they are told only when the first move was not theirs in WhatsApp;
 * - anything else (a colleague was first, the user cancelled, the deadline
 *   passed — applied first, 4.31 I310): nothing moves, the journal keeps
 *   `late_action_ignored` once per employee and intention (4.32 I331) and the
 *   employee gets W-03 with what the order is now.
 */
@Injectable()
export class OrderButtonPresses implements ButtonPressHandler, OnModuleInit {
  private readonly logger = new Logger("OrderButtonPresses");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(ButtonPressHandlers) private readonly handlers: ButtonPressHandlers,
    @Inject(ButtonPayloads) private readonly payloads: ButtonPayloads,
    @Inject(OrderTransitions) private readonly transitions: OrderTransitions,
    @Inject(OrderNotices) private readonly notices: OrderNotices,
  ) {}

  onModuleInit(): void {
    this.handlers.register(ORDER_BUTTONS, this);
  }

  async handle(
    tx: DbExecutor,
    { press, message }: ButtonPressContext,
  ): Promise<ButtonPressOutcome> {
    const at = await databaseNow(tx);
    // The expiry of the button is judged at the moment the press arrived, not
    // when the queue got to it: a press made in time is not refused because
    // a worker was slow. (The order's own deadline is judged now, by the state
    // machine, as for a request of the cabinet that arrives late.)
    const reading = this.payloads.read(press.payload ?? "", press.receivedAt);
    if (!reading.ok) {
      return reading.reason === "expired" ? "expired" : "invalid_payload";
    }
    const [orderId, memberId] = reading.fields;
    if (
      reading.button !== press.buttonName ||
      reading.fields.length !== 2 ||
      !orderId ||
      !memberId ||
      !UUID.test(orderId) ||
      !UUID.test(memberId)
    ) {
      return "invalid_payload";
    }
    if (message) {
      if (message.phone !== press.fromPhone) {
        return "phone_mismatch";
      }
      if (
        message.subjectType !== ORDER_SUBJECT ||
        message.subjectId !== orderId ||
        message.template !== "order_new"
      ) {
        return "foreign_message";
      }
    }
    const [order] = await tx.select().from(customerOrder).where(eq(customerOrder.id, orderId));
    const [member] = await noticeMembers(tx, { memberIds: [memberId] }, { share: true });
    if (!order || !member || member.supplierId !== order.supplierId) {
      return "foreign_message";
    }
    if (member.phone !== press.fromPhone) {
      return "phone_mismatch";
    }
    const action = reading.button === "confirm" ? "accept" : "decline";
    if (member.status !== "active") {
      await this.notices.stateReply(tx, order, member, action, at, { accessClosed: true });
      return "member_removed";
    }
    const outcome = await this.transitions.move(tx, {
      orderId,
      action,
      actor: {
        type: "supplier_member",
        accountId: member.accountId,
        supplierId: order.supplierId,
        memberId: member.id,
      },
      channel: "whatsapp",
      onlyFrom: ["created"],
      ...(action === "decline" ? { decline: { reason: null, note: null } } : {}),
    });
    switch (outcome.kind) {
      case "moved":
        if (action === "accept") {
          await this.notices.accepted(tx, outcome.order, member);
          return "accepted";
        }
        return "declined";
      case "repeated": {
        const last = await this.transitions.lastMove(tx, orderId);
        if (last?.channel !== "whatsapp") {
          // Done in the cabinet a moment ago; the press is answered all the same.
          await this.notices.stateReply(tx, outcome.order, member, action, at);
        }
        return "repeated";
      }
      case "conflict":
        await this.notices.stateReply(tx, outcome.order, member, action, at);
        this.logger.log(
          `Order button press found the order moved on order=${orderId} status=${outcome.order.status} member=${member.id}`,
        );
        return "conflict";
    }
  }
}

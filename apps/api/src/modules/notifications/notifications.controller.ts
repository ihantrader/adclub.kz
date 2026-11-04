import { Body, Controller, Inject, Param } from "@nestjs/common";
import {
  apiRoutes,
  notificationPathSchema,
  registerPushTokenBodySchema,
  type NotificationAckResponse,
  type NotificationPath,
  type PushTokenResponse,
  type RegisterPushTokenBody,
} from "@adclub/contracts";
import { ApiException } from "../../common/errors";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { Notifications } from "./notifications.service";

/** The app's side of push (TASK-051): its device's token and its confirmations. */
@Controller()
export class NotificationsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(Notifications) private readonly notifications: Notifications) {}

  @SessionRoute(apiRoutes.registerPushToken)
  async register(
    @Body(new ZodValidationPipe(registerPushTokenBodySchema)) body: RegisterPushTokenBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PushTokenResponse> {
    await this.notifications.registerToken(session, body);
    return { registered: true, platform: body.platform };
  }

  @SessionRoute(apiRoutes.removePushToken)
  async remove(@CurrentSession() session: AuthenticatedSession): Promise<PushTokenResponse> {
    await this.notifications.removeToken(session.sessionId);
    return { registered: false, platform: null };
  }

  @SessionRoute(apiRoutes.ackNotification)
  async ack(
    @Param(new ZodValidationPipe(notificationPathSchema)) params: NotificationPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<NotificationAckResponse> {
    const ackedAt = await this.notifications.ack(session.accountId, params.notificationId);
    if (!ackedAt) {
      throw new ApiException(404, "NOT_FOUND", "There is no such notification");
    }
    return { notificationId: params.notificationId, ackedAt: ackedAt.toISOString() };
  }
}

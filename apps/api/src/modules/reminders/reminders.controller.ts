import { Body, Controller, Headers, Inject, Param } from "@nestjs/common";
import {
  apiRoutes,
  garageCarIdPathSchema,
  garageReminderDoneBodySchema,
  garageReminderPathSchema,
  type GarageCarIdPath,
  type GarageReminderCar,
  type GarageReminderDoneBody,
  type GarageReminderPath,
  type GarageRemindersResponse,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { GarageReminders } from "./reminders.service";

/** Reminders of the account's garage (TASK-069; SCREENS M-REM-01, M-REM-02): context `user` only. */
@Controller()
export class RemindersController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(GarageReminders) private readonly reminders: GarageReminders) {}

  @SessionRoute(apiRoutes.listGarageReminders)
  list(
    @CurrentSession() session: AuthenticatedSession,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<GarageRemindersResponse> {
    return this.reminders.list(session, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.markGarageReminderDone)
  done(
    @Param(new ZodValidationPipe(garageReminderPathSchema)) params: GarageReminderPath,
    @Body(new ZodValidationPipe(garageReminderDoneBodySchema)) body: GarageReminderDoneBody,
    @CurrentSession() session: AuthenticatedSession,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<GarageReminderCar> {
    return this.reminders.done(
      session,
      params.carId,
      params.planItemId,
      body,
      pickLanguage(acceptLanguage),
    );
  }

  @SessionRoute(apiRoutes.snoozeGarageReminder)
  snooze(
    @Param(new ZodValidationPipe(garageReminderPathSchema)) params: GarageReminderPath,
    @CurrentSession() session: AuthenticatedSession,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<GarageReminderCar> {
    return this.reminders.snooze(
      session,
      params.carId,
      params.planItemId,
      pickLanguage(acceptLanguage),
    );
  }

  @SessionRoute(apiRoutes.dismissGarageMileageQuestion)
  dismiss(
    @Param(new ZodValidationPipe(garageCarIdPathSchema)) params: GarageCarIdPath,
    @CurrentSession() session: AuthenticatedSession,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<GarageReminderCar> {
    return this.reminders.dismissMileageQuestion(
      session,
      params.carId,
      pickLanguage(acceptLanguage),
    );
  }
}

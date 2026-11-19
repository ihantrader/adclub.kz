import { Body, Controller, Inject } from "@nestjs/common";
import {
  acceptConsentsBodySchema,
  apiRoutes,
  completeRegistrationBodySchema,
  updateAccountProfileBodySchema,
  type AcceptConsentsBody,
  type AccountProfile,
  type CompleteRegistrationBody,
  type UpdateAccountProfileBody,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../../common/validation";
import { CurrentSession, SessionRoute } from "../session/session.guard";
import type { AuthenticatedSession } from "../session/session.service";
import { AccountProfileService } from "./account-profile.service";

/**
 * The signed-in member's profile (TASK-029, ARCHITECTURE 4.41): finishing
 * registration and "Мои данные" (SCREENS M-AUTH-03, M-PRO-02), and the
 * consents with their versions (TASK-072). Mobile app sessions only — a
 * supplier cabinet or admin panel session has no profile of this kind
 * (`contexts: ["user"]` on every route here).
 */
@Controller()
export class AccountProfileController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AccountProfileService) private readonly profiles: AccountProfileService) {}

  @SessionRoute(apiRoutes.completeRegistration)
  completeRegistration(
    @Body(new ZodValidationPipe(completeRegistrationBodySchema)) body: CompleteRegistrationBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AccountProfile> {
    return this.profiles.complete(session.accountId, body, { sessionId: session.sessionId });
  }

  @SessionRoute(apiRoutes.getAccountProfile)
  getAccountProfile(@CurrentSession() session: AuthenticatedSession): Promise<AccountProfile> {
    return this.profiles.get(session.accountId);
  }

  @SessionRoute(apiRoutes.updateAccountProfile)
  updateAccountProfile(
    @Body(new ZodValidationPipe(updateAccountProfileBodySchema)) body: UpdateAccountProfileBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AccountProfile> {
    return this.profiles.update(session.accountId, body);
  }

  @SessionRoute(apiRoutes.acceptConsents)
  acceptConsents(
    @Body(new ZodValidationPipe(acceptConsentsBodySchema)) body: AcceptConsentsBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AccountProfile> {
    return this.profiles.acceptConsents(session.accountId, body, {
      sessionId: session.sessionId,
    });
  }
}

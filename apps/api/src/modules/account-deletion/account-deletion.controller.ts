import { Body, Controller, Inject } from "@nestjs/common";
import {
  apiRoutes,
  deleteAccountBodySchema,
  type AccountDeletedResponse,
  type AccountDeletionPreview,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { AccountDeletion } from "./account-deletion.service";

/** «Удалить аккаунт» (SCREENS M-PRO-05; TASK-072): the app's session only. */
@Controller()
export class AccountDeletionController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AccountDeletion) private readonly deletion: AccountDeletion) {}

  @SessionRoute(apiRoutes.getAccountDeletion)
  preview(@CurrentSession() session: AuthenticatedSession): Promise<AccountDeletionPreview> {
    return this.deletion.preview(session.accountId);
  }

  @SessionRoute(apiRoutes.deleteAccount)
  delete(
    @Body(new ZodValidationPipe(deleteAccountBodySchema)) _body: unknown,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AccountDeletedResponse> {
    return this.deletion.delete(session.accountId);
  }
}

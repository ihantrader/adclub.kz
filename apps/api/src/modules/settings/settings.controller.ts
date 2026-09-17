import { Body, Controller, Inject, Param } from "@nestjs/common";
import {
  apiRoutes,
  changeSettingBodySchema,
  resetSettingBodySchema,
  settingKeyPathSchema,
  type ChangeSettingBody,
  type ResetSettingBody,
  type SettingChangedResponse,
  type SettingHistoryResponse,
  type SettingKeyPath,
  type SettingListResponse,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { SettingsChangeService, type SettingChangeActor } from "./settings-change.service";

/** The administrator a session of the `admin` context belongs to (the access rule set it). */
function adminActor(session: AuthenticatedSession): SettingChangeActor {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return { kind: "admin", adminId: session.adminUserId, accountId: session.accountId };
}

/** Settings in the admin panel (context `admin`; SCREENS A-SET-01, A-SET-02). */
@Controller()
export class SettingsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SettingsChangeService) private readonly settings: SettingsChangeService) {}

  @SessionRoute(apiRoutes.listSettings)
  list(): Promise<SettingListResponse> {
    return this.settings.list();
  }

  @SessionRoute(apiRoutes.changeSetting)
  change(
    @Param(new ZodValidationPipe(settingKeyPathSchema)) params: SettingKeyPath,
    @Body(new ZodValidationPipe(changeSettingBodySchema)) body: ChangeSettingBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SettingChangedResponse> {
    return this.settings.change({
      key: params.key,
      value: body.value,
      expectedVersion: body.expectedVersion,
      reason: body.reason,
      actor: adminActor(session),
    });
  }

  @SessionRoute(apiRoutes.resetSetting)
  reset(
    @Param(new ZodValidationPipe(settingKeyPathSchema)) params: SettingKeyPath,
    @Body(new ZodValidationPipe(resetSettingBodySchema)) body: ResetSettingBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SettingChangedResponse> {
    return this.settings.reset({
      key: params.key,
      expectedVersion: body.expectedVersion,
      reason: body.reason,
      actor: adminActor(session),
    });
  }

  @SessionRoute(apiRoutes.getSettingHistory)
  history(
    @Param(new ZodValidationPipe(settingKeyPathSchema)) params: SettingKeyPath,
  ): Promise<SettingHistoryResponse> {
    return this.settings.history(params.key);
  }
}

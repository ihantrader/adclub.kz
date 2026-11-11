import { Body, Controller, Headers, Inject, Param, Query } from "@nestjs/common";
import {
  adminAssistantComplaintListQuerySchema,
  apiRoutes,
  assistantComplaintBodySchema,
  assistantComplaintPathSchema,
  assistantDeviceQuerySchema,
  assistantDialogPathSchema,
  assistantMessageBodySchema,
  assistantMessagePathSchema,
  resolveAssistantComplaintBodySchema,
  type AdminAssistantComplaintListQuery,
  type AdminAssistantComplaintPage,
  type AdminAssistantComplaintResponse,
  type AssistantComplaintBody,
  type AssistantComplaintPath,
  type AssistantComplaintResponse,
  type AssistantDeviceQuery,
  type AssistantDialogPath,
  type AssistantDialogResponse,
  type AssistantLimits,
  type AssistantMessageBody,
  type AssistantMessagePath,
  type AssistantMessageResponse,
  type ResolveAssistantComplaintBody,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { ZodValidationPipe } from "../../common/validation";
import { RateLimitedRoute } from "../../rate-limit";
import {
  CurrentSession,
  OptionalSession,
  OptionalSessionRoute,
  SessionRoute,
  type AuthenticatedSession,
} from "../identity";
import { AssistantAdminService, type AssistantAdmin } from "./assistant-admin.service";
import { AssistantService } from "./assistant.service";

/**
 * The assistant for the person (TASK-062; context `user`, the mobile app):
 * open to guests by the device id, as the photo recognitions. Another's
 * dialog or answer is 404, as a missing one.
 */
@Controller()
export class AssistantController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AssistantService) private readonly assistant: AssistantService) {}

  @RateLimitedRoute(apiRoutes.sendAssistantMessage)
  send(
    @Body(new ZodValidationPipe(assistantMessageBodySchema)) body: AssistantMessageBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @OptionalSession() session: AuthenticatedSession | null,
  ): Promise<AssistantMessageResponse> {
    return this.assistant.send(session, body, pickLanguage(acceptLanguage));
  }

  @OptionalSessionRoute(apiRoutes.getAssistantDialog)
  dialog(
    @Param(new ZodValidationPipe(assistantDialogPathSchema)) params: AssistantDialogPath,
    @Query(new ZodValidationPipe(assistantDeviceQuerySchema)) query: AssistantDeviceQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @OptionalSession() session: AuthenticatedSession | null,
  ): Promise<AssistantDialogResponse> {
    return this.assistant.dialogView(
      session,
      query.deviceId,
      params.dialogId,
      pickLanguage(acceptLanguage),
    );
  }

  @OptionalSessionRoute(apiRoutes.getAssistantLimits)
  limits(
    @Query(new ZodValidationPipe(assistantDeviceQuerySchema)) query: AssistantDeviceQuery,
    @OptionalSession() session: AuthenticatedSession | null,
  ): Promise<AssistantLimits> {
    return this.assistant.left(session, query.deviceId);
  }

  @OptionalSessionRoute(apiRoutes.complainAboutAssistantMessage)
  complain(
    @Param(new ZodValidationPipe(assistantMessagePathSchema)) params: AssistantMessagePath,
    @Body(new ZodValidationPipe(assistantComplaintBodySchema)) body: AssistantComplaintBody,
    @OptionalSession() session: AuthenticatedSession | null,
  ): Promise<AssistantComplaintResponse> {
    return this.assistant.complain(session, params.messageId, body);
  }
}

function adminOf(session: AuthenticatedSession): AssistantAdmin {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return { adminId: session.adminUserId, accountId: session.accountId };
}

/** Complaints about answers of the assistant (context `admin`). */
@Controller()
export class AdminAssistantController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AssistantAdminService) private readonly admin: AssistantAdminService) {}

  @SessionRoute(apiRoutes.listAdminAssistantComplaints)
  list(
    @Query(new ZodValidationPipe(adminAssistantComplaintListQuerySchema))
    query: AdminAssistantComplaintListQuery,
  ): Promise<AdminAssistantComplaintPage> {
    return this.admin.list(query);
  }

  @SessionRoute(apiRoutes.getAdminAssistantComplaint)
  one(
    @Param(new ZodValidationPipe(assistantComplaintPathSchema)) params: AssistantComplaintPath,
  ): Promise<AdminAssistantComplaintResponse> {
    return this.admin.one(params.complaintId);
  }

  @SessionRoute(apiRoutes.resolveAdminAssistantComplaint)
  resolve(
    @Param(new ZodValidationPipe(assistantComplaintPathSchema)) params: AssistantComplaintPath,
    @Body(new ZodValidationPipe(resolveAssistantComplaintBodySchema))
    body: ResolveAssistantComplaintBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminAssistantComplaintResponse> {
    return this.admin.resolve(params.complaintId, body, adminOf(session));
  }
}

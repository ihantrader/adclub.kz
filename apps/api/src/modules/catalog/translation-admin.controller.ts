import { Body, Controller, Inject, Param, Query } from "@nestjs/common";
import {
  apiRoutes,
  editTranslationBodySchema,
  translationEntityPathSchema,
  translationQueueQuerySchema,
  translationTargetPathSchema,
  type EditTranslationBody,
  type EntityTranslationsResponse,
  type TranslationEntityPath,
  type TranslationQueuePage,
  type TranslationQueueQuery,
  type TranslationTargetPath,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { adminActor } from "./catalog-admin.controller";
import { TranslationAdminService } from "./translation-admin.service";

/** Translations of the catalog in the admin panel (context `admin`; SCREENS A-CAT-05). */
@Controller()
export class TranslationAdminController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(TranslationAdminService) private readonly translations: TranslationAdminService,
  ) {}

  @SessionRoute(apiRoutes.listTranslationQueue)
  queue(
    @Query(new ZodValidationPipe(translationQueueQuerySchema)) query: TranslationQueueQuery,
  ): Promise<TranslationQueuePage> {
    return this.translations.queueList(query);
  }

  @SessionRoute(apiRoutes.getEntityTranslations)
  get(
    @Param(new ZodValidationPipe(translationEntityPathSchema)) params: TranslationEntityPath,
  ): Promise<EntityTranslationsResponse> {
    return this.translations.get(params.entityType, params.entityId);
  }

  @SessionRoute(apiRoutes.editTranslation)
  edit(
    @Param(new ZodValidationPipe(translationTargetPathSchema)) params: TranslationTargetPath,
    @Body(new ZodValidationPipe(editTranslationBodySchema)) body: EditTranslationBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<EntityTranslationsResponse> {
    return this.translations.edit(
      params.entityType,
      params.entityId,
      params.field,
      params.lang,
      body.text,
      adminActor(session),
    );
  }

  @SessionRoute(apiRoutes.releaseTranslation)
  release(
    @Param(new ZodValidationPipe(translationTargetPathSchema)) params: TranslationTargetPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<EntityTranslationsResponse> {
    return this.translations.release(
      params.entityType,
      params.entityId,
      params.field,
      params.lang,
      adminActor(session),
    );
  }

  @SessionRoute(apiRoutes.retranslate)
  retranslate(
    @Param(new ZodValidationPipe(translationTargetPathSchema)) params: TranslationTargetPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<EntityTranslationsResponse> {
    return this.translations.retranslate(
      params.entityType,
      params.entityId,
      params.field,
      params.lang,
      adminActor(session),
    );
  }
}

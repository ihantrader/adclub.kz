import { Body, Controller, Inject, Param, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  apiRoutes,
  catalogItemIdPathSchema,
  itemPhotoPathSchema,
  reorderItemPhotosBodySchema,
  setItemPhotoStatusBodySchema,
  uploadItemPhotoQuerySchema,
  type AdminItemPhotosResponse,
  type CatalogItemIdPath,
  type ItemPhotoPath,
  type ReorderItemPhotosBody,
  type SetItemPhotoStatusBody,
  type UploadItemPhotoQuery,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { adminActor } from "./catalog-admin.controller";
import { CatalogPhotosService } from "./catalog-photos.service";

/**
 * Photos of items in the admin panel (context `admin`; TASK-013; SCREENS
 * A-CAT-05, tab "Фото"). The screens themselves are TASK-035.
 *
 * The upload takes the file as the body — the only route of the API that
 * isn't JSON (ARCHITECTURE 4.22); `UploadBodyMiddleware` has already
 * checked the declared type and read the bytes by then. The body isn't
 * described by a zod schema for that reason, so the handler takes the
 * request itself; everything the request says besides the bytes is in the
 * path and the query, validated as usual.
 */
@Controller()
export class CatalogPhotosController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService) {}

  @SessionRoute(apiRoutes.uploadItemPhoto)
  async upload(
    @Param(new ZodValidationPipe(catalogItemIdPathSchema)) params: CatalogItemIdPath,
    @Query(new ZodValidationPipe(uploadItemPhotoQuerySchema)) query: UploadItemPhotoQuery,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminItemPhotosResponse> {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const result = await this.photos.upload(params.itemId, body, query, adminActor(session));
    // 201 for a picture that was stored, 200 for one the item already had
    // (both are documented; nothing is stored twice).
    response.status(result.created ? 201 : 200);
    return result.response;
  }

  @SessionRoute(apiRoutes.listItemPhotos)
  list(
    @Param(new ZodValidationPipe(catalogItemIdPathSchema)) params: CatalogItemIdPath,
  ): Promise<AdminItemPhotosResponse> {
    return this.photos.list(params.itemId);
  }

  @SessionRoute(apiRoutes.setItemPhotoStatus)
  setStatus(
    @Param(new ZodValidationPipe(itemPhotoPathSchema)) params: ItemPhotoPath,
    @Body(new ZodValidationPipe(setItemPhotoStatusBodySchema)) body: SetItemPhotoStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminItemPhotosResponse> {
    return this.photos.setStatus(params.itemId, params.photoId, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.reorderItemPhotos)
  reorder(
    @Param(new ZodValidationPipe(catalogItemIdPathSchema)) params: CatalogItemIdPath,
    @Body(new ZodValidationPipe(reorderItemPhotosBodySchema)) body: ReorderItemPhotosBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminItemPhotosResponse> {
    return this.photos.reorder(params.itemId, body, adminActor(session));
  }
}

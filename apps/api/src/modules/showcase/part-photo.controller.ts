import { Controller, Headers, Inject, Query, Req, Res } from "@nestjs/common";
import {
  apiRoutes,
  partPhotoQuerySchema,
  type PartPhotoQuery,
  type PartPhotoResponse,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import type { Request, Response } from "express";
import { ZodValidationPipe } from "../../common/validation";
import { OptionalSession, OptionalSessionRoute, type AuthenticatedSession } from "../identity";
import { photoReaderOf } from "../vehicle-document";
import { PartPhotoService } from "./part-photo.service";
import { ShowcaseService } from "./showcase.service";

/**
 * A part found by a photo of its article (TASK-058, M-CAT-06). Open to a
 * guest, counted with the certificate (the reader is the account of a
 * session or the device a guest names). The answer depends on the photo and
 * the person: nobody keeps it.
 */
@Controller()
export class PartPhotoController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(PartPhotoService) private readonly parts: PartPhotoService,
    @Inject(ShowcaseService) private readonly showcase: ShowcaseService,
  ) {}

  @OptionalSessionRoute(apiRoutes.recognizePartPhoto)
  async recognize(
    @Query(new ZodValidationPipe(partPhotoQuerySchema)) query: PartPhotoQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @OptionalSession() session: AuthenticatedSession | null,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PartPhotoResponse> {
    const reader = photoReaderOf(session, query.deviceId, request);
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const lang = pickLanguage(acceptLanguage);
    const viewer = await this.showcase.viewer(session);
    const answer = await this.parts.recognize(reader, body, query, viewer, lang);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Language", lang);
    return answer;
  }
}

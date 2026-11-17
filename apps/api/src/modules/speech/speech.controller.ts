import { Controller, Headers, Inject, Query, Req } from "@nestjs/common";
import {
  apiRoutes,
  speechQuerySchema,
  type SpeechQuery,
  type SpeechTranscription,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import type { Request } from "express";
import { ZodValidationPipe } from "../../common/validation";
import { RateLimitedRoute } from "../../rate-limit";
import { OptionalSession, type AuthenticatedSession } from "../identity";
import { photoReaderOf } from "../vehicle-document";
import { SpeechRecognitions } from "./speech.service";

/**
 * Voice input (TASK-059, SCREENS M-CAT-05). Open to a guest: the reader is
 * the account of a session, or the device id a guest sends, as for a photo.
 * The body is the recording itself: `UploadBodyMiddleware` has checked the
 * declared type and read the bytes, and they live in this request only.
 * The language of the interface and the field the text goes into
 * (`purpose`, TASK-060) go to the model as hints.
 */
@Controller()
export class SpeechController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SpeechRecognitions) private readonly speech: SpeechRecognitions) {}

  // The limit by address of every request, refused ones included, is counted
  // before the body is read (TASK-059.A); the trial attempts — by the service.
  @RateLimitedRoute(apiRoutes.transcribeSpeech)
  transcribe(
    @Query(new ZodValidationPipe(speechQuerySchema)) query: SpeechQuery,
    @OptionalSession() session: AuthenticatedSession | null,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @Req() request: Request,
  ): Promise<SpeechTranscription> {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    return this.speech.transcribe(
      photoReaderOf(session, query.deviceId, request),
      body,
      pickLanguage(acceptLanguage),
      query.purpose ?? "search",
    );
  }
}

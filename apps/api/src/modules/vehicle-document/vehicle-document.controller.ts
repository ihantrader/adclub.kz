import { Controller, Inject, Query, Req } from "@nestjs/common";
import {
  apiRoutes,
  vehicleDocumentQuerySchema,
  type VehicleDocumentAttempts,
  type VehicleDocumentQuery,
  type VehicleDocumentResponse,
} from "@adclub/contracts";
import type { Request } from "express";
import { ApiException } from "../../common/errors";
import { ZodValidationPipe } from "../../common/validation";
import { OptionalSession, OptionalSessionRoute, type AuthenticatedSession } from "../identity";
import type { DocumentReader } from "./document-attempts";
import { VehicleDocumentService } from "./vehicle-document.service";

/**
 * A car read off a photographed registration certificate (TASK-057,
 * SCREENS M-GAR-04). Open to a guest — the first run adds a car before any
 * sign-in — so the reader is the account of a session, or the device id a
 * guest sends. The body is the photo itself: `UploadBodyMiddleware` has
 * checked the declared type and read the bytes, and they live in this
 * request only.
 */
@Controller()
export class VehicleDocumentController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(VehicleDocumentService) private readonly documents: VehicleDocumentService) {}

  @OptionalSessionRoute(apiRoutes.recognizeVehicleDocument)
  recognize(
    @Query(new ZodValidationPipe(vehicleDocumentQuerySchema)) query: VehicleDocumentQuery,
    @OptionalSession() session: AuthenticatedSession | null,
    @Req() request: Request,
  ): Promise<VehicleDocumentResponse> {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    return this.documents.recognize(readerOf(session, query, request), body);
  }

  @OptionalSessionRoute(apiRoutes.getVehicleDocumentAttempts)
  attempts(
    @Query(new ZodValidationPipe(vehicleDocumentQuerySchema)) query: VehicleDocumentQuery,
    @OptionalSession() session: AuthenticatedSession | null,
    @Req() request: Request,
  ): Promise<VehicleDocumentAttempts> {
    return this.documents.left(readerOf(session, query, request));
  }
}

function readerOf(
  session: AuthenticatedSession | null,
  query: VehicleDocumentQuery,
  request: Request,
): DocumentReader {
  if (session) {
    return { kind: "account", accountId: session.accountId };
  }
  if (!query.deviceId) {
    throw new ApiException(400, "VALIDATION_ERROR", "A guest names the device", {
      details: [{ path: "deviceId", message: "Required for a guest" }],
    });
  }
  return { kind: "guest", deviceId: query.deviceId, ip: request.ip };
}

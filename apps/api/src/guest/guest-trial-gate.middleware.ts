import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { ApiException, bodyParserException } from "../common/errors";
import { parseJsonBody } from "../common/http/json-parser";
import { contractPathOf } from "../common/http/upload-routes";
import { AppSettings } from "../modules/settings";
import { deviceIdOf, GuestActivity, type GuestTrialKind } from "./guest-activity";
import { guestTrialRouteFor, isGuestRequest } from "./guest-trial-routes";

export function guestSignInRequiredException(): ApiException {
  return new ApiException(
    403,
    "GUEST_SIGN_IN_REQUIRED",
    "AI features are for signed-in people only right now; sign in to use them",
  );
}

/**
 * The one gate of a guest's AI trial (TASK-066; ARCHITECTURE 8.6): on every
 * `guestAiTrial` route of the contract — the three photos, voice, the
 * assistant. With `guest_attestation_required` on, a guest is refused 403
 * `GUEST_SIGN_IN_REQUIRED` here, before the body is read: the application's
 * JSON parser leaves a guest's body of these routes alone
 * (`appJsonParserReads`), and this runs ahead of the file reader, so no
 * trial attempt is counted and no model is called. There is no App Attest /
 * Play Integrity yet (BACKLOG), so no guest request carries a proof: the
 * setting is the switch «AI for signed-in people only». A signed-in person
 * passes untouched.
 *
 * Let through, a guest's JSON body is read here with the application's
 * parser and limit (`parseJsonBody`), and a served request (2xx) is counted
 * for the signs of the switch (`GuestActivity`) once the answer is sent:
 * the device id is then in the query (a photo, a recording) or the body
 * (the assistant).
 */
@Injectable()
export class GuestTrialGateMiddleware implements NestMiddleware {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(GuestActivity) private readonly activity: GuestActivity,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const found = guestTrialRouteFor(request.method, contractPathOf(request));
    if (!found || !isGuestRequest(request)) {
      next();
      return;
    }
    this.settings.get("guest_attestation_required").then(
      (required) => {
        if (required) {
          next(guestSignInRequiredException());
          return;
        }
        this.countWhenServed(request, response, found.kind);
        // A file is read by `UploadBodyMiddleware`, as for anyone.
        if (found.route.upload) {
          next();
          return;
        }
        parseJsonBody(request, response, (error?: unknown) => {
          next(error === undefined ? undefined : (bodyParserException(error) ?? error));
        });
      },
      (error: unknown) => next(error),
    );
  }

  private countWhenServed(request: Request, response: Response, kind: GuestTrialKind): void {
    response.on("finish", () => {
      if (response.statusCode < 200 || response.statusCode >= 300) return;
      const body = request.body as { deviceId?: unknown } | undefined;
      const deviceId =
        deviceIdOf(request.query?.deviceId) ??
        (body && !Buffer.isBuffer(body) ? deviceIdOf(body.deviceId) : null);
      if (deviceId) {
        void this.activity.record({ deviceId, ip: request.ip, kind });
      }
    });
  }
}

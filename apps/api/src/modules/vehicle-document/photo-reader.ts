import type { Request } from "express";
import { ApiException } from "../../common/errors";
import type { AuthenticatedSession } from "../identity";
import type { DocumentReader } from "./document-attempts";

/**
 * Who reads a photo, as the limits see it (TASK-057, TASK-058): the account
 * of a session, or — for a guest — the device id the app sends and the
 * address of the request. A guest without a device id is refused: the trial
 * recognitions are counted per device.
 */
export function photoReaderOf(
  session: AuthenticatedSession | null,
  deviceId: string | undefined,
  request: Request,
): DocumentReader {
  if (session) {
    return { kind: "account", accountId: session.accountId };
  }
  if (!deviceId) {
    throw new ApiException(400, "VALIDATION_ERROR", "A guest names the device", {
      details: [{ path: "deviceId", message: "Required for a guest" }],
    });
  }
  return { kind: "guest", deviceId, ip: request.ip };
}

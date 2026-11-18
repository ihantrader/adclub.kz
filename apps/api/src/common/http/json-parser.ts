import type { IncomingMessage } from "node:http";
import { json } from "express";
import { guestTrialRouteFor, isGuestRequest } from "../../guest/guest-trial-routes";
import { contractPathOf, mediaTypeOf, uploadRouteFor } from "./upload-routes";

type ParsedRequest = IncomingMessage & { originalUrl?: string };

const isJson = (request: IncomingMessage) =>
  mediaTypeOf(String(request.headers["content-type"] ?? "")) === "application/json";

/**
 * Whether the JSON parser of the application reads a request's body
 * (`configureHttpApp`): an `application/json` body of any route, except
 *
 * - a route that takes its body as bytes (`uploadRouteFor`);
 * - a guest's request to a route of a guest's AI trial (TASK-066): the gate
 *   of `guest_attestation_required` (`GuestTrialGateMiddleware`) decides
 *   about it before its body is read, and reads it then with `parseJsonBody`
 *   — the same parser, the same limit.
 */
export function appJsonParserReads(request: ParsedRequest): boolean {
  if (!isJson(request)) return false;
  const path = contractPathOf({ originalUrl: request.originalUrl, url: request.url ?? "/" });
  const method = request.method ?? "GET";
  if (uploadRouteFor(method, path) !== null) return false;
  return !(guestTrialRouteFor(method, path) && isGuestRequest(request));
}

/** The JSON parser of a body the application's parser left for later (`appJsonParserReads`). */
export const parseJsonBody = json({ type: isJson });

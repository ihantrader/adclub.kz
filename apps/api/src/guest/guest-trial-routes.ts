import type { IncomingHttpHeaders } from "node:http";
import { guestAiTrialRoutes, type ApiRouteDefinition } from "@adclub/contracts";
import type { GuestTrialKind } from "./guest-activity";

/** What each route of a guest's trial spends (the counters of `GuestActivity`). */
const KIND_OF: Readonly<Record<string, GuestTrialKind>> = {
  recognizeVehicleDocument: "photo",
  recognizeDashboard: "photo",
  recognizePartPhoto: "photo",
  transcribeSpeech: "speech",
  sendAssistantMessage: "assistant",
};

/** The route of a guest's AI trial (`guestAiTrial` of the contract) a request is for, or `null`. */
export function guestTrialRouteFor(
  method: string,
  path: string,
): { route: ApiRouteDefinition; kind: GuestTrialKind } | null {
  const upper = method.toUpperCase();
  // Case-insensitive and with a trailing slash, as Express routes; none of
  // these routes has path parameters (the contract's test holds it).
  const normalized = path.toLowerCase().replace(/(.)\/$/, "$1");
  for (const route of guestAiTrialRoutes) {
    if (route.method === upper && route.path.toLowerCase() === normalized) {
      const kind = KIND_OF[route.operationId];
      if (!kind) throw new Error(`The guest trial route ${route.operationId} has no kind`);
      return { route, kind };
    }
  }
  return null;
}

/**
 * A guest as the routes of a trial see one: a request without
 * `Authorization`. A request that sends one is held by `OptionalSessionGuard`
 * to the rules of a session route (an invalid token is 401, never a guest),
 * so nothing passes here as signed in without being so.
 */
export function isGuestRequest(request: { headers: IncomingHttpHeaders }): boolean {
  return request.headers.authorization === undefined;
}

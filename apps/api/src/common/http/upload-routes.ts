import { apiRoutes, isUploadRoute, type ApiRouteDefinition } from "@adclub/contracts";
import { WHATSAPP_WEBHOOK_BODY, WHATSAPP_WEBHOOK_PATH } from "./raw-body-routes";

/**
 * Which requests bring a body the server reads as bytes rather than
 * parsing (TASK-013; ARCHITECTURE 4.22, 4.35). Two kinds, and both come
 * from a declaration rather than from a list kept in step by hand:
 *
 * - a contract route that declares an `upload` (a photo, a vehicle import);
 * - the provider's webhook, which is outside the client contract but whose
 *   body must reach the handler exactly as it was sent: the signature is
 *   over those bytes, and JSON parsed and written again is not them.
 *
 * The body-type check lets exactly these through, and exactly these get
 * their body read as bytes with the declared ceiling.
 */

interface UploadMatcher {
  route: Pick<ApiRouteDefinition, "method" | "upload">;
  pattern: RegExp;
}

/** `/a/{id}/photos` → `^/a/[^/]+/photos/?$`; contract paths hold no regexp characters. */
function patternOf(path: string): RegExp {
  // Case-insensitive, as Express routes are: a route reached by another
  // spelling of its path must still be read the way the route is declared.
  return new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}/?$`, "i");
}

const matchers: readonly UploadMatcher[] = [
  ...Object.values(apiRoutes)
    .filter((route: ApiRouteDefinition) => isUploadRoute(route))
    .map((route: ApiRouteDefinition) => ({ route, pattern: patternOf(route.path) })),
  {
    route: { method: "POST" as const, upload: WHATSAPP_WEBHOOK_BODY },
    pattern: patternOf(WHATSAPP_WEBHOOK_PATH),
  },
];

/**
 * The route with a raw body a request is for, or `null` — a request to
 * another route, or to the same path with another method (a `GET` of the
 * photos list is not an upload, and the webhook's subscription check is a
 * `GET` with no body at all).
 */
export function uploadRouteFor(
  method: string,
  path: string,
): Pick<ApiRouteDefinition, "method" | "upload"> | null {
  const upper = method.toUpperCase();
  return (
    matchers.find((matcher) => matcher.route.method === upper && matcher.pattern.test(path))
      ?.route ?? null
  );
}

/**
 * The path of a request as the contract writes it. Taken from
 * `originalUrl`: inside a mounted middleware Express makes `req.path`
 * relative to the mount point, and middleware bound to every route is
 * mounted at one.
 */
export function contractPathOf(request: { originalUrl?: string; url: string }): string {
  const url = request.originalUrl ?? request.url;
  // The absolute form of a request target (`POST http://host/path`) names the
  // same route as its path does: Express routes on the path alone, so the
  // decision about the body must be made on the path alone too.
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "") || "/";
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end) || "/";
}

/** The media type of a request, without its parameters (`; charset=…`). */
export function mediaTypeOf(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

import { apiRoutes, isUploadRoute, type ApiRouteDefinition } from "@adclub/contracts";

/**
 * Which requests carry a file rather than JSON (TASK-013; ARCHITECTURE
 * 4.22). The answer comes from the contract itself — a route that declares
 * an `upload` — so adding such a route needs no second list kept in step:
 * the body-type check lets exactly these through, and exactly these get
 * their body read as bytes.
 */

interface UploadMatcher {
  route: ApiRouteDefinition;
  pattern: RegExp;
}

/** `/a/{id}/photos` → `^/a/[^/]+/photos/?$`; contract paths hold no regexp characters. */
function patternOf(path: string): RegExp {
  return new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}/?$`);
}

const matchers: readonly UploadMatcher[] = Object.values(apiRoutes)
  .filter((route: ApiRouteDefinition) => isUploadRoute(route))
  .map((route: ApiRouteDefinition) => ({ route, pattern: patternOf(route.path) }));

/**
 * The upload route a request is for, or `null` — a request to another
 * route, or to the same path with another method (a `GET` of the photos
 * list is not an upload).
 */
export function uploadRouteFor(method: string, path: string): ApiRouteDefinition | null {
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
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** The media type of a request, without its parameters (`; charset=…`). */
export function mediaTypeOf(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

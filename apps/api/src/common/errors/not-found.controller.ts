import { All, Controller, Inject, NotFoundException, Req } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { Request } from "express";
import { ApiException } from "./api.exception";

interface RouterLayer {
  route?: { path?: unknown; methods: Record<string, boolean> };
  match?: (path: string) => boolean;
}

/**
 * Catches every request no controller matched and turns it into the same
 * unified error format as everything else (AC-5): `METHOD_NOT_ALLOWED`
 * (405, with `Allow`) when the path exists under other methods,
 * `NOT_FOUND` (404) otherwise (TASK-009.A). Must stay the last controller
 * registered — see AppModule/WorkerModule wiring.
 */
@Controller()
export class NotFoundController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost) {}

  @All("*")
  handleUnmatchedRoute(@Req() request: Request): never {
    const allowed = this.methodsServedFor(request.path);
    if (allowed.length > 0) {
      throw new ApiException(405, "METHOD_NOT_ALLOWED", "This method is not allowed here", {
        headers: { Allow: allowed.join(", ") },
      });
    }
    throw new NotFoundException("Route not found");
  }

  /** Methods other routes of the Express router take for this path (not this catch-all). */
  private methodsServedFor(path: string): string[] {
    const instance = this.adapter.httpAdapter?.getInstance() as
      { router?: { stack?: RouterLayer[] } } | undefined;
    const methods = new Set<string>();
    for (const layer of instance?.router?.stack ?? []) {
      const routeMethods = layer.route?.methods;
      // Wildcard routes (this catch-all) match every path: they say nothing.
      if (
        !routeMethods ||
        routeMethods._all ||
        String(layer.route?.path).includes("*") ||
        typeof layer.match !== "function"
      ) {
        continue;
      }
      if (layer.match(path)) {
        for (const method of Object.keys(routeMethods)) {
          methods.add(method.toUpperCase());
        }
      }
    }
    if (methods.has("GET")) {
      methods.add("HEAD");
    }
    return [...methods].sort();
  }
}

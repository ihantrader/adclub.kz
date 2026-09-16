import type { INestApplication } from "@nestjs/common";

export interface ServedRoute {
  method: string;
  path: string;
}

interface ExpressLayer {
  route?: { path: unknown; methods: Record<string, boolean> };
}

/**
 * Routes the running Express instance actually serves, read from its
 * router after `app.init()` — the ground truth the contract is checked
 * against, not what controllers are assumed to declare.
 */
export function listServedRoutes(app: INestApplication): ServedRoute[] {
  const instance = app.getHttpAdapter().getInstance() as { router?: { stack: ExpressLayer[] } };
  const stack = instance.router?.stack;
  if (!stack) {
    throw new Error(
      "Cannot read the Express router: listServedRoutes needs an initialized Express app",
    );
  }

  const routes: ServedRoute[] = [];
  for (const layer of stack) {
    if (!layer.route) {
      continue;
    }
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const method of Object.keys(layer.route.methods)) {
      for (const path of paths) {
        routes.push({
          method: method === "_all" ? "ALL" : method.toUpperCase(),
          path: String(path),
        });
      }
    }
  }
  return routes;
}

import { Controller, Get, Header } from "@nestjs/common";
import { apiRoutes, buildOpenApiDocument, type OpenApiDocument } from "@adclub/contracts";

/** Paths served only outside production, not part of the public contract. */
export const DEV_ONLY_PATHS = ["/openapi.json", "/docs"] as const;

const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>adclub.kz API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui" });</script>
</body>
</html>
`;

/**
 * Development aid (TASK-003): the OpenAPI document generated from
 * `@adclub/contracts` — the same function that writes the committed
 * `apps/api/openapi.json` — and a Swagger UI page to browse it. Registered
 * only outside production (see `AppModule.forRoot`).
 */
@Controller()
export class OpenApiController {
  private readonly document = buildOpenApiDocument(Object.values(apiRoutes));

  @Get("openapi.json")
  getDocument(): OpenApiDocument {
    return this.document;
  }

  @Get("docs")
  @Header("Content-Type", "text/html; charset=utf-8")
  getDocs(): string {
    return DOCS_HTML;
  }
}

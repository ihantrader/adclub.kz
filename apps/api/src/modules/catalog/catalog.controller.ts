import { Controller, Headers, Inject, Param, Res } from "@nestjs/common";
import {
  apiRoutes,
  CATALOG_CLIENT_CACHE_SECONDS,
  catalogCategoryPathSchema,
  type CatalogCategoryPath,
  type CategoryAttributesResponse,
  type CategoryTreeResponse,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import type { Response } from "express";
import { ApiRoute } from "../../common/contract";
import { ZodValidationPipe } from "../../common/validation";
import { CatalogReadService } from "./catalog-read.service";

/**
 * Answers depend on the language only, not on who asks: any client (a
 * guest too) and any proxy may keep one for a minute. Express adds a weak
 * `ETag` and answers a matching conditional request with 304.
 */
function cacheable(response: Response, lang: string): void {
  response.setHeader("Cache-Control", `public, max-age=${CATALOG_CLIENT_CACHE_SECONDS}`);
  response.vary("Accept-Language");
  response.setHeader("Content-Language", lang);
}

/** The catalog for every client, guests included (PRODUCT 6.6; ARCHITECTURE 4.15). */
@Controller()
export class CatalogController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(CatalogReadService) private readonly catalog: CatalogReadService) {}

  @ApiRoute(apiRoutes.getCatalogCategories)
  async categories(
    @Headers("accept-language") acceptLanguage: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CategoryTreeResponse> {
    const lang = pickLanguage(acceptLanguage);
    const tree = await this.catalog.tree(lang);
    cacheable(response, lang);
    return tree;
  }

  @ApiRoute(apiRoutes.getCatalogCategoryAttributes)
  async attributes(
    @Param(new ZodValidationPipe(catalogCategoryPathSchema)) params: CatalogCategoryPath,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CategoryAttributesResponse> {
    const lang = pickLanguage(acceptLanguage);
    const described = await this.catalog.attributes(params.categoryId, lang);
    cacheable(response, lang);
    return described;
  }
}

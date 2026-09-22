import { Controller, Headers, Inject, Param, Query, Res } from "@nestjs/common";
import {
  apiRoutes,
  CATALOG_CLIENT_CACHE_SECONDS,
  showcaseCategoryPathSchema,
  showcaseItemPathSchema,
  showcaseItemQuerySchema,
  showcaseListQuerySchema,
  type ShowcaseCategoryPath,
  type ShowcaseItemPath,
  type ShowcaseItemQuery,
  type ShowcaseItemResponse,
  type ShowcaseListQuery,
  type ShowcaseListResponse,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import type { Response } from "express";
import { ZodValidationPipe } from "../../common/validation";
import { OptionalSession, OptionalSessionRoute, type AuthenticatedSession } from "../identity";
import { ShowcaseService } from "./showcase.service";

/**
 * Caching that never mixes roles (TASK-020 requirement 4; ARCHITECTURE
 * 4.29): an answer depends on who asks, so every answer `Vary`s on
 * `Authorization` (and the language). A guest's answer is the same for
 * every guest — any cache may keep it for a minute, like the category
 * tree. An answer to a session (a user with or without club access) may
 * be kept by nobody but that client, and not even by it
 * (`private, no-store`): it can't reach a guest through a shared proxy,
 * nor another person through a shared device's cache.
 */
export function roleSafeCaching(response: Response, lang: string, signedIn: boolean): void {
  response.setHeader(
    "Cache-Control",
    signedIn ? "private, no-store" : `public, max-age=${CATALOG_CLIENT_CACHE_SECONDS}`,
  );
  response.vary("Authorization");
  response.vary("Accept-Language");
  response.setHeader("Content-Language", lang);
}

/** The catalog for users (M-CAT-02, M-CAT-03, M-CAT-07), guests included. */
@Controller()
export class ShowcaseController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(ShowcaseService) private readonly showcase: ShowcaseService) {}

  @OptionalSessionRoute(apiRoutes.getShowcaseItems)
  async list(
    @Param(new ZodValidationPipe(showcaseCategoryPathSchema)) params: ShowcaseCategoryPath,
    @Query(new ZodValidationPipe(showcaseListQuerySchema)) query: ShowcaseListQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @OptionalSession() session: AuthenticatedSession | null,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShowcaseListResponse> {
    const lang = pickLanguage(acceptLanguage);
    const viewer = await this.showcase.viewer(session);
    const answer = await this.showcase.list(params.categoryId, query, viewer, lang);
    roleSafeCaching(response, lang, session !== null);
    return answer;
  }

  @OptionalSessionRoute(apiRoutes.getShowcaseItem)
  async card(
    @Param(new ZodValidationPipe(showcaseItemPathSchema)) params: ShowcaseItemPath,
    @Query(new ZodValidationPipe(showcaseItemQuerySchema)) query: ShowcaseItemQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @OptionalSession() session: AuthenticatedSession | null,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShowcaseItemResponse> {
    const lang = pickLanguage(acceptLanguage);
    const viewer = await this.showcase.viewer(session);
    const answer = await this.showcase.card(params.itemId, query, viewer, lang);
    roleSafeCaching(response, lang, session !== null);
    return answer;
  }
}

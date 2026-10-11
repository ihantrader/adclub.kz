import { Body, Controller, Inject, Param } from "@nestjs/common";
import {
  addSearchSynonymBodySchema,
  apiRoutes,
  catalogItemIdPathSchema,
  categoryIdPathSchema,
  searchSynonymPathSchema,
  type AddSearchSynonymBody,
  type CatalogItemIdPath,
  type CategoryIdPath,
  type SearchSynonymList,
  type SearchSynonymPath,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { adminActor } from "./catalog-admin.controller";
import { CatalogSynonymsService } from "./catalog-synonyms.service";

/** Search synonyms of items and categories in the admin panel (TASK-044; context `admin`). */
@Controller()
export class CatalogSynonymsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(CatalogSynonymsService) private readonly synonyms: CatalogSynonymsService) {}

  @SessionRoute(apiRoutes.listItemSearchSynonyms)
  listOfItem(
    @Param(new ZodValidationPipe(catalogItemIdPathSchema)) params: CatalogItemIdPath,
  ): Promise<SearchSynonymList> {
    return this.synonyms.list({ kind: "item", id: params.itemId });
  }

  @SessionRoute(apiRoutes.addItemSearchSynonym)
  addToItem(
    @Param(new ZodValidationPipe(catalogItemIdPathSchema)) params: CatalogItemIdPath,
    @Body(new ZodValidationPipe(addSearchSynonymBodySchema)) body: AddSearchSynonymBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SearchSynonymList> {
    return this.synonyms.add({ kind: "item", id: params.itemId }, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.listCategorySearchSynonyms)
  listOfCategory(
    @Param(new ZodValidationPipe(categoryIdPathSchema)) params: CategoryIdPath,
  ): Promise<SearchSynonymList> {
    return this.synonyms.list({ kind: "category", id: params.categoryId });
  }

  @SessionRoute(apiRoutes.addCategorySearchSynonym)
  addToCategory(
    @Param(new ZodValidationPipe(categoryIdPathSchema)) params: CategoryIdPath,
    @Body(new ZodValidationPipe(addSearchSynonymBodySchema)) body: AddSearchSynonymBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SearchSynonymList> {
    return this.synonyms.add(
      { kind: "category", id: params.categoryId },
      body,
      adminActor(session),
    );
  }

  @SessionRoute(apiRoutes.removeSearchSynonym)
  remove(
    @Param(new ZodValidationPipe(searchSynonymPathSchema)) params: SearchSynonymPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SearchSynonymList> {
    return this.synonyms.remove(params.synonymId, adminActor(session));
  }
}

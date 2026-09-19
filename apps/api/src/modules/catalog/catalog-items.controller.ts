import { Body, Controller, Inject, Param, Query } from "@nestjs/common";
import {
  apiRoutes,
  brandIdPathSchema,
  brandListQuerySchema,
  catalogItemIdPathSchema,
  catalogItemListQuerySchema,
  categoryFillQuerySchema,
  categoryIdPathSchema,
  createBrandBodySchema,
  createCatalogItemBodySchema,
  fillCategoryBodySchema,
  itemAnalogPathSchema,
  linkItemAnalogBodySchema,
  setCatalogEntryStatusBodySchema,
  setCatalogItemStatusBodySchema,
  setItemValuesBodySchema,
  updateBrandBodySchema,
  updateCatalogItemBodySchema,
  type AdminBrandPage,
  type AdminBrandResponse,
  type AdminCatalogItemCard,
  type AdminCatalogItemPage,
  type BrandIdPath,
  type BrandListQuery,
  type CatalogItemIdPath,
  type CatalogItemListQuery,
  type CategoryFillPage,
  type CategoryFillQuery,
  type CategoryIdPath,
  type CreateBrandBody,
  type CreateCatalogItemBody,
  type FillCategoryBody,
  type FillCategoryResponse,
  type ItemAnalogPath,
  type LinkItemAnalogBody,
  type SetCatalogEntryStatusBody,
  type SetCatalogItemStatusBody,
  type SetItemValuesBody,
  type UpdateBrandBody,
  type UpdateCatalogItemBody,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { adminActor } from "./catalog-admin.controller";
import { CatalogBrandsService } from "./catalog-brands.service";
import { CatalogItemsService } from "./catalog-items.service";

/**
 * Brands, items, their values and analogs in the admin panel (context
 * `admin`; TASK-011; SCREENS A-CAT-02…A-CAT-05). The screens are TASK-035.
 */
@Controller()
export class CatalogItemsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(CatalogBrandsService) private readonly brands: CatalogBrandsService,
    @Inject(CatalogItemsService) private readonly items: CatalogItemsService,
  ) {}

  // ---------------------------------------------------------------- brands

  @SessionRoute(apiRoutes.listAdminBrands)
  listBrands(
    @Query(new ZodValidationPipe(brandListQuerySchema)) query: BrandListQuery,
  ): Promise<AdminBrandPage> {
    return this.brands.page(query);
  }

  @SessionRoute(apiRoutes.createBrand)
  async createBrand(
    @Body(new ZodValidationPipe(createBrandBodySchema)) body: CreateBrandBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminBrandResponse> {
    return { brand: await this.brands.create(body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.updateBrand)
  async updateBrand(
    @Param(new ZodValidationPipe(brandIdPathSchema)) params: BrandIdPath,
    @Body(new ZodValidationPipe(updateBrandBodySchema)) body: UpdateBrandBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminBrandResponse> {
    return { brand: await this.brands.update(params.brandId, body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.setBrandStatus)
  async setBrandStatus(
    @Param(new ZodValidationPipe(brandIdPathSchema)) params: BrandIdPath,
    @Body(new ZodValidationPipe(setCatalogEntryStatusBodySchema)) body: SetCatalogEntryStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminBrandResponse> {
    return {
      brand: await this.brands.setStatus(
        params.brandId,
        body.status,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }

  // ----------------------------------------------------------------- items

  @SessionRoute(apiRoutes.listAdminCatalogItems)
  listItems(
    @Query(new ZodValidationPipe(catalogItemListQuerySchema)) query: CatalogItemListQuery,
  ): Promise<AdminCatalogItemPage> {
    return this.items.page(query);
  }

  @SessionRoute(apiRoutes.createCatalogItem)
  createItem(
    @Body(new ZodValidationPipe(createCatalogItemBodySchema)) body: CreateCatalogItemBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCatalogItemCard> {
    return this.items.create(body, adminActor(session));
  }

  @SessionRoute(apiRoutes.getAdminCatalogItem)
  item(
    @Param(new ZodValidationPipe(catalogItemIdPathSchema)) params: CatalogItemIdPath,
  ): Promise<AdminCatalogItemCard> {
    return this.items.card(params.itemId);
  }

  @SessionRoute(apiRoutes.updateCatalogItem)
  updateItem(
    @Param(new ZodValidationPipe(catalogItemIdPathSchema)) params: CatalogItemIdPath,
    @Body(new ZodValidationPipe(updateCatalogItemBodySchema)) body: UpdateCatalogItemBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCatalogItemCard> {
    return this.items.update(params.itemId, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.setCatalogItemStatus)
  setItemStatus(
    @Param(new ZodValidationPipe(catalogItemIdPathSchema)) params: CatalogItemIdPath,
    @Body(new ZodValidationPipe(setCatalogItemStatusBodySchema)) body: SetCatalogItemStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCatalogItemCard> {
    return this.items.setStatus(
      params.itemId,
      body.status,
      body.expectedVersion,
      adminActor(session),
    );
  }

  @SessionRoute(apiRoutes.setCatalogItemValues)
  setValues(
    @Param(new ZodValidationPipe(catalogItemIdPathSchema)) params: CatalogItemIdPath,
    @Body(new ZodValidationPipe(setItemValuesBodySchema)) body: SetItemValuesBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCatalogItemCard> {
    return this.items.setValues(params.itemId, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.linkItemAnalog)
  linkAnalog(
    @Param(new ZodValidationPipe(catalogItemIdPathSchema)) params: CatalogItemIdPath,
    @Body(new ZodValidationPipe(linkItemAnalogBodySchema)) body: LinkItemAnalogBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCatalogItemCard> {
    return this.items.linkAnalog(params.itemId, body.analogItemId, adminActor(session));
  }

  @SessionRoute(apiRoutes.unlinkItemAnalog)
  unlinkAnalog(
    @Param(new ZodValidationPipe(itemAnalogPathSchema)) params: ItemAnalogPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCatalogItemCard> {
    return this.items.unlinkAnalog(params.itemId, params.analogItemId, adminActor(session));
  }

  // ------------------------------------------------------------ bulk fill

  @SessionRoute(apiRoutes.getCategoryFill)
  fillPage(
    @Param(new ZodValidationPipe(categoryIdPathSchema)) params: CategoryIdPath,
    @Query(new ZodValidationPipe(categoryFillQuerySchema)) query: CategoryFillQuery,
  ): Promise<CategoryFillPage> {
    return this.items.fillPage(params.categoryId, query);
  }

  @SessionRoute(apiRoutes.fillCategory)
  fill(
    @Param(new ZodValidationPipe(categoryIdPathSchema)) params: CategoryIdPath,
    @Body(new ZodValidationPipe(fillCategoryBodySchema)) body: FillCategoryBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<FillCategoryResponse> {
    return this.items.fill(params.categoryId, body, adminActor(session));
  }
}

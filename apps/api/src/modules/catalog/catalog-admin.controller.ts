import { Body, Controller, Inject, Param } from "@nestjs/common";
import {
  apiRoutes,
  attributeIdPathSchema,
  attributeOptionIdPathSchema,
  categoryIdPathSchema,
  createAttributeBodySchema,
  createAttributeOptionBodySchema,
  createCategoryBodySchema,
  reorderAttributeOptionsBodySchema,
  reorderAttributesBodySchema,
  reorderCategoriesBodySchema,
  setCatalogEntryStatusBodySchema,
  setCategoryStatusBodySchema,
  updateAttributeBodySchema,
  updateAttributeOptionBodySchema,
  updateCategoryBodySchema,
  type AdminAttributeListResponse,
  type AdminAttributeOptionResponse,
  type AdminAttributeResponse,
  type AdminCategoryResponse,
  type AdminCategoryTreeResponse,
  type AttributeIdPath,
  type AttributeOptionIdPath,
  type CategoryIdPath,
  type CreateAttributeBody,
  type CreateAttributeOptionBody,
  type CreateCategoryBody,
  type ReorderAttributeOptionsBody,
  type ReorderAttributesBody,
  type ReorderCategoriesBody,
  type SetCatalogEntryStatusBody,
  type SetCategoryStatusBody,
  type UpdateAttributeBody,
  type UpdateAttributeOptionBody,
  type UpdateCategoryBody,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { CatalogAdminService, type CatalogActor } from "./catalog-admin.service";

/** The administrator a session of the `admin` context belongs to (the access rule set it). */
function adminActor(session: AuthenticatedSession): CatalogActor {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return { role: "admin", adminId: session.adminUserId, accountId: session.accountId };
}

/** The catalog structure in the admin panel (context `admin`; SCREENS A-CAT-01, A-CAT-02). */
@Controller()
export class CatalogAdminController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(CatalogAdminService) private readonly catalog: CatalogAdminService) {}

  @SessionRoute(apiRoutes.listAdminCategories)
  tree(): Promise<AdminCategoryTreeResponse> {
    return this.catalog.tree();
  }

  @SessionRoute(apiRoutes.createCategory)
  async createCategory(
    @Body(new ZodValidationPipe(createCategoryBodySchema)) body: CreateCategoryBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCategoryResponse> {
    return { category: await this.catalog.createCategory(body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.updateCategory)
  async updateCategory(
    @Param(new ZodValidationPipe(categoryIdPathSchema)) params: CategoryIdPath,
    @Body(new ZodValidationPipe(updateCategoryBodySchema)) body: UpdateCategoryBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCategoryResponse> {
    return {
      category: await this.catalog.updateCategory(params.categoryId, body, adminActor(session)),
    };
  }

  @SessionRoute(apiRoutes.setCategoryStatus)
  async setCategoryStatus(
    @Param(new ZodValidationPipe(categoryIdPathSchema)) params: CategoryIdPath,
    @Body(new ZodValidationPipe(setCategoryStatusBodySchema)) body: SetCategoryStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCategoryResponse> {
    return {
      category: await this.catalog.setCategoryStatus(
        params.categoryId,
        body.status,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.reorderCategories)
  reorderCategories(
    @Body(new ZodValidationPipe(reorderCategoriesBodySchema)) body: ReorderCategoriesBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCategoryTreeResponse> {
    return this.catalog.reorderCategories(
      body.parentId,
      body.kind,
      body.categoryIds,
      adminActor(session),
    );
  }

  @SessionRoute(apiRoutes.listAdminAttributes)
  attributes(
    @Param(new ZodValidationPipe(categoryIdPathSchema)) params: CategoryIdPath,
  ): Promise<AdminAttributeListResponse> {
    return this.catalog.attributes(params.categoryId);
  }

  @SessionRoute(apiRoutes.createAttribute)
  async createAttribute(
    @Param(new ZodValidationPipe(categoryIdPathSchema)) params: CategoryIdPath,
    @Body(new ZodValidationPipe(createAttributeBodySchema)) body: CreateAttributeBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminAttributeResponse> {
    return {
      attribute: await this.catalog.createAttribute(params.categoryId, body, adminActor(session)),
    };
  }

  @SessionRoute(apiRoutes.reorderAttributes)
  reorderAttributes(
    @Param(new ZodValidationPipe(categoryIdPathSchema)) params: CategoryIdPath,
    @Body(new ZodValidationPipe(reorderAttributesBodySchema)) body: ReorderAttributesBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminAttributeListResponse> {
    return this.catalog.reorderAttributes(
      params.categoryId,
      body.attributeIds,
      adminActor(session),
    );
  }

  @SessionRoute(apiRoutes.updateAttribute)
  async updateAttribute(
    @Param(new ZodValidationPipe(attributeIdPathSchema)) params: AttributeIdPath,
    @Body(new ZodValidationPipe(updateAttributeBodySchema)) body: UpdateAttributeBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminAttributeResponse> {
    return {
      attribute: await this.catalog.updateAttribute(params.attributeId, body, adminActor(session)),
    };
  }

  @SessionRoute(apiRoutes.setAttributeStatus)
  async setAttributeStatus(
    @Param(new ZodValidationPipe(attributeIdPathSchema)) params: AttributeIdPath,
    @Body(new ZodValidationPipe(setCatalogEntryStatusBodySchema)) body: SetCatalogEntryStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminAttributeResponse> {
    return {
      attribute: await this.catalog.setAttributeStatus(
        params.attributeId,
        body.status,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.createAttributeOption)
  async createOption(
    @Param(new ZodValidationPipe(attributeIdPathSchema)) params: AttributeIdPath,
    @Body(new ZodValidationPipe(createAttributeOptionBodySchema)) body: CreateAttributeOptionBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminAttributeOptionResponse> {
    return {
      option: await this.catalog.createOption(params.attributeId, body, adminActor(session)),
    };
  }

  @SessionRoute(apiRoutes.reorderAttributeOptions)
  async reorderOptions(
    @Param(new ZodValidationPipe(attributeIdPathSchema)) params: AttributeIdPath,
    @Body(new ZodValidationPipe(reorderAttributeOptionsBodySchema))
    body: ReorderAttributeOptionsBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminAttributeResponse> {
    return {
      attribute: await this.catalog.reorderOptions(
        params.attributeId,
        body.optionIds,
        adminActor(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.updateAttributeOption)
  async updateOption(
    @Param(new ZodValidationPipe(attributeOptionIdPathSchema)) params: AttributeOptionIdPath,
    @Body(new ZodValidationPipe(updateAttributeOptionBodySchema)) body: UpdateAttributeOptionBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminAttributeOptionResponse> {
    return { option: await this.catalog.updateOption(params.optionId, body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.setAttributeOptionStatus)
  async setOptionStatus(
    @Param(new ZodValidationPipe(attributeOptionIdPathSchema)) params: AttributeOptionIdPath,
    @Body(new ZodValidationPipe(setCatalogEntryStatusBodySchema)) body: SetCatalogEntryStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminAttributeOptionResponse> {
    return {
      option: await this.catalog.setOptionStatus(
        params.optionId,
        body.status,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }
}

import { z } from "zod";
import * as compatibilityContract from "./compatibility";
import * as supplierContract from "./suppliers";
import * as offerContract from "./offers";
import * as clubAccessContract from "./club-access";
import * as orderContract from "./orders";
import * as signalContract from "./signals";
import * as showcaseContract from "./showcase";
import * as vehicleContract from "./vehicles";
import {
  accessContextSchema,
  administratorListResponseSchema,
  administratorSummarySchema,
  backupCodesResponseSchema,
  regenerateBackupCodesBodySchema,
  sessionAccessSchema,
  supplierCompanyResponseSchema,
  supplierMembershipListResponseSchema,
  supplierSummarySchema,
  switchSupplierBodySchema,
  totpResetResponseSchema,
} from "./access";
import {
  auditActorSchema,
  auditActorRoleSchema,
  auditLogEntrySchema,
  auditLogPageSchema,
} from "./audit";
import {
  adminAttributeListResponseSchema,
  adminAttributeOptionResponseSchema,
  adminAttributeOptionSchema,
  adminAttributeResponseSchema,
  adminAttributeSchema,
  adminCategoryNodeSchema,
  adminCategoryResponseSchema,
  adminCategorySchema,
  adminCategoryTreeResponseSchema,
  attributeOptionSchema,
  attributeValueTypeSchema,
  catalogEntryStatusSchema,
  catalogLanguageSchema,
  catalogNameTakenDetailsSchema,
  catalogTextSchema,
  catalogTextsSchema,
  catalogVersionConflictDetailsSchema,
  categoryAttributeSchema,
  categoryAttributesResponseSchema,
  categoryIconSchema,
  categoryKindSchema,
  categoryNodeSchema,
  categoryStatusSchema,
  categorySubcategorySchema,
  categoryTreeResponseSchema,
  createAttributeBodySchema,
  createAttributeOptionBodySchema,
  createCategoryBodySchema,
  localizedTextSchema,
  numberSettingsSchema,
  reorderAttributeOptionsBodySchema,
  reorderAttributesBodySchema,
  reorderCategoriesBodySchema,
  setCatalogEntryStatusBodySchema,
  setCategoryStatusBodySchema,
  updateAttributeBodySchema,
  updateAttributeOptionBodySchema,
  updateCategoryBodySchema,
} from "./catalog";
import {
  adminBrandPageSchema,
  adminBrandResponseSchema,
  adminBrandSchema,
  adminCatalogItemCardSchema,
  adminCatalogItemPageSchema,
  adminCatalogItemSchema,
  attributeValueSchema,
  attributeValueSourceSchema,
  catalogAnalogInvalidDetailsSchema,
  catalogBrandSpellingTakenDetailsSchema,
  catalogItemBrandSchema,
  catalogItemDuplicateDetailsSchema,
  catalogItemStatusSchema,
  catalogItemTypeSchema,
  catalogValueRejectionReasonSchema,
  catalogValueRejectionSchema,
  catalogValuesRejectedDetailsSchema,
  categoryFillCellSchema,
  categoryFillPageSchema,
  categoryFillRowSchema,
  categoryFillValueSchema,
  createBrandBodySchema,
  createCatalogItemBodySchema,
  fillCategoryBodySchema,
  fillCategoryResponseSchema,
  itemAnalogSchema,
  itemAnalogStatusSchema,
  itemAttributeValueSchema,
  itemCompletenessSchema,
  itemValueInputSchema,
  linkItemAnalogBodySchema,
  setCatalogItemStatusBodySchema,
  setItemValuesBodySchema,
  updateBrandBodySchema,
  updateCatalogItemBodySchema,
} from "./catalog-items";
import {
  adminItemPhotoSchema,
  adminItemPhotosResponseSchema,
  catalogPhotoInvalidDetailsSchema,
  catalogPhotoInvalidReasonSchema,
  itemPhotoImageSchema,
  itemPhotoProposedBySchema,
  itemPhotoSourceTypeSchema,
  itemPhotoStatusSchema,
  photoDisplayModeSchema,
  reorderItemPhotosBodySchema,
  setItemPhotoStatusBodySchema,
} from "./catalog-photos";
import { CLIENT_HEADER, clientPlatformSchema } from "./client";
import { clientPolicyResponseSchema, platformPolicySchema } from "./client-policy";
import {
  apiErrorResponseSchema,
  clientUpdateRequiredDetailsSchema,
  errorCodeSchema,
} from "./error";
import { healthCheckResponseSchema } from "./health";
import {
  editTranslationBodySchema,
  entityTranslationsResponseSchema,
  translationEntityTypeSchema,
  translationFailureSchema,
  translationFieldSchema,
  translationFieldViewSchema,
  translationLanguageSchema,
  translationOriginSchema,
  translationQueueItemSchema,
  translationQueuePageSchema,
  translationQueueStateSchema,
  translationTargetLanguageSchema,
  translationTaskSchema,
  translationTextSchema,
} from "./translations";
import {
  loginCodeChannelSchema,
  loginCodeInvalidDetailsSchema,
  loginCodeSentResponseSchema,
  loginCodeVerifiedResponseSchema,
  rateLimitedDetailsSchema,
  rateLimitNameSchema,
  requestLoginCodeBodySchema,
  verifyLoginCodeBodySchema,
} from "./login-code";
import { dependencyCheckSchema, readinessResponseSchema } from "./readiness";
import {
  currentAccountResponseSchema,
  refreshSessionBodySchema,
  sessionKindSchema,
  sessionListResponseSchema,
  sessionsEndedResponseSchema,
  sessionSummarySchema,
  sessionTokensSchema,
} from "./session";
import {
  selectSupplierBodySchema,
  signInCompletedResponseSchema,
  signInStepSchema,
  supplierSelectionRequiredDetailsSchema,
  totpSetupBodySchema,
  totpSetupCompletedResponseSchema,
  totpSetupConfirmBodySchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  totpVerifiedResponseSchema,
  totpVerifyBodySchema,
} from "./sign-in";
import type { ApiRouteDefinition } from "./routes";
import {
  changeSettingBodySchema,
  resetSettingBodySchema,
  settingActorSchema,
  settingChangedResponseSchema,
  settingChangeSchema,
  settingConstraintsSchema,
  settingEditableBySchema,
  settingGroupSchema,
  settingHistoryResponseSchema,
  settingListResponseSchema,
  settingSchema,
  settingTypeSchema,
  settingUnitSchema,
  settingVersionConflictDetailsSchema,
} from "./settings";

/**
 * Every schema that appears in the API, under the name it gets in
 * `components.schemas`. A route request or response whose schema isn't
 * listed here fails generation, so the document never silently inlines an
 * anonymous type.
 */
/**
 * Every schema of a contract module, named after its export without
 * `Schema` (`adminVehicleMakeSchema` → `AdminVehicleMake`): the vehicle
 * catalog (TASK-014), compatibility (TASK-015), cities and suppliers
 * (TASK-016).
 */
function moduleComponentSchemas(contract: object): Record<string, z.ZodType> {
  return Object.fromEntries(
    (Object.entries(contract) as [string, unknown][])
      .filter(
        (entry): entry is [string, z.ZodType] =>
          entry[0].endsWith("Schema") && entry[1] instanceof z.ZodType,
      )
      .map(([name, schema]) => [
        `${name.charAt(0).toUpperCase()}${name.slice(1, -"Schema".length)}`,
        schema,
      ]),
  );
}

const componentSchemas: Record<string, z.ZodType> = {
  ...moduleComponentSchemas(vehicleContract),
  ...moduleComponentSchemas(compatibilityContract),
  ...moduleComponentSchemas(supplierContract),
  ...moduleComponentSchemas(offerContract),
  ...moduleComponentSchemas(clubAccessContract),
  ...moduleComponentSchemas(orderContract),
  ...moduleComponentSchemas(signalContract),
  ...moduleComponentSchemas(showcaseContract),
  ApiErrorResponse: apiErrorResponseSchema,
  ErrorCode: errorCodeSchema,
  ClientPlatform: clientPlatformSchema,
  ClientUpdateRequiredDetails: clientUpdateRequiredDetailsSchema,
  ClientPolicyResponse: clientPolicyResponseSchema,
  PlatformPolicy: platformPolicySchema,
  HealthCheckResponse: healthCheckResponseSchema,
  ReadinessResponse: readinessResponseSchema,
  DependencyCheck: dependencyCheckSchema,
  LoginCodeChannel: loginCodeChannelSchema,
  RequestLoginCodeBody: requestLoginCodeBodySchema,
  LoginCodeSentResponse: loginCodeSentResponseSchema,
  VerifyLoginCodeBody: verifyLoginCodeBodySchema,
  LoginCodeVerifiedResponse: loginCodeVerifiedResponseSchema,
  LoginCodeInvalidDetails: loginCodeInvalidDetailsSchema,
  RateLimitName: rateLimitNameSchema,
  RateLimitedDetails: rateLimitedDetailsSchema,
  SessionKind: sessionKindSchema,
  SessionTokens: sessionTokensSchema,
  RefreshSessionBody: refreshSessionBodySchema,
  SessionSummary: sessionSummarySchema,
  SessionListResponse: sessionListResponseSchema,
  CurrentAccountResponse: currentAccountResponseSchema,
  SessionsEndedResponse: sessionsEndedResponseSchema,
  AccessContext: accessContextSchema,
  SupplierSummary: supplierSummarySchema,
  SessionAccess: sessionAccessSchema,
  SignInStep: signInStepSchema,
  SupplierSelectionRequiredDetails: supplierSelectionRequiredDetailsSchema,
  TotpStepRequiredDetails: totpStepRequiredDetailsSchema,
  SelectSupplierBody: selectSupplierBodySchema,
  SignInCompletedResponse: signInCompletedResponseSchema,
  TotpSetupBody: totpSetupBodySchema,
  TotpSetupResponse: totpSetupResponseSchema,
  TotpSetupConfirmBody: totpSetupConfirmBodySchema,
  TotpSetupCompletedResponse: totpSetupCompletedResponseSchema,
  TotpVerifyBody: totpVerifyBodySchema,
  TotpVerifiedResponse: totpVerifiedResponseSchema,
  SwitchSupplierBody: switchSupplierBodySchema,
  SupplierMembershipListResponse: supplierMembershipListResponseSchema,
  SupplierCompanyResponse: supplierCompanyResponseSchema,
  AdministratorSummary: administratorSummarySchema,
  AdministratorListResponse: administratorListResponseSchema,
  TotpResetResponse: totpResetResponseSchema,
  RegenerateBackupCodesBody: regenerateBackupCodesBodySchema,
  BackupCodesResponse: backupCodesResponseSchema,
  SettingType: settingTypeSchema,
  SettingUnit: settingUnitSchema,
  SettingEditableBy: settingEditableBySchema,
  SettingConstraints: settingConstraintsSchema,
  SettingActor: settingActorSchema,
  Setting: settingSchema,
  SettingGroup: settingGroupSchema,
  SettingListResponse: settingListResponseSchema,
  SettingChange: settingChangeSchema,
  ChangeSettingBody: changeSettingBodySchema,
  ResetSettingBody: resetSettingBodySchema,
  SettingChangedResponse: settingChangedResponseSchema,
  SettingHistoryResponse: settingHistoryResponseSchema,
  SettingVersionConflictDetails: settingVersionConflictDetailsSchema,
  AuditActorRole: auditActorRoleSchema,
  AuditActor: auditActorSchema,
  AuditLogEntry: auditLogEntrySchema,
  AuditLogPage: auditLogPageSchema,
  AdminAttributeListResponse: adminAttributeListResponseSchema,
  AdminAttributeOptionResponse: adminAttributeOptionResponseSchema,
  AdminAttributeOption: adminAttributeOptionSchema,
  AdminAttributeResponse: adminAttributeResponseSchema,
  AdminAttribute: adminAttributeSchema,
  AdminCategoryNode: adminCategoryNodeSchema,
  AdminCategoryResponse: adminCategoryResponseSchema,
  AdminCategory: adminCategorySchema,
  AdminCategoryTreeResponse: adminCategoryTreeResponseSchema,
  AttributeOption: attributeOptionSchema,
  AttributeValueType: attributeValueTypeSchema,
  CatalogEntryStatus: catalogEntryStatusSchema,
  CatalogLanguage: catalogLanguageSchema,
  CatalogNameTakenDetails: catalogNameTakenDetailsSchema,
  CatalogText: catalogTextSchema,
  CatalogTexts: catalogTextsSchema,
  CatalogVersionConflictDetails: catalogVersionConflictDetailsSchema,
  CategoryAttribute: categoryAttributeSchema,
  CategoryAttributesResponse: categoryAttributesResponseSchema,
  CategoryIcon: categoryIconSchema,
  CategoryKind: categoryKindSchema,
  CategoryNode: categoryNodeSchema,
  CategoryStatus: categoryStatusSchema,
  CategorySubcategory: categorySubcategorySchema,
  CategoryTreeResponse: categoryTreeResponseSchema,
  CreateAttributeBody: createAttributeBodySchema,
  CreateAttributeOptionBody: createAttributeOptionBodySchema,
  CreateCategoryBody: createCategoryBodySchema,
  LocalizedText: localizedTextSchema,
  NumberSettings: numberSettingsSchema,
  ReorderAttributeOptionsBody: reorderAttributeOptionsBodySchema,
  ReorderAttributesBody: reorderAttributesBodySchema,
  ReorderCategoriesBody: reorderCategoriesBodySchema,
  SetCatalogEntryStatusBody: setCatalogEntryStatusBodySchema,
  SetCategoryStatusBody: setCategoryStatusBodySchema,
  UpdateAttributeBody: updateAttributeBodySchema,
  UpdateAttributeOptionBody: updateAttributeOptionBodySchema,
  UpdateCategoryBody: updateCategoryBodySchema,
  AdminBrand: adminBrandSchema,
  AdminBrandPage: adminBrandPageSchema,
  AdminBrandResponse: adminBrandResponseSchema,
  AdminCatalogItem: adminCatalogItemSchema,
  AdminCatalogItemCard: adminCatalogItemCardSchema,
  AdminCatalogItemPage: adminCatalogItemPageSchema,
  AttributeValue: attributeValueSchema,
  AttributeValueSource: attributeValueSourceSchema,
  CatalogAnalogInvalidDetails: catalogAnalogInvalidDetailsSchema,
  CatalogBrandSpellingTakenDetails: catalogBrandSpellingTakenDetailsSchema,
  CatalogItemBrand: catalogItemBrandSchema,
  CatalogItemDuplicateDetails: catalogItemDuplicateDetailsSchema,
  CatalogItemStatus: catalogItemStatusSchema,
  CatalogItemType: catalogItemTypeSchema,
  CatalogValueRejection: catalogValueRejectionSchema,
  CatalogValueRejectionReason: catalogValueRejectionReasonSchema,
  CatalogValuesRejectedDetails: catalogValuesRejectedDetailsSchema,
  CategoryFillCell: categoryFillCellSchema,
  CategoryFillPage: categoryFillPageSchema,
  CategoryFillRow: categoryFillRowSchema,
  CategoryFillValue: categoryFillValueSchema,
  CreateBrandBody: createBrandBodySchema,
  CreateCatalogItemBody: createCatalogItemBodySchema,
  FillCategoryBody: fillCategoryBodySchema,
  FillCategoryResponse: fillCategoryResponseSchema,
  ItemAnalog: itemAnalogSchema,
  ItemAnalogStatus: itemAnalogStatusSchema,
  ItemAttributeValue: itemAttributeValueSchema,
  ItemCompleteness: itemCompletenessSchema,
  ItemValueInput: itemValueInputSchema,
  LinkItemAnalogBody: linkItemAnalogBodySchema,
  SetCatalogItemStatusBody: setCatalogItemStatusBodySchema,
  SetItemValuesBody: setItemValuesBodySchema,
  UpdateBrandBody: updateBrandBodySchema,
  UpdateCatalogItemBody: updateCatalogItemBodySchema,
  AdminItemPhoto: adminItemPhotoSchema,
  AdminItemPhotosResponse: adminItemPhotosResponseSchema,
  CatalogPhotoInvalidDetails: catalogPhotoInvalidDetailsSchema,
  CatalogPhotoInvalidReason: catalogPhotoInvalidReasonSchema,
  ItemPhotoImage: itemPhotoImageSchema,
  ItemPhotoProposedBy: itemPhotoProposedBySchema,
  ItemPhotoSourceType: itemPhotoSourceTypeSchema,
  ItemPhotoStatus: itemPhotoStatusSchema,
  PhotoDisplayMode: photoDisplayModeSchema,
  ReorderItemPhotosBody: reorderItemPhotosBodySchema,
  SetItemPhotoStatusBody: setItemPhotoStatusBodySchema,
  EditTranslationBody: editTranslationBodySchema,
  EntityTranslationsResponse: entityTranslationsResponseSchema,
  TranslationEntityType: translationEntityTypeSchema,
  TranslationFailure: translationFailureSchema,
  TranslationField: translationFieldSchema,
  TranslationFieldView: translationFieldViewSchema,
  TranslationLanguage: translationLanguageSchema,
  TranslationOrigin: translationOriginSchema,
  TranslationQueueItem: translationQueueItemSchema,
  TranslationQueuePage: translationQueuePageSchema,
  TranslationQueueState: translationQueueStateSchema,
  TranslationTargetLanguage: translationTargetLanguageSchema,
  TranslationTask: translationTaskSchema,
  TranslationText: translationTextSchema,
};

type JsonObject = Record<string, unknown>;

export interface OpenApiDocument extends JsonObject {
  openapi: string;
  paths: Record<string, Record<string, JsonObject>>;
}

export const OPENAPI_INFO = {
  title: "adclub.kz API",
  version: "0.1.0",
} as const;

function schemaRef(id: string): JsonObject {
  return { $ref: `#/components/schemas/${id}` };
}

function buildComponentSchemas(): {
  schemas: Record<string, JsonObject>;
  ids: Map<z.ZodType, string>;
} {
  const registry = z.registry<{ id: string }>();
  const ids = new Map<z.ZodType, string>();
  for (const [id, schema] of Object.entries(componentSchemas)) {
    registry.add(schema, { id });
    ids.set(schema, id);
  }

  const generated = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    uri: (id) => `#/components/schemas/${id}`,
    // zod closes every object (`additionalProperties: false`) in output
    // mode. That contradicts additive evolution (ARCHITECTURE 7.4): a
    // response may gain fields, and a client must ignore the ones it
    // doesn't know. Only objects declared strict keep the restriction.
    override: ({ zodSchema, jsonSchema }) => {
      const def = zodSchema._zod.def as {
        type: string;
        catchall?: { _zod: { def: { type: string } } };
      };
      const isStrictObject = def.type === "object" && def.catchall?._zod.def.type === "never";
      if (jsonSchema.additionalProperties === false && !isStrictObject) {
        delete jsonSchema.additionalProperties;
      }
    },
  }) as { schemas: Record<string, JsonObject> };

  const schemas: Record<string, JsonObject> = {};
  for (const id of Object.keys(componentSchemas).sort()) {
    // Each entry is emitted as a standalone JSON Schema document; inside
    // an OpenAPI 3.1 document the dialect and id come from the document.
    const { $schema: _dialect, id: _id, $id: _documentId, ...schema } = generated.schemas[id] ?? {};
    schemas[id] = schema;
  }
  return { schemas, ids };
}

function jsonContent(schema: JsonObject): JsonObject {
  return { "application/json": { schema } };
}

const PATH_PLACEHOLDER = /\{([^}]+)\}/g;

/** One `in: path` parameter per `{name}` in the route path, schemas inlined. */
function pathParameters(route: ApiRouteDefinition): JsonObject[] {
  const names = [...route.path.matchAll(PATH_PLACEHOLDER)].map((match) => match[1]!);
  const shape: Record<string, z.ZodType> = route.pathParams?.shape ?? {};
  const declared = Object.keys(shape);
  if (names.length !== declared.length || names.some((name) => !declared.includes(name))) {
    throw new Error(
      `${route.operationId}: path placeholders (${names.join(", ") || "none"}) must match pathParams (${declared.join(", ") || "none"})`,
    );
  }
  return names.map((name) => {
    const { $schema: _dialect, ...schema } = z.toJSONSchema(shape[name]!, {
      target: "draft-2020-12",
    }) as JsonObject;
    return { name, in: "path", required: true, schema };
  });
}

/**
 * One `in: query` parameter per field of the route's query schema, schemas
 * inlined. A parameter is required only when its field is (in practice
 * none are: a caller may always leave the query out).
 */
function queryParameters(route: ApiRouteDefinition): JsonObject[] {
  const shape: Record<string, z.ZodType> = route.query?.shape ?? {};
  return Object.entries(shape).map(([name, field]) => {
    const { $schema: _dialect, ...schema } = z.toJSONSchema(field, {
      target: "draft-2020-12",
      io: "input",
    }) as JsonObject;
    return {
      name,
      in: "query",
      required: !field.safeParse(undefined).success,
      schema,
    };
  });
}

/**
 * Builds the OpenAPI 3.1 document for the given routes (ARCHITECTURE 7.2).
 * Pure and deterministic: same routes and schemas → byte-identical JSON,
 * so the committed copy can be diffed and compared in CI.
 */
export function buildOpenApiDocument(routes: readonly ApiRouteDefinition[]): OpenApiDocument {
  const { schemas, ids } = buildComponentSchemas();
  const paths: OpenApiDocument["paths"] = {};

  const sortedRoutes = [...routes].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );

  const componentId = (schema: z.ZodType, usage: string): string => {
    const id = ids.get(schema);
    if (!id) {
      throw new Error(
        `${usage} uses a schema missing from componentSchemas (contracts/openapi.ts)`,
      );
    }
    return id;
  };

  for (const route of sortedRoutes) {
    if (route.auth !== undefined && (route.contexts?.length ?? 0) === 0) {
      throw new Error(`${route.operationId}: a session route must declare its contexts`);
    }
    if (route.requestBody && route.upload) {
      throw new Error(`${route.operationId}: a route takes either a JSON body or a file, not both`);
    }
    const responses: JsonObject = {};
    for (const [status, response] of Object.entries(route.responses)) {
      const id = componentId(response.schema, `Response ${status} of ${route.operationId}`);
      responses[status] = {
        description: response.description,
        content: jsonContent(schemaRef(id)),
      };
    }
    if (route.clientVersionCheck !== "exempt") {
      responses["426"] = { $ref: "#/components/responses/ClientUpdateRequired" };
    }
    responses.default = { $ref: "#/components/responses/Error" };

    const pathItem = (paths[route.path] ??= {});
    pathItem[route.method.toLowerCase()] = {
      operationId: route.operationId,
      summary: route.summary,
      tags: [route.tag],
      parameters: [
        ...pathParameters(route),
        ...queryParameters(route),
        { $ref: "#/components/parameters/ClientHeader" },
        { $ref: "#/components/parameters/AcceptLanguage" },
      ],
      ...(route.auth === "session" && {
        security: [{ sessionAccessToken: [] }],
        "x-access-contexts": [...(route.contexts ?? [])],
      }),
      // Open to guests, a session is optional (TASK-020): `{}` — no token.
      ...(route.auth === "optional" && {
        security: [{}, { sessionAccessToken: [] }],
        "x-access-contexts": [...(route.contexts ?? [])],
      }),
      ...(route.rateLimit && { "x-rate-limit": { ...route.rateLimit } }),
      ...(route.requestBody && {
        requestBody: {
          description: route.requestBody.description,
          required: true,
          content: jsonContent(
            schemaRef(
              componentId(route.requestBody.schema, `Request body of ${route.operationId}`),
            ),
          ),
        },
      }),
      // A file upload (TASK-013): the body is the bytes themselves, one
      // entry per accepted media type, so the document says exactly which
      // formats the route takes.
      ...(route.upload && {
        requestBody: {
          description: route.upload.description,
          required: true,
          content: Object.fromEntries(
            [...route.upload.contentTypes].sort().map((type) => [
              type,
              {
                schema: { type: "string", format: "binary", contentMediaType: type },
              },
            ]),
          ),
        },
      }),
      responses,
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      ...OPENAPI_INFO,
      description:
        "Generated from @adclub/contracts — do not edit by hand. Changes must be additive (ARCHITECTURE 7.4).",
    },
    tags: [
      { name: "meta", description: "Service state and client policy" },
      { name: "auth", description: "Sign-in with a one-time code, sessions and devices" },
      { name: "supplier", description: "Supplier cabinet (context `supplier`)" },
      {
        name: "catalog",
        description: "The catalog for every client, guests included (no session needed)",
      },
      {
        name: "vehicles",
        description:
          "The vehicle catalog for choosing a car, for every client, guests included (no session needed)",
      },
      {
        name: "public",
        description:
          "Open without signing in: cities and the connection request form (limited per client address)",
      },
      {
        name: "orders",
        description: "The user's own orders (context `user`, the mobile app)",
      },
      { name: "admin", description: "Admin panel (context `admin`)" },
    ],
    paths,
    components: {
      schemas,
      securitySchemes: {
        sessionAccessToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Access token of an active session (`SessionTokens.accessToken`). Expired: `ACCESS_TOKEN_EXPIRED` — refresh and repeat; `AUTH_REQUIRED` or `SESSION_ENDED` — sign in again.",
        },
      },
      parameters: {
        ClientHeader: {
          name: CLIENT_HEADER,
          in: "header",
          required: false,
          description:
            "Client platform and version: `mobile/<version> (ios|android)`, `supplier-web/<version>` or `admin-web/<version>`. Missing or malformed values are accepted and treated as an unknown client.",
          schema: { type: "string", examples: ["mobile/1.4.2 (ios)", "admin-web/0.1.0"] },
        },
        AcceptLanguage: {
          name: "Accept-Language",
          in: "header",
          required: false,
          description: "Preferred language for server-provided texts: kk, ru or en (default ru).",
          schema: { type: "string", examples: ["kk-KZ", "ru"] },
        },
      },
      responses: {
        Error: {
          description:
            "Any failure, in the unified error format. `RATE_LIMITED` (429) also sets `Retry-After`; `details` is `RateLimitedDetails`",
          content: jsonContent(schemaRef("ApiErrorResponse")),
        },
        ClientUpdateRequired: {
          description:
            "The client's version is below the supported minimum: code `CLIENT_UPDATE_REQUIRED`, `details` is `ClientUpdateRequiredDetails`",
          content: jsonContent(schemaRef("ApiErrorResponse")),
        },
      },
    },
  };
}

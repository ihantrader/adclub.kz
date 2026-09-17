export { healthCheckResponseSchema } from "./health";
export type { HealthCheckResponse } from "./health";

export {
  errorCodeSchema,
  apiErrorResponseSchema,
  clientUpdateRequiredDetailsSchema,
} from "./error";
export type { ErrorCode, ApiErrorResponse, ClientUpdateRequiredDetails } from "./error";

export { dependencyCheckSchema, readinessResponseSchema } from "./readiness";
export type { DependencyCheck, ReadinessResponse } from "./readiness";

export {
  CLIENT_HEADER,
  clientPlatformSchema,
  clientPlatforms,
  formatClientHeader,
  parseClientHeader,
} from "./client";
export type { ClientInfo, ClientPlatform } from "./client";

export { clientPolicyResponseSchema, platformPolicySchema } from "./client-policy";
export type { ClientPolicyResponse, PlatformPolicy } from "./client-policy";

export {
  loginCodeChannelSchema,
  loginCodeInvalidDetailsSchema,
  loginCodeSentResponseSchema,
  loginCodeVerifiedResponseSchema,
  rateLimitedDetailsSchema,
  rateLimitNameSchema,
  requestLoginCodeBodySchema,
  verifyLoginCodeBodySchema,
} from "./login-code";
export type {
  LoginCodeChannel,
  LoginCodeInvalidDetails,
  LoginCodeSentResponse,
  LoginCodeVerifiedResponse,
  RateLimitedDetails,
  RateLimitName,
  RequestLoginCodeBody,
  VerifyLoginCodeBody,
} from "./login-code";

export { apiRoutes } from "./routes";
export type {
  ApiRequestBodyDefinition,
  ApiResponseDefinition,
  ApiRouteDefinition,
  ApiRouteName,
  ApiRouteRequestBody,
  ApiRouteResponse,
  ApiRoutes,
  HttpMethod,
} from "./routes";

export { buildOpenApiDocument, OPENAPI_INFO } from "./openapi";
export type { OpenApiDocument } from "./openapi";

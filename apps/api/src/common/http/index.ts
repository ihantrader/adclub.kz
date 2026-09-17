export { readCookie } from "./cookies";
export { OriginPolicyMiddleware } from "./origin-policy.middleware";
export {
  corsOptions,
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  isSameOrigin,
  requestOrigin,
  webClientForOrigin,
} from "./web-origins";
export type { WebClient } from "./web-origins";

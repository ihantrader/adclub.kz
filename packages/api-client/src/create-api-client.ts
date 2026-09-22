import {
  apiRoutes,
  buildRoutePath,
  buildRouteQuery,
  CLIENT_HEADER,
  formatClientHeader,
  isUploadRoute,
  type ApiRouteDefinition,
  type ApiRouteName,
  type ApiRoutePathParams,
  type ApiRouteQuery,
  type ApiRouteRequestBody,
  type ApiRouteResponse,
  type ApiRoutes,
  type ClientInfo,
} from "@adclub/contracts";
import { ApiError, apiErrorFromResponse } from "./api-error";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** API origin, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** Sent as `X-Client` on every request. */
  client: ClientInfo;
  /** Current UI language, sent as `Accept-Language`; read on every request. */
  getLanguage?: () => string | undefined;
  /** Per-request timeout; a timed-out request fails with `NETWORK_ERROR`. Default 10 s. */
  timeoutMs?: number;
  /** Called with every `ApiError` before it's thrown — the hook for app-wide reactions such as `CLIENT_UPDATE_REQUIRED`. */
  onError?: (error: ApiError) => void;
  /**
   * Current access token, sent as `Authorization: Bearer …` on routes that
   * require a session (and only there); read on every request.
   */
  getAccessToken?: () => string | undefined;
  /**
   * `fetch` credentials mode. Web clients pass `"include"` so the browser
   * sends and stores the HttpOnly refresh cookie of the API origin.
   */
  credentials?: RequestCredentials;
  fetch?: FetchLike;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * Options of one call: the filters and paging of a route that declares
 * query parameters (`client.listAuditLog({ query: { limit: 20 } })`) are
 * part of them — every query field is optional, so the argument itself
 * always is.
 */
export type CallOptions<Route extends ApiRouteDefinition> = RequestOptions &
  ([ApiRouteQuery<Route>] extends [never] ? unknown : { query?: ApiRouteQuery<Route> }) &
  (Route extends { upload: unknown } ? UploadOptions : unknown);

/**
 * A route whose body is a file needs the type of that file: the bytes
 * alone don't say it, and the server takes only the types the route
 * declares. A `Blob` or `File` brings its own `type`, which is used when
 * `contentType` is left out.
 */
export interface UploadOptions {
  contentType?: string;
}

function isBlobLike(
  value: unknown,
): value is { type: string; arrayBuffer(): Promise<ArrayBuffer> } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

/** The bytes of an upload as one buffer, whatever the caller passed. */
function bytesOf(file: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (file instanceof ArrayBuffer) {
    return file;
  }
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}

type Result<Route extends ApiRouteDefinition> = Promise<ApiRouteResponse<Route>>;

/**
 * `client.getHealth(options?)` for a route without a body or path
 * parameters, `client.requestLoginCode(body, options?)` with a body,
 * `client.endSession(params, options?)` with path parameters, and
 * `(params, body, options?)` with both.
 */
export type ApiOperation<Route extends ApiRouteDefinition> = [ApiRoutePathParams<Route>] extends [
  never,
]
  ? [ApiRouteRequestBody<Route>] extends [never]
    ? (options?: CallOptions<Route>) => Result<Route>
    : (body: ApiRouteRequestBody<Route>, options?: CallOptions<Route>) => Result<Route>
  : [ApiRouteRequestBody<Route>] extends [never]
    ? (params: ApiRoutePathParams<Route>, options?: CallOptions<Route>) => Result<Route>
    : (
        params: ApiRoutePathParams<Route>,
        body: ApiRouteRequestBody<Route>,
        options?: CallOptions<Route>,
      ) => Result<Route>;

export type ApiOperations = {
  [Name in ApiRouteName]: ApiOperation<ApiRoutes[Name]>;
};

export interface ApiClient extends ApiOperations {
  /**
   * Calls any route; `body` is required exactly when the route declares
   * one, `params` when its path has placeholders.
   */
  request<Route extends ApiRouteDefinition>(
    route: Route,
    options?: CallOptions<Route> & {
      body?: ApiRouteRequestBody<Route>;
      params?: ApiRoutePathParams<Route>;
    },
  ): Promise<ApiRouteResponse<Route>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function readJson(response: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const text = await response.text();
    return { ok: true, value: text.length > 0 ? JSON.parse(text) : undefined };
  } catch {
    return { ok: false };
  }
}

/**
 * Typed client for every route in `apiRoutes` (`@adclub/contracts`): one
 * method per route, named after its `operationId`, returning that route's
 * documented response type. A status listed in the route's `responses`
 * resolves (e.g. `/ready`'s 503 body is data, not an error); anything else
 * rejects with an `ApiError` built from the unified error format.
 *
 * Success bodies aren't re-validated at runtime on purpose: a newer server
 * may add fields or enum values (ARCHITECTURE 7.4), and a strict parse
 * would turn that into a failure on an old client.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Wrapped rather than stored: calling a detached `window.fetch` with
  // another `this` throws "Illegal invocation" in browsers.
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const clientHeader = formatClientHeader(options.client);

  const fail = (error: ApiError): never => {
    options.onError?.(error);
    throw error;
  };

  async function request<Route extends ApiRouteDefinition>(
    route: Route,
    requestOptions: RequestOptions & {
      body?: unknown;
      params?: unknown;
      query?: unknown;
      contentType?: string;
    } = {},
  ): Promise<ApiRouteResponse<Route>> {
    const path =
      buildRoutePath(route, (requestOptions.params ?? {}) as Readonly<Record<string, string>>) +
      buildRouteQuery(route, (requestOptions.query ?? {}) as Readonly<Record<string, unknown>>);
    const headers: Record<string, string> = {
      Accept: "application/json",
      [CLIENT_HEADER]: clientHeader,
    };
    if (route.auth === "session" || route.auth === "optional") {
      const accessToken = options.getAccessToken?.();
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }
    }
    let body: string | ArrayBuffer | undefined;
    if (route.requestBody) {
      if (requestOptions.body === undefined) {
        throw new TypeError(`${route.operationId} requires a request body`);
      }
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(requestOptions.body);
    } else if (isUploadRoute(route)) {
      const file = requestOptions.body;
      if (file === undefined) {
        throw new TypeError(`${route.operationId} requires a file to upload`);
      }
      const contentType =
        requestOptions.contentType ?? (isBlobLike(file) ? file.type : undefined) ?? "";
      if (!route.upload?.contentTypes.includes(contentType)) {
        throw new TypeError(
          `${route.operationId} takes ${route.upload?.contentTypes.join(", ") ?? "no"} — not ${contentType || "an unnamed type"}`,
        );
      }
      headers["Content-Type"] = contentType;
      // Sent as bytes: a `Blob` is read here so every runtime (browser,
      // React Native, Node) sends the same request.
      body = isBlobLike(file)
        ? await file.arrayBuffer()
        : bytesOf(file as Uint8Array | ArrayBuffer);
    }
    const language = options.getLanguage?.();
    if (language) {
      headers["Accept-Language"] = language;
    }

    const controller = new AbortController();
    const callerSignal = requestOptions.signal;
    const abortFromCaller = () => controller.abort();
    if (callerSignal?.aborted) {
      controller.abort();
    }
    callerSignal?.addEventListener("abort", abortFromCaller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method: route.method,
          headers,
          body,
          signal: controller.signal,
          ...(options.credentials && { credentials: options.credentials }),
        });
      } catch (cause) {
        if (callerSignal?.aborted && !timedOut) {
          // The caller cancelled: not an API failure, don't report it.
          throw cause;
        }
        return fail(
          new ApiError({
            code: "NETWORK_ERROR",
            message: timedOut
              ? `No response from the server within ${timeoutMs} ms`
              : "Could not reach the server",
            status: 0,
            retryable: true,
            cause,
          }),
        );
      }

      const responseBody = await readJson(response);

      if (Object.hasOwn(route.responses, response.status)) {
        if (!responseBody.ok) {
          return fail(
            new ApiError({
              code: "INVALID_RESPONSE",
              message: `Response body of ${route.operationId} is not valid JSON`,
              status: response.status,
              retryable: false,
            }),
          );
        }
        return responseBody.value as ApiRouteResponse<Route>;
      }

      return fail(
        apiErrorFromResponse(response.status, responseBody.ok ? responseBody.value : undefined),
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  const operation = (route: ApiRouteDefinition) => {
    if (route.pathParams && isUploadRoute(route)) {
      return (params: unknown, file: unknown, requestOptions?: RequestOptions) =>
        request(route, { ...requestOptions, params, body: file });
    }
    if (isUploadRoute(route)) {
      return (file: unknown, requestOptions?: RequestOptions) =>
        request(route, { ...requestOptions, body: file });
    }
    if (route.pathParams && route.requestBody) {
      return (params: unknown, body: unknown, requestOptions?: RequestOptions) =>
        request(route, { ...requestOptions, params, body });
    }
    if (route.pathParams) {
      return (params: unknown, requestOptions?: RequestOptions) =>
        request(route, { ...requestOptions, params });
    }
    if (route.requestBody) {
      return (body: unknown, requestOptions?: RequestOptions) =>
        request(route, { ...requestOptions, body });
    }
    return (requestOptions?: RequestOptions) => request(route, requestOptions);
  };

  const operations = Object.fromEntries(
    Object.entries(apiRoutes).map(([name, route]: [string, ApiRouteDefinition]) => [
      name,
      operation(route),
    ]),
  ) as unknown as ApiOperations;

  return { ...operations, request };
}

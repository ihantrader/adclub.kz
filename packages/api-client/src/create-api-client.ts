import {
  apiRoutes,
  CLIENT_HEADER,
  formatClientHeader,
  type ApiRouteDefinition,
  type ApiRouteName,
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
  fetch?: FetchLike;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * `client.getHealth(options?)` for a route without a body,
 * `client.requestLoginCode(body, options?)` for one with a body.
 */
export type ApiOperation<Route extends ApiRouteDefinition> = [ApiRouteRequestBody<Route>] extends [
  never,
]
  ? (options?: RequestOptions) => Promise<ApiRouteResponse<Route>>
  : (
      body: ApiRouteRequestBody<Route>,
      options?: RequestOptions,
    ) => Promise<ApiRouteResponse<Route>>;

export type ApiOperations = {
  [Name in ApiRouteName]: ApiOperation<ApiRoutes[Name]>;
};

export interface ApiClient extends ApiOperations {
  /** Calls any route; `body` is required exactly when the route declares one. */
  request<Route extends ApiRouteDefinition>(
    route: Route,
    options?: RequestOptions & { body?: ApiRouteRequestBody<Route> },
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
    requestOptions: RequestOptions & { body?: unknown } = {},
  ): Promise<ApiRouteResponse<Route>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      [CLIENT_HEADER]: clientHeader,
    };
    let body: string | undefined;
    if (route.requestBody) {
      if (requestOptions.body === undefined) {
        throw new TypeError(`${route.operationId} requires a request body`);
      }
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(requestOptions.body);
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
        response = await fetchImpl(`${baseUrl}${route.path}`, {
          method: route.method,
          headers,
          body,
          signal: controller.signal,
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

  const operations = Object.fromEntries(
    Object.entries(apiRoutes).map(([name, route]: [string, ApiRouteDefinition]) => [
      name,
      route.requestBody
        ? (body: unknown, requestOptions?: RequestOptions) =>
            request(route, { ...requestOptions, body })
        : (requestOptions?: RequestOptions) => request(route, requestOptions),
    ]),
  ) as unknown as ApiOperations;

  return { ...operations, request };
}

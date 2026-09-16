import {
  CLIENT_HEADER,
  formatClientHeader,
  parseClientHeader,
  type ClientInfo,
} from "@adclub/contracts";
import { isValidAppVersion } from "@adclub/domain";
import type { Request } from "express";

/**
 * Who sent a request, from its `X-Client` header (ARCHITECTURE 7.4):
 * - `known`: a first-party client with a valid platform and version;
 * - `missing`: no header — an old client, a probe, a third-party caller;
 * - `invalid`: a header that doesn't parse or carries a non-version.
 * Only `known` clients are ever subject to the minimum-version check;
 * the other two are served as an unknown version, never rejected.
 */
export type RequestClient =
  { kind: "known"; client: ClientInfo } | { kind: "missing" } | { kind: "invalid" };

const resolved = new WeakMap<Request, RequestClient>();

export function resolveClientHeader(value: string | string[] | undefined): RequestClient {
  if (value === undefined || value === "") {
    return { kind: "missing" };
  }
  // A repeated header is ambiguous; don't guess which one is right.
  if (Array.isArray(value)) {
    return { kind: "invalid" };
  }
  const client = parseClientHeader(value);
  if (!client || !isValidAppVersion(client.version)) {
    return { kind: "invalid" };
  }
  return { kind: "known", client };
}

/** Parsed once per request and shared by the version guard and the access log. */
export function getRequestClient(request: Request): RequestClient {
  let client = resolved.get(request);
  if (!client) {
    client = resolveClientHeader(request.headers[CLIENT_HEADER.toLowerCase()]);
    resolved.set(request, client);
  }
  return client;
}

/** Log-safe label: never echoes a raw, unparsed header value. */
export function describeRequestClient(client: RequestClient): string {
  return client.kind === "known" ? formatClientHeader(client.client) : client.kind;
}

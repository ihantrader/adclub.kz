import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContextStore {
  requestId: string;
  /**
   * Who is calling, as far as the request itself tells: the client address
   * (Express `trust proxy` decides it) and the `User-Agent`. Recorded with
   * an action in the journal (`audit_log`, ARCHITECTURE 4.13); they never
   * go to the application log or to monitoring.
   */
  ip?: string | null;
  userAgent?: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContextStore>();

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** The caller of the request being served, or nothing outside a request. */
export function getRequestOrigin(): { ip: string | null; userAgent: string | null } {
  const store = requestContext.getStore();
  return { ip: store?.ip ?? null, userAgent: store?.userAgent ?? null };
}

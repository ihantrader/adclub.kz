import { createApiClient, type ApiError } from "@adclub/api-client";
import { useSyncExternalStore } from "react";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
export const APP_VERSION = __APP_VERSION__;

let updateRequiredMessage: string | null = null;
const listeners = new Set<() => void>();

function handleApiError(error: ApiError): void {
  if (error.code === "CLIENT_UPDATE_REQUIRED") {
    updateRequiredMessage = error.message;
    listeners.forEach((listener) => listener());
  }
}

export const apiClient = createApiClient({
  baseUrl: API_URL,
  client: { platform: "admin-web", version: APP_VERSION },
  getLanguage: () => "ru",
  onError: handleApiError,
});

/**
 * The server's "update required" text once any request was refused with
 * `CLIENT_UPDATE_REQUIRED` (this build is below `CLIENT_MIN_VERSION_ADMIN_WEB`),
 * `null` otherwise.
 */
export function useUpdateRequiredMessage(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => updateRequiredMessage,
  );
}

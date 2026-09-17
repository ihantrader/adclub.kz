import { createApiClient, type ApiError } from "@adclub/api-client";
import { useSyncExternalStore } from "react";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
export const APP_VERSION = __APP_VERSION__;

let currentLanguage = "ru";
let updateRequiredMessage: string | null = null;
const listeners = new Set<() => void>();

function handleApiError(error: ApiError): void {
  if (error.code === "CLIENT_UPDATE_REQUIRED") {
    updateRequiredMessage = error.message;
    listeners.forEach((listener) => listener());
  }
}

export function setApiLanguage(lang: string): void {
  currentLanguage = lang;
}

export const apiClient = createApiClient({
  baseUrl: API_URL,
  client: { platform: "supplier-web", version: APP_VERSION },
  getLanguage: () => currentLanguage,
  onError: handleApiError,
});

/**
 * The server's "update required" text once any request was refused with
 * `CLIENT_UPDATE_REQUIRED` (this build is below
 * the `client_min_version_supplier_web` setting), `null` otherwise.
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

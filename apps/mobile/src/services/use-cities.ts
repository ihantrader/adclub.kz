import { isApiError } from "@adclub/api-client";
import type { ClientCity } from "@adclub/contracts";
import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "../state/language";
import { apiClient } from "./api";

export interface CitiesState {
  status: "loading" | "ready" | "error";
  cities: ClientCity[];
  /** The city to start with when none is chosen (the setting `default_city`). */
  defaultCityId: string | null;
  /** `true` when the last attempt failed because there is no network. */
  offline: boolean;
  /** Reloading over a list that is already shown (SCREENS 2.1). */
  refreshing: boolean;
  reload: () => void;
}

interface Loaded {
  cities: ClientCity[];
  defaultCityId: string | null;
  failure: "network" | "other" | null;
}

const EMPTY: Loaded = { cities: [], defaultCityId: null, failure: null };

/**
 * The city list of `/cities` in the interface language (TASK-016): loaded
 * through the shared API client, reloaded when the language changes, and
 * never fatal — a failure leaves the app on "Весь Казахстан" with
 * "Повторить" (the app must not get stuck on the city screen). A reload over
 * a list that is already shown keeps it on screen (SCREENS 2.1).
 */
export function useCities(): CitiesState {
  const { lang } = useLanguage();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [settled, setSettled] = useState<string | null>(null);

  const request = `${lang}:${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .getCities({ signal: controller.signal })
      .then((response) => {
        setLoaded({
          cities: response.cities,
          defaultCityId: response.defaultCityId,
          failure: null,
        });
        setSettled(request);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded((previous) => ({
          ...previous,
          failure: isApiError(error) && error.code === "NETWORK_ERROR" ? "network" : "other",
        }));
        setSettled(request);
      });
    return () => controller.abort();
    // The list is localised on the server, so a new language means a new list.
  }, [request]);

  const pending = settled !== request;
  const hasList = loaded.cities.length > 0;
  const status: CitiesState["status"] = hasList
    ? "ready"
    : pending
      ? "loading"
      : loaded.failure !== null
        ? "error"
        : "ready";

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  return {
    status,
    cities: loaded.cities,
    defaultCityId: loaded.defaultCityId,
    offline: loaded.failure === "network",
    refreshing: pending && hasList,
    reload,
  };
}

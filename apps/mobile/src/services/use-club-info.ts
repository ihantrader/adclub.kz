import type { ClubInfoResponse } from "@adclub/contracts";
import { apiClient } from "./api";
import { useRequest, type RequestState } from "./use-request";

/** A changed setting reaches the app within this, like the catalog's answers. */
const STALE_AFTER_MS = 60_000;

/**
 * The club's documents, contact and partner page (`GET /meta/club-info`,
 * TASK-077), for the profile and «Документы и поддержка». Loaded again when
 * the screen comes back after a minute.
 */
export function useClubInfo(): RequestState<ClubInfoResponse> {
  return useRequest("club-info", (signal) => apiClient.getClubInfo({ signal }), {
    staleAfterMs: STALE_AFTER_MS,
  });
}

import type {
  VehicleGenerationsResponse,
  VehicleMakesResponse,
  VehicleModelsResponse,
  VehicleModificationsResponse,
} from "@adclub/contracts";
import { useLanguage } from "../state/language";
import { apiClient } from "./api";
import { createRequestCache } from "./request-cache";
import { useRequest, type RequestState } from "./use-request";

/**
 * The vehicle catalog of TASK-014, step by step (M-GAR-03): makes, the
 * models of a make, the generations of a model, the modifications of a
 * generation. The app holds no copy of it — every option on a step is an
 * answer of the server in the interface language, so a change an
 * administrator makes reaches the phone within the minute the answers are
 * cacheable for.
 *
 * Each step of the choice is a screen of its own (ARCHITECTURE 4.39), and
 * several steps read the same answer — the generations serve the year and the
 * generation, the modifications serve the body, the engine, the gearbox and
 * the drive. The answers are therefore kept for that minute, the same time
 * the server lets any cache keep them, so a step that opens right after
 * another one shows its options at once instead of a skeleton. Older than
 * that they are asked for again.
 */
export const VEHICLE_ANSWER_MS = 60_000;
const answers = createRequestCache(VEHICLE_ANSWER_MS);

/** Passing `false` says the screen does not need makes: nothing is asked for. */
export function useVehicleMakes(enabled = true): RequestState<VehicleMakesResponse> {
  const { lang } = useLanguage();
  return useRequest(
    enabled ? `makes:${lang}` : null,
    (signal) => apiClient.getVehicleMakes({ signal }),
    { cache: answers },
  );
}

export function useVehicleModels(makeId: string | null): RequestState<VehicleModelsResponse> {
  const { lang } = useLanguage();
  return useRequest(
    makeId ? `models:${makeId}:${lang}` : null,
    (signal) => apiClient.getVehicleMakeModels({ makeId: makeId ?? "" }, { signal }),
    { cache: answers },
  );
}

export function useVehicleGenerations(
  modelId: string | null,
): RequestState<VehicleGenerationsResponse> {
  const { lang } = useLanguage();
  return useRequest(
    modelId ? `generations:${modelId}:${lang}` : null,
    (signal) => apiClient.getVehicleModelGenerations({ modelId: modelId ?? "" }, { signal }),
    { cache: answers },
  );
}

export function useVehicleModifications(
  generationId: string | null,
): RequestState<VehicleModificationsResponse> {
  const { lang } = useLanguage();
  return useRequest(
    generationId ? `modifications:${generationId}:${lang}` : null,
    (signal) =>
      apiClient.getVehicleGenerationModifications({ generationId: generationId ?? "" }, { signal }),
    { cache: answers },
  );
}

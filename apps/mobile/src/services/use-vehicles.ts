import type {
  VehicleGenerationsResponse,
  VehicleMakesResponse,
  VehicleModelsResponse,
  VehicleModificationsResponse,
} from "@adclub/contracts";
import { useLanguage } from "../state/language";
import { apiClient } from "./api";
import { useRequest, type RequestState } from "./use-request";

/**
 * The vehicle catalog of TASK-014, step by step (M-GAR-03): makes, the
 * models of a make, the generations of a model, the modifications of a
 * generation. The app holds no copy of it — every option on a step is an
 * answer of the server in the interface language, so a change an
 * administrator makes reaches the phone within the minute the answers are
 * cacheable for.
 */

export function useVehicleMakes(enabled = true): RequestState<VehicleMakesResponse> {
  const { lang } = useLanguage();
  return useRequest(enabled ? `makes:${lang}` : null, (signal) =>
    apiClient.getVehicleMakes({ signal }),
  );
}

export function useVehicleModels(makeId: string | null): RequestState<VehicleModelsResponse> {
  const { lang } = useLanguage();
  return useRequest(makeId ? `models:${makeId}:${lang}` : null, (signal) =>
    apiClient.getVehicleMakeModels({ makeId: makeId ?? "" }, { signal }),
  );
}

export function useVehicleGenerations(
  modelId: string | null,
): RequestState<VehicleGenerationsResponse> {
  const { lang } = useLanguage();
  return useRequest(modelId ? `generations:${modelId}:${lang}` : null, (signal) =>
    apiClient.getVehicleModelGenerations({ modelId: modelId ?? "" }, { signal }),
  );
}

export function useVehicleModifications(
  generationId: string | null,
): RequestState<VehicleModificationsResponse> {
  const { lang } = useLanguage();
  return useRequest(generationId ? `modifications:${generationId}:${lang}` : null, (signal) =>
    apiClient.getVehicleGenerationModifications({ generationId: generationId ?? "" }, { signal }),
  );
}

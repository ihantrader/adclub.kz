import { useSyncExternalStore } from "react";
import type { UpdateGate, UpdateGateState } from "./update-gate";

export function useUpdateGateState(gate: UpdateGate): UpdateGateState {
  return useSyncExternalStore(gate.subscribe, gate.getState);
}

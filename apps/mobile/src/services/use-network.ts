import { useNetworkState } from "expo-network";
import { isOnline } from "./network";

/**
 * Whether the app has a network right now. One hook for the whole app: the
 * "Нет сети" banner, the "Нет сети" screens and the start decision
 * (SCREENS 2.4, 5.1) read it, nobody checks the connection on their own.
 */
export function useOnline(): boolean {
  const state = useNetworkState();
  return isOnline(state);
}

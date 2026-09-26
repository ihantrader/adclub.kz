/**
 * Whether the app has a network: `expo-network` reports the connection of
 * the device. Unknown is treated as "online" — the app never blocks itself
 * on a guess, and a request that fails shows its own error (SCREENS 2.3).
 */
export interface NetworkStateLike {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
}

export function isOnline(state: NetworkStateLike | null | undefined): boolean {
  if (!state) return true;
  if (state.isConnected === false) return false;
  return state.isInternetReachable !== false;
}

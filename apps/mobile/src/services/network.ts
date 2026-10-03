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

/**
 * Whether the device has said anything about its connection yet: the hook
 * of `expo-network` starts empty and learns the state a moment later. Most
 * of the app treats that moment as «online» (`isOnline`); the start of the
 * app is the one decision that waits for it — opening the catalog on a
 * guess and then finding the phone in a basement would hide the codes the
 * person came for (M-START-01 rule 5, TASK-030).
 */
export function isNetworkKnown(state: NetworkStateLike | null | undefined): boolean {
  return typeof state?.isConnected === "boolean";
}

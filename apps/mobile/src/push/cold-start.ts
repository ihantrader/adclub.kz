import type { PushMessage } from "./push-logic";

/**
 * Opened from a push while the app was closed (SCREENS 5.1 rule 6; TASK-056,
 * I866): the push opens its order only for a signed-in person — and whether
 * the person is signed in is known only once the session is read from the
 * secure storage, which on a slow phone takes longer than the splash's one
 * second. The push therefore waits for the session itself, however long that
 * takes; the splash keeps its own limit and does not wait for this.
 */
export interface ColdStartDeps {
  /** The push the app was opened from; `null` — none. */
  initial: () => Promise<PushMessage | null>;
  /** Resolves once the stored session has really been read (no time limit). */
  sessionRead: Promise<void>;
  signedIn: () => boolean;
  /** Opens the push's target and confirms it. */
  open: (message: PushMessage) => void;
}

export type ColdStartResult = "opened" | "none" | "signed_out";

export async function openFromColdStart(deps: ColdStartDeps): Promise<ColdStartResult> {
  const [message] = await Promise.all([deps.initial().catch(() => null), deps.sessionRead]);
  if (!message?.target) return "none";
  if (!deps.signedIn()) return "signed_out";
  deps.open(message);
  return "opened";
}

import { isApiError } from "@adclub/api-client";
import { clientPolicyResponseSchema, type ClientInfo } from "@adclub/contracts";
import { isVersionBelowMinimum } from "@adclub/domain";

/**
 * What the app knows about whether this build may still be used
 * (ARCHITECTURE 7.4):
 * - `checking`: the policy request is in flight — the app stays usable;
 * - `supported`: the server's policy explicitly allows this version;
 * - `unverified`: no explicit answer (offline, server down, unreadable
 *   policy) — never a reason to block the user (TASK-003 business rule);
 * - `update-required`: the server explicitly said this version is too old,
 *   with the text to show.
 */
export type UpdateGateState =
  | { status: "checking" }
  | { status: "supported" }
  | { status: "unverified" }
  | { status: "update-required"; message: string };

export function shouldShowUpdateScreen(
  state: UpdateGateState,
): state is Extract<UpdateGateState, { status: "update-required" }> {
  return state.status === "update-required";
}

/** Decides from a `GET /meta/client-policy` body; anything unreadable is `unverified`. */
export function evaluateClientPolicy(policy: unknown, client: ClientInfo): UpdateGateState {
  const parsed = clientPolicyResponseSchema.safeParse(policy);
  if (!parsed.success) {
    return { status: "unverified" };
  }

  const { minSupportedVersion } = parsed.data.platforms[client.platform];
  if (isVersionBelowMinimum(client.version, minSupportedVersion)) {
    return { status: "update-required", message: parsed.data.message };
  }
  return { status: "supported" };
}

function updateRequiredFrom(error: unknown): UpdateGateState | null {
  return isApiError(error) && error.code === "CLIENT_UPDATE_REQUIRED"
    ? { status: "update-required", message: error.message }
    : null;
}

/**
 * Holds the update state for the whole app: `check()` asks the policy
 * endpoint (at start-up and on "check again"); `handleApiError` is wired
 * into the API client, so a minimum raised while the app is open shows
 * the update screen on the next request of any kind.
 */
export class UpdateGate {
  private state: UpdateGateState = { status: "checking" };
  private revision = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly fetchPolicy: () => Promise<unknown>,
    private readonly client: ClientInfo,
  ) {}

  getState = (): UpdateGateState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  handleApiError = (error: unknown): void => {
    const next = updateRequiredFrom(error);
    if (next) {
      this.setState(next);
    }
  };

  check = async (): Promise<UpdateGateState> => {
    if (this.state.status !== "update-required") {
      this.setState({ status: "checking" });
    }
    const startedAt = this.revision;

    let next: UpdateGateState;
    try {
      next = evaluateClientPolicy(await this.fetchPolicy(), this.client);
    } catch (error) {
      // No explicit answer keeps an earlier explicit "update required"
      // (a retry that fails offline must not unlock an outdated app) and
      // otherwise lets the user in.
      next =
        updateRequiredFrom(error) ??
        (this.state.status === "update-required" ? this.state : { status: "unverified" });
    }

    // Something more recent (e.g. a 426 on another request) already
    // updated the state while the policy was loading: keep it.
    if (this.revision === startedAt) {
      this.setState(next);
    }
    return this.state;
  };

  private setState(next: UpdateGateState): void {
    this.revision += 1;
    this.state = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

import { isApiError } from "@adclub/api-client";
import {
  clientPolicyResponseSchema,
  type ClientInfo,
  type ClientPolicyResponse,
} from "@adclub/contracts";
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
  /**
   * `storeUrl` — the app's page in this platform's store (TASK-056,
   * `client_store_url_*`); `null` — not set, M-START-03 searches the store.
   */
  | { status: "update-required"; message: string; storeUrl: string | null };

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
    return {
      status: "update-required",
      message: parsed.data.message,
      storeUrl: storePageOf(parsed.data, client),
    };
  }
  return { status: "supported" };
}

/**
 * The app's store page of the client's platform — the mobile platforms have
 * one. Only an `https://` page is opened; anything else is «not set» (the
 * store's search).
 */
function storePageOf(policy: ClientPolicyResponse, client: ClientInfo): string | null {
  const url =
    client.platform === "ios" || client.platform === "android"
      ? policy.platforms[client.platform].storeUrl
      : null;
  return url && /^https:\/\/\S+$/.test(url) ? url : null;
}

/** The store page a readable policy names (`undefined` — unreadable), kept for a 426 that carries none. */
function storeUrlOf(policy: unknown, client: ClientInfo): string | null | undefined {
  const parsed = clientPolicyResponseSchema.safeParse(policy);
  return parsed.success ? storePageOf(parsed.data, client) : undefined;
}

function updateRequiredFrom(error: unknown, storeUrl: string | null): UpdateGateState | null {
  return isApiError(error) && error.code === "CLIENT_UPDATE_REQUIRED"
    ? { status: "update-required", message: error.message, storeUrl }
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
  /** What the last readable policy said about the store page. */
  private storeUrl: string | null = null;
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
    const next = updateRequiredFrom(error, this.storeUrl);
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
      const policy = await this.fetchPolicy();
      const named = storeUrlOf(policy, this.client);
      if (named !== undefined) this.storeUrl = named;
      next = evaluateClientPolicy(policy, this.client);
    } catch (error) {
      // No explicit answer keeps an earlier explicit "update required"
      // (a retry that fails offline must not unlock an outdated app) and
      // otherwise lets the user in.
      next =
        updateRequiredFrom(error, this.storeUrl) ??
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

import type { DependencyCheck } from "@adclub/contracts";
import { withTimeout } from "./with-timeout";

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Runs a dependency probe (a single lightweight query/ping) and turns its
 * outcome into the `DependencyCheck` shape the readiness endpoint returns.
 * A slow or hanging dependency is reported as `error`, not left to block
 * the readiness request indefinitely.
 */
export async function measureCheck(
  probe: () => Promise<void>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DependencyCheck> {
  const start = Date.now();

  try {
    await withTimeout(probe(), timeoutMs);
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * Confirms the worker process actually shuts down cleanly on SIGTERM
 * (`process.on("SIGTERM", ...)` in `src/worker.ts`) — a behavior noted as
 * unverified in TASK-002 (Known Issues): `Stop-Process` on Windows, the
 * development machine, doesn't deliver POSIX signals, so this could only
 * be checked where the real deployment target (Linux, ARCHITECTURE 15.1)
 * actually runs it — CI (TASK-002.A).
 *
 * Points every dependency at a closed local port: the worker must start
 * and shut down regardless of whether PostgreSQL/Redis/S3 are reachable
 * (edge case, TASK-002), so no real services are needed for this check.
 */

const WORKER_ENTRY = resolve(__dirname, "..", "dist", "worker.js");
const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const STARTED_MARKER = "Worker process started";
const SHUTDOWN_MARKER = "Received SIGTERM, shutting down";

function waitUntil(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) {
        resolvePromise();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for: ${label}`));
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

async function main(): Promise<void> {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: "postgres://x:x@localhost:1/x",
    REDIS_URL: "redis://localhost:2",
    S3_ENDPOINT: "http://localhost:3",
    S3_ACCESS_KEY: "x",
    S3_SECRET_KEY: "x",
    S3_BUCKET: "x",
  };

  let output = "";
  const child = spawn(process.execPath, [WORKER_ENTRY], { env });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  let exitCode: number | null = null;
  child.once("exit", (code) => {
    exitCode = code;
  });

  try {
    await waitUntil(
      () => output.includes(STARTED_MARKER),
      STARTUP_TIMEOUT_MS,
      `worker log to contain "${STARTED_MARKER}"`,
    );
    console.log("Worker started; sending SIGTERM...");

    child.kill("SIGTERM");

    await waitUntil(
      () => exitCode !== null,
      SHUTDOWN_TIMEOUT_MS,
      "worker process to exit after SIGTERM",
    );

    if (!output.includes(SHUTDOWN_MARKER)) {
      throw new Error(`Worker exited without logging "${SHUTDOWN_MARKER}"`);
    }
    if (exitCode !== 0) {
      throw new Error(`Worker exited with code ${String(exitCode)}, expected 0`);
    }

    console.log(`Worker exited gracefully (code 0) after SIGTERM, logged "${SHUTDOWN_MARKER}".`);
  } catch (error) {
    console.error(
      "Graceful shutdown check failed:",
      error instanceof Error ? error.message : error,
    );
    console.error("--- worker output ---");
    console.error(output);
    if (exitCode === null) {
      child.kill("SIGKILL");
    }
    process.exitCode = 1;
  }
}

void main();

import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * Confirms the API and worker processes actually shut down cleanly on
 * SIGTERM (`installGracefulShutdown`, `common/shutdown`) — noted as
 * unverified for the API in TASK-002 (Known Issues) and only checked for
 * the worker until TASK-005.A: `Stop-Process` on Windows, the development
 * machine, doesn't deliver POSIX signals, so this could only be checked
 * where the real deployment target (Linux, ARCHITECTURE 15.1) actually
 * runs it — CI.
 *
 * Points every dependency at a closed local port: both processes must
 * start and shut down regardless of whether PostgreSQL/Redis/S3 are
 * reachable (edge case, TASK-002), so no real services are needed for
 * this check.
 */

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

interface Target {
  name: string;
  entry: string;
  startedMarker: string;
  shutdownMarker: string;
  env: NodeJS.ProcessEnv;
}

const BASE_ENV = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: "postgres://x:x@localhost:1/x",
  REDIS_URL: "redis://localhost:2",
  S3_ENDPOINT: "http://localhost:3",
  S3_ACCESS_KEY: "x",
  S3_SECRET_KEY: "x",
  S3_BUCKET: "x",
};

const TARGETS: Target[] = [
  {
    name: "worker",
    entry: resolve(__dirname, "..", "dist", "worker.js"),
    startedMarker: "Worker process started",
    shutdownMarker: "Received SIGTERM, shutting down",
    env: BASE_ENV,
  },
  {
    name: "api",
    entry: resolve(__dirname, "..", "dist", "main.js"),
    startedMarker: "API listening on port",
    shutdownMarker: "Received SIGTERM, shutting down",
    env: { ...BASE_ENV, PORT: "34599" },
  },
];

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

async function verify(target: Target): Promise<void> {
  let output = "";
  const child = spawn(process.execPath, [target.entry], { env: target.env });
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
      () => output.includes(target.startedMarker),
      STARTUP_TIMEOUT_MS,
      `${target.name} log to contain "${target.startedMarker}"`,
    );
    console.log(`${target.name} started; sending SIGTERM...`);

    child.kill("SIGTERM");

    await waitUntil(
      () => exitCode !== null,
      SHUTDOWN_TIMEOUT_MS,
      `${target.name} process to exit after SIGTERM`,
    );

    if (!output.includes(target.shutdownMarker)) {
      throw new Error(`${target.name} exited without logging "${target.shutdownMarker}"`);
    }
    if (exitCode !== 0) {
      throw new Error(`${target.name} exited with code ${String(exitCode)}, expected 0`);
    }

    console.log(
      `${target.name} exited gracefully (code 0) after SIGTERM, logged "${target.shutdownMarker}".`,
    );
  } catch (error) {
    console.error(
      `Graceful shutdown check failed for ${target.name}:`,
      error instanceof Error ? error.message : error,
    );
    console.error(`--- ${target.name} output ---`);
    console.error(output);
    if (exitCode === null) {
      child.kill("SIGKILL");
    }
    throw error;
  }
}

async function main(): Promise<void> {
  for (const target of TARGETS) {
    await verify(target);
  }
}

main().catch(() => {
  process.exitCode = 1;
});

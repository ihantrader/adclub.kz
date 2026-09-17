import { afterAll, expect } from "vitest";

/**
 * Integration test setup (`vitest.integration.config.ts`, `setupFiles`):
 * everything the test process writes to stdout and stderr — the
 * application log above all — is captured from the first line of a test
 * file to its last, and silenced (`TEST_OUTPUT=show` lets it through).
 * Tests register every secret they get hold of (tokens, TOTP secrets and
 * codes, backup codes); after the file, none of them may appear anywhere
 * in that output (ARCHITECTURE 4.5 I42, 4.6 I57, 4.8).
 */

const everything: string[] = [];
const listeners = new Set<(text: string) => void>();
/** Long secrets: searched for in the raw output as they are. */
const secrets = new Set<string>();
/** Short codes (TOTP, backup, login): searched for as whole words in what the app logged. */
const codes = new Set<string>();

const show = process.env.TEST_OUTPUT === "show";

for (const stream of [process.stdout, process.stderr]) {
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    everything.push(text);
    for (const listener of listeners) {
      listener(text);
    }
    return show ? original(chunk, ...rest) : true;
  }) as typeof stream.write;
}

/** Output written from now on (e.g. per test: call in `beforeEach`, `stop` in `afterEach`). */
export function captureOutput(): { text: () => string; stop: () => void } {
  const chunks: string[] = [];
  const listener = (text: string) => chunks.push(text);
  listeners.add(listener);
  return { text: () => chunks.join(""), stop: () => listeners.delete(listener) };
}

/** Everything written since the file started. */
export function allOutput(): string {
  return everything.join("");
}

/**
 * What the application itself logged (`message` and `stack` of JSON log
 * lines) — not request ids and timestamps, which may contain any run of
 * characters.
 */
export function appLogText(output = allOutput()): string {
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      const entry = JSON.parse(line) as { message?: string; stack?: string };
      return `${entry.message ?? ""} ${entry.stack ?? ""}`;
    })
    .join("\n");
}

export function rememberSecret(...values: (string | undefined)[]): void {
  for (const value of values) {
    if (value !== undefined && value.length >= 16) {
      secrets.add(value);
    }
  }
}

export function rememberCode(...values: (string | undefined)[]): void {
  for (const value of values) {
    if (value !== undefined && value.length > 0) {
      codes.add(value);
    }
  }
}

export function rememberedSecrets(): ReadonlySet<string> {
  return secrets;
}

export function rememberedCodes(): ReadonlySet<string> {
  return codes;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fails if any remembered secret or code was written. */
export function expectNoSecretsWritten(): void {
  const raw = allOutput();
  for (const secret of secrets) {
    expect(raw, "a remembered secret was written to the output").not.toContain(secret);
  }
  const logged = appLogText(raw);
  for (const code of codes) {
    expect(logged, "a remembered code was logged").not.toMatch(
      new RegExp(`(?<![0-9A-Za-z])${escape(code)}(?![0-9A-Za-z])`),
    );
  }
  expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.eyJ/);
  expect(raw).not.toMatch(/rt1\.[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]{43}/);
  expect(raw).not.toMatch(/st1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/);
  expect(raw).not.toMatch(/otpauth:\/\//);
}

afterAll(() => {
  expectNoSecretsWritten();
});

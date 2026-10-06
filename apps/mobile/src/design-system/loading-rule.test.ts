import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Plain Node checks, like `navigation/motion-rule.test.ts`: the rule of
// loading (DESIGN 7.6 «Загрузка без мигания», D-069, TASK-032.A) is
// `createLoadingGate` of `@adclub/ui-core`, tested there; what these hold is
// how the app is wired to it — one home, no second copy.
const src = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const files = sourceFiles(src).map((path) => ({
  path: path.slice(src.length + 1).replace(/\\/g, "/"),
  text: withoutComments(readFileSync(path, "utf8")),
}));
const file = (path: string) => files.find((candidate) => candidate.path === path)?.text ?? "";

describe("the rule of loading has one home", () => {
  it("is the gate of @adclub/ui-core, wrapped once for the app", () => {
    const owners = files.filter((candidate) => candidate.text.includes("createLoadingGate("));
    expect(owners.map((candidate) => candidate.path)).toEqual(["design-system/loading.ts"]);
  });

  it("every answer of a screen request and of the list of items goes through it", () => {
    for (const path of ["services/use-request.ts", "services/use-catalog.ts"]) {
      const text = file(path);
      expect(text, path).toContain("useLoadingGate()");
      expect(text, path).toMatch(
        /settle\(ticket, \(\) => \{\s*setState|settle\(ticket, \(\) => \{\s*setResult/,
      );
    }
    // The list of items (TASK-028.A) is on the same gate, not a variant of its own.
    expect(file("services/use-catalog.ts")).toContain("refreshing: pending && gate.indicator");
    expect(file("services/use-request.ts")).toContain("refreshing: pending && gate.indicator");
  });

  it("a skeleton, the refresh line and a spinner only after the delay", () => {
    expect(file("design-system/states.tsx")).toContain("useDelayedIndicator(loading)");
    expect(file("design-system/Button.tsx")).toContain("useDelayedIndicator(busy)");
    for (const candidate of files) {
      if (!candidate.text.includes("<ActivityIndicator")) continue;
      expect(candidate.text, candidate.path).toContain("useDelayedIndicator(");
    }
  });

  it("no screen keeps a delay or a minimum of its own", () => {
    for (const candidate of files) {
      expect(candidate.text, candidate.path).not.toMatch(/loadingDelay|loadingMinVisible/);
    }
  });
});

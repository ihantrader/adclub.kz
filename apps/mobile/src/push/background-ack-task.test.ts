import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The wiring of the background task (TASK-056 AC-4), read from the sources
 * as `navigation/motion-rule.test.ts` does: React Native is not loaded in
 * these tests, and the task itself runs only in an own build on a phone.
 */
const read = (...path: string[]) => readFileSync(join(__dirname, ...path), "utf8");

describe("the background confirmation task", () => {
  it("is defined at the top level of the bundle, before the root component", () => {
    const entry = read("..", "..", "index.ts");
    const defined = entry.indexOf("defineBackgroundAckTask();");
    expect(defined).toBeGreaterThan(-1);
    expect(defined).toBeLessThan(entry.indexOf("registerRootComponent(App);"));
  });

  it("is touched only in an own build — never in Expo Go or the browser", () => {
    const task = read("background-ack-task.ts");
    const guard = task.indexOf('runEnvironment !== "own-build"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(task.indexOf('require("expo-task-manager")'));
    expect(task).toContain("registerTaskAsync(BACKGROUND_ACK_TASK)");
    // The logic is the tested one, not a copy.
    expect(task).toContain("runBackgroundAck(data");
  });
});

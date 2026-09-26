import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Plain Node checks: this file must not import react-native. They read the
// sources, because what they hold is a property of how the app is wired — that
// the rule of motion has one home (TASK-028.A, ARCHITECTURE 4.39) — which no
// call of a pure function can show.
const src = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The code of a file without its comments, which talk about the very things these checks look for. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const files = sourceFiles(src).map((path) => ({
  path: path.slice(src.length + 1).replace(/\\/g, "/"),
  text: withoutComments(readFileSync(path, "utf8")),
}));

describe("the rule of motion has one home", () => {
  it("every native stack takes its options from useStackScreenOptions", () => {
    const stacks = files.filter((file) => file.text.includes("<Stack.Navigator"));
    // The root, the catalog and the garage.
    expect(stacks.map((file) => file.path).sort()).toEqual([
      "navigation/CatalogStack.tsx",
      "navigation/GarageStack.tsx",
      "navigation/RootNavigator.tsx",
    ]);
    for (const stack of stacks) {
      expect(stack.text, stack.path).toContain("useStackScreenOptions()");
      expect(stack.text, stack.path).toMatch(/screenOptions=\{screenOptions\}/);
    }
  });

  it("no screen sets an animation of its own, except to switch it off for tabs", () => {
    for (const file of files) {
      if (file.path === "navigation/stack-motion.ts") continue;
      const own = file.text.match(/\banimation:\s*"[^"]+"/g) ?? [];
      // The tab bar is instant on purpose (tabs are not a transition).
      const allowed = file.path === "navigation/MainTabs.tsx" ? ['animation: "none"'] : [];
      expect(own, file.path).toEqual(allowed);
    }
  });

  it("no modal takes the platform's animation: sheets and dialogs move by the rule", () => {
    for (const file of files) {
      const modals = file.text.match(/animationType="[^"]+"/g) ?? [];
      // Sheet and Dialog are drawn by the rule (`animationType="none"`); the
      // only other modal is the development-only showcase, which fades.
      const allowed =
        file.path === "design-system/feedback.tsx"
          ? ['animationType="none"', 'animationType="none"']
          : file.path === "screens/tabs/ProfileScreen.tsx"
            ? ['animationType="fade"']
            : [];
      expect(modals, file.path).toEqual(allowed);
    }
  });

  it("no curve of its own: the deceleration comes from the rule", () => {
    for (const file of files) {
      expect(file.text, file.path).not.toMatch(/Easing\.(out|in|inOut)\(/);
    }
    const feedback = files.find((file) => file.path === "design-system/feedback.tsx");
    expect(feedback?.text).not.toContain("Easing");
    // The one place that turns the rule's curve into an easing function.
    const motion = files.find((file) => file.path === "design-system/motion.ts");
    expect(motion?.text).toContain("Easing.bezier(...plan.easing)");
  });

  it("a change of state takes its plan from the rule too, and no duration is written by hand", () => {
    for (const path of ["design-system/controls.tsx", "design-system/AiPilot.tsx"]) {
      const file = files.find((candidate) => candidate.path === path);
      expect(file?.text, path).toContain('useMotionPlan("state")');
      expect(file?.text, path).not.toContain("Animated.timing(");
    }
    for (const file of files) {
      // 150 and 250 ms are `motionPlan`'s; a screen or a component asking for
      // them by name would be a second copy of the rule.
      expect(file.text, file.path).not.toMatch(/duration:\s*motion\.(fast|slow)\b/);
    }
  });

  it("the overlays are driven by one transition, not a copy each", () => {
    const feedback = files.find((file) => file.path === "design-system/feedback.tsx");
    // Sheet, Dialog and the toast.
    expect(feedback?.text.match(/useOverlayTransition\(/g)).toHaveLength(3);
  });
});

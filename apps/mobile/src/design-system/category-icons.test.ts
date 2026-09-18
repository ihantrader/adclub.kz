import { existsSync } from "node:fs";
import { join } from "node:path";
import { categoryIcons } from "@adclub/contracts";
import { describe, expect, it } from "vitest";

// Plain Node checks: this file must not import react-native.
// The package maps every subpath to an icon, so its folder is found directly.
const tablerPackage = join(__dirname, "../../node_modules/@tabler/icons-react-native");

/** `car-suspension` → `IconCarSuspension`, the module name in the package. */
function moduleName(icon: string): string {
  return `Icon${icon
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}`;
}

describe("category icons (TASK-010)", () => {
  it.each(categoryIcons)("%s exists in the Tabler package the app renders with", (icon) => {
    expect(existsSync(join(tablerPackage, "dist/esm/icons", `${moduleName(icon)}.mjs`))).toBe(true);
  });
});

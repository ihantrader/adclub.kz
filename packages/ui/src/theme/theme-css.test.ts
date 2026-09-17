import { readFileSync } from "node:fs";
import { join } from "node:path";
import { breakpoints } from "@adclub/ui-core";
import { describe, expect, it } from "vitest";
import { buildThemeCss } from "./theme-css";

const styles = join(__dirname, "../styles");
const componentsCss = readFileSync(join(styles, "components.css"), "utf8");

describe("theme.css", () => {
  it("is generated from the ui-core tokens (update: pnpm --filter @adclub/ui test -u)", async () => {
    await expect(buildThemeCss()).toMatchFileSnapshot("../styles/theme.css");
  });

  it("defines both themes with the same custom properties", () => {
    const css = buildThemeCss();
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return css.slice(start, css.indexOf("}", start));
    };
    const names = (text: string) => [...text.matchAll(/(--ac-[\w-]+):/g)].map((m) => m[1]).sort();
    const light = names(block(':root[data-theme="light"]'));
    const dark = names(block(':root[data-theme="dark"]'));
    expect(light.length).toBeGreaterThan(25);
    expect(light).toEqual(dark);
    expect(block(':root[data-theme="dark"]')).toContain("--ac-color-bg: #0f1012;");
    expect(block(':root[data-theme="light"]')).toContain("--ac-color-bg: #f6f3ec;");
    expect(block(':root[data-theme="dark"]')).toContain("--ac-float-shadow: none;");
  });

  it("covers every custom property the component styles use", () => {
    const defined = new Set([...buildThemeCss().matchAll(/(--ac-[\w-]+):/g)].map((m) => m[1]));
    const used = new Set([...componentsCss.matchAll(/var\((--ac-[\w-]+)\)/g)].map((m) => m[1]));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  it("uses no raw colors in component styles", () => {
    expect(componentsCss.match(/#[0-9a-f]{3,8}\b/gi)).toBeNull();
    expect(componentsCss).not.toMatch(/rgba?\(/);
  });

  it("switches layouts only at the DESIGN.md 7.5 breakpoints", () => {
    const widths = [...componentsCss.matchAll(/@media[^{]*min-width:\s*(\d+)px/g)].map((m) =>
      Number(m[1]),
    );
    const allowed: number[] = [breakpoints.twoColumns, breakpoints.sidebar];
    expect(widths.filter((width) => !allowed.includes(width))).toEqual([]);
  });

  it("never uses caps or letter spacing (DESIGN.md 7.11)", () => {
    expect(componentsCss).not.toMatch(/text-transform:\s*uppercase/);
    expect(componentsCss).not.toMatch(/letter-spacing:(?!\s*normal)/);
  });

  it("turns animations off with reduced motion", () => {
    const reduced = componentsCss.slice(
      componentsCss.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(reduced).toContain(".ac-skeleton {\n    animation: none;");
    expect(reduced).toContain("transition-property: opacity !important;");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiPilotStates } from "../logic";
import { aiPilotSvg, brandSvg } from "./brand-svg";

const brand = join(__dirname, "../../../../design/brand");
const read = (name: string) => readFileSync(join(brand, name), "utf8").trim();

describe("brand SVG module", () => {
  it("matches design/brand (run `pnpm brand:assets` after rebuilding the SVGs)", () => {
    for (const [name, svg] of Object.entries(brandSvg)) {
      expect(svg, name).toBe(read(`${name}.svg`));
    }
    for (const state of aiPilotStates) {
      for (const colorway of ["on-champagne", "on-graphite"] as const) {
        expect(aiPilotSvg[state][colorway], `${state} ${colorway}`).toBe(
          read(`assistant/ai-pilot-${state}-${colorway}.svg`),
        );
      }
    }
  });

  it("has five AI Pilot states in two colorways", () => {
    expect(Object.keys(aiPilotSvg).sort()).toEqual([...aiPilotStates].sort());
    expect(aiPilotSvg.idle["on-champagne"]).toContain('fill="#0F1012"');
    expect(aiPilotSvg.idle["on-graphite"]).toMatch(
      /^<svg[^>]*><title>AI Pilot<\/title><rect[^>]*fill="#D4B483"/,
    );
  });
});

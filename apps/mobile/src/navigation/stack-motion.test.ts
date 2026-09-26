import { motion, screenTransition } from "@adclub/ui-core";
import { describe, expect, it } from "vitest";
import { stackOptionsFor } from "./stack-motion";

describe("the options every stack of the app takes (DESIGN 7.6)", () => {
  it("uses the platform's own transition, and no header of its own", () => {
    expect(stackOptionsFor(screenTransition(false))).toMatchObject({
      headerShown: false,
      animation: "default",
    });
  });

  it("fades — nothing slides — when the system asks for reduced motion", () => {
    expect(stackOptionsFor(screenTransition(true))).toMatchObject({
      headerShown: false,
      animation: "fade",
    });
  });

  it("gives the fade the length of the rule, 250 ms", () => {
    expect(stackOptionsFor(screenTransition(true)).animationDuration).toBe(motion.slow);
    expect(stackOptionsFor(screenTransition(false)).animationDuration).toBe(250);
  });

  it("never asks for an animation that would slide with reduced motion", () => {
    const options = stackOptionsFor(screenTransition(true));
    const slides = ["default", "slide_from_right", "slide_from_left", "slide_from_bottom"];
    expect(slides).not.toContain(options.animation);
  });
});

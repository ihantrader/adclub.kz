import type { FirstRunStep } from "./start-decision";

/**
 * How far the first run got (SCREENS 5.1 rule 3): the app returns to the
 * step the user stopped at. The run is over when a car has been added
 * (D-062): the city step writes `{ completed: false, step: "car" }`, the
 * car step writes `completed: true` together with saving the car, and there
 * is no way to leave the car step without one — so an app closed there
 * opens on the same step again.
 */
export interface FirstRunState {
  completed: boolean;
  step: FirstRunStep;
}

export const INITIAL_FIRST_RUN: FirstRunState = { completed: false, step: "city" };

export function parseFirstRun(raw: unknown): FirstRunState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const step = value.step === "car" ? "car" : value.step === "city" ? "city" : null;
  if (step === null || typeof value.completed !== "boolean") return null;
  return { completed: value.completed, step };
}

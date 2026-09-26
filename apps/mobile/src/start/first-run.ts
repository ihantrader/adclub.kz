import type { FirstRunStep } from "./start-decision";

/**
 * How far the first run got (SCREENS 5.1 rule 3): the app returns to the
 * step the user stopped at. The car step is M-START-05 (TASK-028); until it
 * exists the run is finished by the city step, and the state already carries
 * the step so that adding the screen changes no decision.
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

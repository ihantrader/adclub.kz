import type { Request, Response } from "express";
import { readCookie } from "../../../common/http";
import { parseSignInStepToken } from "./sign-in-step-token";

/**
 * The cookie that binds an unfinished sign-in to the browser that passed
 * the login code (ARCHITECTURE 4.9). One cookie per step
 * (`adclub_sign_in_<step id>`), so two sign-ins in two tabs of one browser
 * don't displace each other; each lives exactly as long as its step.
 * HttpOnly, Secure, SameSite=Strict, no Domain, and sent only to the step
 * routes (`/auth/sign-in/...`).
 */
const COOKIE_PREFIX = "adclub_sign_in_";
export const SIGN_IN_STEP_COOKIE_PATH = "/auth/sign-in";

export interface SignInStepBinding {
  stepId: string;
  value: string;
  expiresAt: Date;
}

function cookieName(stepId: string): string {
  return `${COOKIE_PREFIX}${stepId}`;
}

export function setSignInStepCookie(
  response: Response,
  binding: SignInStepBinding,
  now: Date,
): void {
  response.cookie(cookieName(binding.stepId), binding.value, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: SIGN_IN_STEP_COOKIE_PATH,
    maxAge: Math.max(0, binding.expiresAt.getTime() - now.getTime()),
  });
}

/** Drops the cookie of a finished step (the token names the step). */
export function clearSignInStepCookie(response: Response, token: string): void {
  const parsed = parseSignInStepToken(token);
  if (!parsed) {
    return;
  }
  response.clearCookie(cookieName(parsed.stepId), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: SIGN_IN_STEP_COOKIE_PATH,
  });
}

/** The binding value this client holds for the step the token names, if any. */
export function readSignInStepBinding(request: Request, token: string): string | undefined {
  const parsed = parseSignInStepToken(token);
  return parsed ? readCookie(request, cookieName(parsed.stepId)) : undefined;
}

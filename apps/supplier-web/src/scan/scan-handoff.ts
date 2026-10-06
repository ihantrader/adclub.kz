import type { Credential } from "./scan-rules";

/**
 * «Переключиться» on «Эта заявка оформлена у {компания}» (S-SCAN-04):
 * the session switches to the other company, every page of the previous
 * one is dropped (the scanner too), and the same code is looked up again
 * once the scanner of the other company is on screen. The credential
 * waits here, in the memory of the page only — never in the address, the
 * history or the storage — and is taken exactly once.
 */
let pending: Credential | null = null;

export function handOver(credential: Credential): void {
  pending = credential;
}

export function takeHandedOver(): Credential | null {
  const credential = pending;
  pending = null;
  return credential;
}

/**
 * Until when the server refused more lookups (429, «Слишком много неверных
 * кодов»): kept for the page, so leaving the scanner and coming back — or
 * typing code after code — does not ask the server before then.
 */
let blockedUntil = 0;

export function lookupsBlockedUntil(): number {
  return blockedUntil;
}

export function blockLookupsUntil(until: number): void {
  blockedUntil = Math.max(blockedUntil, until);
}

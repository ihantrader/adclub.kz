/**
 * Whether the server closed a guest's AI to guests (TASK-066; ARCHITECTURE
 * 8.6): `GUEST_SIGN_IN_REQUIRED` — the switch `guest_attestation_required`
 * is on. Every point of a guest's AI (a photo — the certificate, the
 * dashboard, a part —, voice, the assistant) shows it as M-AI-02 «Пробные
 * запросы временно недоступны» with «Войти», as the guests' spent budget;
 * the ways without AI («Выбрать из списка», the field, the text search) stay.
 */
export function guestAiClosed(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "GUEST_SIGN_IN_REQUIRED";
}

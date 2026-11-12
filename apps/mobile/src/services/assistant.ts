import type {
  AssistantComplaintReason,
  AssistantComplaintResponse,
  AssistantDialogResponse,
  AssistantLimits,
  AssistantMessageResponse,
} from "@adclub/contracts";
import { assistantCarOf } from "../assistant/assistant-rules";
import type { GarageCar } from "../garage/garage";
import { sessionStore } from "../state/stores";
import { apiClient } from "./api";
import { deviceId } from "./vehicle-document";

/**
 * The AI Pilot assistant on the server (TASK-062, TASK-063; ARCHITECTURE
 * 4.85, 4.86): a guest is the device — the very id the photo recognitions
 * count by — and a signed-in person the account of the session. The
 * language of the interface goes as `Accept-Language` with every request
 * (`apiClient`).
 */

function signedIn(): boolean {
  return sessionStore.get().status === "signed_in";
}

async function guestQuery(): Promise<{ deviceId?: string }> {
  return signedIn() ? {} : { deviceId: await deviceId() };
}

export async function sendAssistantMessage(input: {
  text: string;
  car: GarageCar;
  cityId: string | undefined;
  dialogId: string | null;
  /** The key of the new dialog this send opens (`dialogId` null; TASK-063.B). */
  openKey?: string;
  /** `false` — the dialog's car is gone from the garage: no mileage of another car. */
  withMileage?: boolean;
  quickReply?: boolean;
  signal?: AbortSignal;
}): Promise<AssistantMessageResponse> {
  const guest = await guestQuery();
  const { car, mileageKm } = assistantCarOf(input.car, !guest.deviceId);
  return apiClient.sendAssistantMessage(
    {
      text: input.text,
      car,
      ...guest,
      ...(input.dialogId ? { dialogId: input.dialogId } : {}),
      ...(!input.dialogId && input.openKey ? { openKey: input.openKey } : {}),
      ...(input.cityId ? { cityId: input.cityId } : {}),
      ...(mileageKm !== undefined && input.withMileage !== false ? { mileageKm } : {}),
      ...(input.quickReply ? { quickReply: true } : {}),
    },
    input.signal ? { signal: input.signal } : {},
  );
}

export async function readAssistantDialog(
  dialogId: string,
  signal?: AbortSignal,
): Promise<AssistantDialogResponse> {
  return apiClient.getAssistantDialog(
    { dialogId },
    { query: await guestQuery(), ...(signal ? { signal } : {}) },
  );
}

export async function readAssistantLimits(signal?: AbortSignal): Promise<AssistantLimits> {
  return apiClient.getAssistantLimits({ query: await guestQuery(), ...(signal ? { signal } : {}) });
}

/** «Пожаловаться на ответ»: again is safe — the server answers with the same complaint. */
export async function complainAboutAnswer(
  messageId: string,
  reason: AssistantComplaintReason,
  text: string,
): Promise<AssistantComplaintResponse> {
  const trimmed = text.trim();
  return apiClient.complainAboutAssistantMessage(
    { messageId },
    { ...(await guestQuery()), reason, ...(trimmed !== "" ? { text: trimmed } : {}) },
  );
}

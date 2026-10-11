import { ApiError, apiErrorFromResponse } from "@adclub/api-client";
import { apiRoutes, type PriceImport, type PriceImportResponse } from "@adclub/contracts";
import { reportRequestOutcome } from "@adclub/web-session";
import { apiClient, session } from "../api";
import { API_URL, APP_VERSION } from "../config";

/**
 * Sending a price file with the progress of the upload (S-PRICE-01
 * «прогресс загрузки»). `fetch` tells nothing about the bytes it has sent,
 * so this one request goes by `XMLHttpRequest` — with the same headers the
 * API client sends, the session's access token, and the session's cookie.
 * An expired token is exchanged by any ordinary request of the client (one
 * exchange for the whole page), and the upload is repeated once.
 *
 * The file goes as it is, as `application/octet-stream`: what it is, the
 * server decides by its content.
 */

/** A slow phone network and a file of 20 MB: minutes, not seconds. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

interface Answer {
  status: number;
  body: unknown;
}

function send(
  file: Blob,
  fileName: string,
  language: string,
  token: string | undefined,
  onProgress: (fraction: number) => void,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ fileName: fileName.slice(0, 255) });
    xhr.open("POST", `${API_URL}${apiRoutes.uploadPriceImport.path}?${query.toString()}`);
    xhr.withCredentials = true;
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Client", `supplier-web/${APP_VERSION}`);
    xhr.setRequestHeader("Accept-Language", language);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown;
      try {
        body = xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : undefined;
      } catch {
        body = undefined;
      }
      resolve({ status: xhr.status, body });
    };
    const failed = () =>
      reject(
        new ApiError({
          code: "NETWORK_ERROR",
          message: "Could not reach the server",
          status: 0,
          retryable: true,
        }),
      );
    xhr.onerror = failed;
    xhr.ontimeout = failed;
    xhr.send(file);
  });
}

/** Any ordinary request of the client: it exchanges an expired or missing access token. */
async function freshToken(): Promise<string | undefined> {
  await apiClient.listPriceImports({ query: { limit: 1 } });
  return session.accessToken();
}

/** Uploads a price file; resolves with the new import or rejects with an `ApiError`. */
export async function uploadPriceFile(
  file: File,
  language: string,
  onProgress: (fraction: number) => void,
): Promise<PriceImport> {
  let token = session.accessToken() ?? (await freshToken());
  for (let attempt = 0; ; attempt++) {
    let answer: Answer;
    try {
      answer = await send(file, file.name, language, token, onProgress);
      reportRequestOutcome(true);
    } catch (error) {
      reportRequestOutcome(false);
      throw error;
    }
    if (answer.status === 201) return (answer.body as PriceImportResponse).import;
    const error = apiErrorFromResponse(answer.status, answer.body);
    if (attempt === 0 && error.code === "ACCESS_TOKEN_EXPIRED") {
      onProgress(0);
      token = await freshToken();
      continue;
    }
    throw error;
  }
}

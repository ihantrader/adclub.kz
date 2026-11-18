import { ApiError, apiErrorFromResponse } from "@adclub/api-client";
import { apiRoutes, type PriceImport, type PriceImportResponse } from "@adclub/contracts";
import { reportRequestOutcome } from "@adclub/web-session";
import { apiClient, session } from "../api";
import { API_URL, APP_VERSION } from "../config";

/**
 * Sending a price file — or photographed pages (TASK-064) — with the
 * progress of the upload (S-PRICE-01 «прогресс загрузки»). `fetch` tells
 * nothing about the bytes it has sent, so these requests go by
 * `XMLHttpRequest` — with the same headers the API client sends, the
 * session's access token, and the session's cookie. An expired token is
 * exchanged by any ordinary request of the client (one exchange for the
 * whole page), and the upload is repeated once.
 *
 * A file goes as it is, as `application/octet-stream`: what it is, the
 * server decides by its content. Photographed pages go as a form of parts
 * named `page`, in their order (the browser writes the boundary itself).
 */

/** A slow phone network and a file of 20 MB: minutes, not seconds. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

interface Answer {
  status: number;
  body: unknown;
}

interface Upload {
  method: "POST" | "PUT";
  path: string;
  body: Blob | FormData;
  /** `null` — the browser sets it (a form with its boundary). */
  contentType: string | null;
  /** The status of success. */
  ok: number;
}

function send(
  upload: Upload,
  language: string,
  token: string | undefined,
  onProgress: (fraction: number) => void,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, `${API_URL}${upload.path}`);
    xhr.withCredentials = true;
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    if (upload.contentType) xhr.setRequestHeader("Content-Type", upload.contentType);
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
    xhr.send(upload.body);
  });
}

/** Any ordinary request of the client: it exchanges an expired or missing access token. */
async function freshToken(): Promise<string | undefined> {
  await apiClient.listPriceImports({ query: { limit: 1 } });
  return session.accessToken();
}

async function uploaded(
  upload: Upload,
  language: string,
  onProgress: (fraction: number) => void,
): Promise<PriceImport> {
  let token = session.accessToken() ?? (await freshToken());
  for (let attempt = 0; ; attempt++) {
    let answer: Answer;
    try {
      answer = await send(upload, language, token, onProgress);
      reportRequestOutcome(true);
    } catch (error) {
      reportRequestOutcome(false);
      throw error;
    }
    if (answer.status === upload.ok) return (answer.body as PriceImportResponse).import;
    const error = apiErrorFromResponse(answer.status, answer.body);
    if (attempt === 0 && error.code === "ACCESS_TOKEN_EXPIRED") {
      onProgress(0);
      token = await freshToken();
      continue;
    }
    throw error;
  }
}

/** Uploads a price file; resolves with the new import or rejects with an `ApiError`. */
export function uploadPriceFile(
  file: File,
  language: string,
  onProgress: (fraction: number) => void,
): Promise<PriceImport> {
  const query = new URLSearchParams({ fileName: file.name.slice(0, 255) });
  return uploaded(
    {
      method: "POST",
      path: `${apiRoutes.uploadPriceImport.path}?${query.toString()}`,
      body: file,
      contentType: "application/octet-stream",
      ok: 201,
    },
    language,
    onProgress,
  );
}

/** Uploads photographed pages in their order (TASK-064). */
export function uploadPricePhotos(
  pages: readonly Blob[],
  language: string,
  onProgress: (fraction: number) => void,
): Promise<PriceImport> {
  const form = new FormData();
  pages.forEach((page, index) => form.append("page", page, `page-${String(index + 1)}.jpg`));
  return uploaded(
    {
      method: "POST",
      path: apiRoutes.uploadPricePhotos.path,
      body: form,
      contentType: null,
      ok: 201,
    },
    language,
    onProgress,
  );
}

/** «Переснять»: one page of an import taken again. */
export function retakePricePhoto(
  importId: string,
  pageNo: number,
  page: Blob,
  language: string,
  onProgress: (fraction: number) => void,
): Promise<PriceImport> {
  const path = apiRoutes.retakePricePhoto.path
    .replace("{importId}", encodeURIComponent(importId))
    .replace("{pageNo}", String(pageNo));
  return uploaded(
    { method: "PUT", path, body: page, contentType: "application/octet-stream", ok: 200 },
    language,
    onProgress,
  );
}

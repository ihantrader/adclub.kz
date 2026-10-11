/**
 * A small client of Meilisearch (TASK-045; ARCHITECTURE 10, 4.65) on the
 * standard `fetch`, without an SDK — like the other providers of the
 * project. Only what the index needs: indexes, settings, documents, tasks,
 * `multi-search`, `swap-indexes`, stats and health.
 *
 * Every failure to get an answer — the network, a timeout, a 5xx, a broken
 * body — is `SearchIndexUnavailableError`: the search answers from
 * PostgreSQL then, and the worker tries again later. An index that does not
 * exist is `SearchIndexMissingError` (the worker builds it).
 */

export class SearchIndexUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SearchIndexUnavailableError";
  }
}

export class SearchIndexMissingError extends SearchIndexUnavailableError {
  constructor(index: string) {
    super(`Search index ${index} does not exist`);
    this.name = "SearchIndexMissingError";
  }
}

/** A task Meilisearch refused (a bad setting, a bad document): not a matter of retrying. */
export class SearchIndexTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchIndexTaskError";
  }
}

export interface MeiliTask {
  taskUid: number;
}

interface MeiliTaskState {
  uid: number;
  status: "enqueued" | "processing" | "succeeded" | "failed" | "canceled";
  type: string;
  error?: { message?: string; code?: string } | null;
}

export interface MeiliSearchQuery {
  indexUid: string;
  q: string;
  filter?: string | (string | string[])[];
  limit?: number;
  attributesToRetrieve?: string[];
  showRankingScore?: boolean;
  matchingStrategy?: "all" | "last" | "frequency";
}

export interface MeiliHit {
  id: string;
  _rankingScore?: number;
  [field: string]: unknown;
}

export interface MeiliSearchResult {
  indexUid: string;
  hits: MeiliHit[];
  estimatedTotalHits?: number;
}

export interface MeiliIndexStats {
  numberOfDocuments: number;
  isIndexing: boolean;
}

export interface MeiliClientOptions {
  url: string;
  apiKey: string | undefined;
  /** A request taking longer is given up (the search falls back to PostgreSQL). */
  timeoutMs: number;
}

export class MeiliClient {
  constructor(private readonly options: MeiliClientOptions) {}

  async health(): Promise<boolean> {
    try {
      const answer = await this.request<{ status?: string }>("GET", "/health");
      return answer.status === "available";
    } catch {
      return false;
    }
  }

  multiSearch(
    queries: MeiliSearchQuery[],
    timeoutMs?: number,
  ): Promise<{ results: MeiliSearchResult[] }> {
    return this.request("POST", "/multi-search", { queries }, timeoutMs);
  }

  createIndex(uid: string): Promise<MeiliTask> {
    return this.request("POST", "/indexes", { uid, primaryKey: "id" });
  }

  deleteIndex(uid: string): Promise<MeiliTask> {
    return this.request("DELETE", `/indexes/${encodeURIComponent(uid)}`);
  }

  async indexExists(uid: string): Promise<boolean> {
    try {
      await this.request("GET", `/indexes/${encodeURIComponent(uid)}`);
      return true;
    } catch (error) {
      if (error instanceof SearchIndexMissingError) {
        return false;
      }
      throw error;
    }
  }

  updateSettings(uid: string, settings: object): Promise<MeiliTask> {
    return this.request("PATCH", `/indexes/${encodeURIComponent(uid)}/settings`, settings);
  }

  updateSynonyms(uid: string, synonyms: Record<string, string[]>): Promise<MeiliTask> {
    return this.request("PUT", `/indexes/${encodeURIComponent(uid)}/settings/synonyms`, synonyms);
  }

  addDocuments(uid: string, documents: object[]): Promise<MeiliTask> {
    return this.request("POST", `/indexes/${encodeURIComponent(uid)}/documents`, documents);
  }

  deleteDocuments(uid: string, ids: string[]): Promise<MeiliTask> {
    return this.request("POST", `/indexes/${encodeURIComponent(uid)}/documents/delete-batch`, ids);
  }

  /** A page of documents with only these fields. */
  fetchDocuments(
    uid: string,
    page: { offset: number; limit: number; fields: string[] },
  ): Promise<{ results: Record<string, unknown>[]; total: number }> {
    return this.request("POST", `/indexes/${encodeURIComponent(uid)}/documents/fetch`, page);
  }

  stats(uid: string): Promise<MeiliIndexStats> {
    return this.request("GET", `/indexes/${encodeURIComponent(uid)}/stats`);
  }

  /** Swaps the contents of two indexes at once: what searched one now searches the other. */
  swapIndexes(a: string, b: string): Promise<MeiliTask> {
    return this.request("POST", "/swap-indexes", [{ indexes: [a, b] }]);
  }

  /** Waits for a task; a failed task throws `SearchIndexTaskError`. */
  async waitForTask(task: MeiliTask, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let pause = 25;
    for (;;) {
      const state = await this.request<MeiliTaskState>("GET", `/tasks/${task.taskUid}`);
      if (state.status === "succeeded") {
        return;
      }
      if (state.status === "failed" || state.status === "canceled") {
        throw new SearchIndexTaskError(
          `Search index task ${state.type} ${state.status}: ${state.error?.code ?? ""} ${state.error?.message ?? ""}`.trim(),
        );
      }
      if (Date.now() > deadline) {
        throw new SearchIndexUnavailableError(
          `Search index task ${state.type} did not finish in ${timeoutMs} ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pause));
      pause = Math.min(pause * 2, 500);
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.options.timeoutMs,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (this.options.apiKey) {
      headers.Authorization = `Bearer ${this.options.apiKey}`;
    }
    let response: Response;
    try {
      response = await fetch(`${this.options.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The address is ours (configuration), the error says only how it failed.
      throw new SearchIndexUnavailableError(
        `Search index did not answer ${method} ${path.split("?")[0]}: ${
          error instanceof Error ? error.name : "error"
        }`,
      );
    }
    const text = await response.text().catch(() => "");
    let parsed: unknown = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new SearchIndexUnavailableError(
          `Search index answered ${method} ${path} with a body that is not JSON (${response.status})`,
        );
      }
    }
    if (response.ok) {
      return parsed as T;
    }
    const error = (parsed ?? {}) as { code?: string; message?: string };
    if (error.code === "index_not_found") {
      const match = /^\/indexes\/([^/]+)/.exec(path);
      throw new SearchIndexMissingError(match ? decodeURIComponent(match[1]!) : "?");
    }
    if (response.status >= 500 || response.status === 429) {
      throw new SearchIndexUnavailableError(
        `Search index answered ${method} ${path}: ${response.status} ${error.code ?? ""}`.trim(),
      );
    }
    // A request we built wrong (a key without the right, a bad filter): our
    // mistake, never retried into success — but the search still answers.
    throw new SearchIndexTaskError(
      `Search index refused ${method} ${path}: ${response.status} ${error.code ?? ""} ${error.message ?? ""}`.trim(),
    );
  }
}

import { Injectable } from "@nestjs/common";

/**
 * The `fetch` the stores are called with (TASK-041). The tests replace
 * `fetch` to answer as Apple and Google would; nothing else does.
 */
@Injectable()
export class StoreFetch {
  fetch: (input: string, init: RequestInit) => Promise<Response> = (input, init) =>
    globalThis.fetch(input, init);
}

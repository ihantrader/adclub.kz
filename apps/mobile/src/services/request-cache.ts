/**
 * A short memory of answers the screens of one flow share (ARCHITECTURE
 * 4.39). The steps of choosing a car are screens of their own and all of
 * them read the same few answers of the vehicle catalog — the generations of
 * a model for the year and the generation, the modifications of a generation
 * for the body, the engine, the gearbox and the drive. Without a memory each
 * new screen would ask again and show a skeleton for the half second the
 * platform spends sliding it in, which is exactly the «дёргается» this
 * exists to remove.
 *
 * Deliberately not a cache of the catalog: an answer is kept for a short
 * time, only for the requests that ask for it (`useRequest` option `cache`),
 * and only as a starting point — the screen still owns its own state, and
 * «Повторить» always asks the server. The clock is injected so the rule is
 * tested without waiting.
 */
export interface CachedAnswer<T> {
  value: T;
  /** When the answer was written — a screen that starts with it is as old as it is. */
  at: number;
}

export interface RequestCache {
  /** The answer kept under `key`, or `undefined` when there is none or it is too old. */
  read<T>(key: string): CachedAnswer<T> | undefined;
  write<T>(key: string, value: T): void;
  clear(): void;
}

export function createRequestCache(ttlMs: number, now: () => number = Date.now): RequestCache {
  const entries = new Map<string, { value: unknown; at: number }>();
  return {
    read<T>(key: string): CachedAnswer<T> | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return { value: entry.value as T, at: entry.at };
    },
    write<T>(key: string, value: T): void {
      entries.set(key, { value, at: now() });
    },
    clear(): void {
      entries.clear();
    },
  };
}

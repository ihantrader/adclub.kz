/**
 * What the app keeps on the device (ARCHITECTURE 4.37): the interface
 * language, the chosen city, whether the first run is done and the theme
 * mode. Nothing here is a secret, and nothing is sent anywhere by itself —
 * with TASK-029 the language and the city also travel with the account,
 * and this store stays the copy of the device.
 *
 * The store is plain TypeScript with an injected storage adapter (the same
 * shape as `createThemeModeStore` in `@adclub/ui-core`), so its rules are
 * tested without React Native.
 */
export interface DeviceStorage {
  read(key: string): string | null | Promise<string | null>;
  write(key: string, value: string): void | Promise<void>;
}

export interface DeviceStore<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
  /** Resolves once the stored value (if any) has been read. */
  ready: Promise<void>;
}

export interface DeviceStoreOptions<T> {
  key: string;
  initial: T;
  /** Returns the stored value, or `null` when it is missing or unusable. */
  parse: (raw: unknown) => T | null;
}

/**
 * Keeps a value in memory, persists changes as JSON and notifies
 * subscribers. Storage failures never break the app: the initial value
 * stays in effect and the choice lasts for this session. A value set
 * before the read finished is not overwritten by the stored one.
 */
export function createDeviceStore<T>(
  storage: DeviceStorage,
  { key, initial, parse }: DeviceStoreOptions<T>,
): DeviceStore<T> {
  let value = initial;
  let changedBeforeRead = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  const apply = (raw: string | null) => {
    if (changedBeforeRead || raw === null) return;
    let parsed: T | null;
    try {
      parsed = parse(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (parsed === null) return;
    value = parsed;
    notify();
  };

  let ready: Promise<void>;
  try {
    const raw = storage.read(key);
    if (raw instanceof Promise) {
      ready = raw.then(apply, () => undefined);
    } else {
      apply(raw);
      ready = Promise.resolve();
    }
  } catch {
    ready = Promise.resolve();
  }

  return {
    ready,
    get: () => value,
    set(next) {
      changedBeforeRead = true;
      value = next;
      notify();
      try {
        const result = storage.write(key, JSON.stringify(next));
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        // Unavailable storage: the choice lasts for this session only.
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Waits for a stored value, but never longer than `ms` — a stuck storage must not hold the splash. */
export function readyWithin(ready: Promise<void>, ms: number): Promise<void> {
  return Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

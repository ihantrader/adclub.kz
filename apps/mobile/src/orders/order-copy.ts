import { activeOrderSchema, type ActiveOrder, type ActiveOrdersResponse } from "@adclub/contracts";
import { newCopyKey, openCopy, readCopyKey, sealCopy, type RandomBytes } from "./copy-crypto";

/**
 * The saved copy of active orders (TASK-030 requirement 6; PRODUCT 6.7;
 * SCREENS «Сохранённая копия»; ARCHITECTURE 3.6). It holds exactly what
 * `GET /active-orders` answered — the codes, the QR, the item, the sum, the
 * supplier as the server gave it, after acceptance the address, the hours
 * and the phone — the server's time of that answer, and the account it was
 * saved for. Nothing is merged: every refresh replaces it whole, so an order
 * that finished is gone with the next refresh.
 *
 * What lies on the device is sealed (`copy-crypto.ts`): the text in the
 * ordinary storage, the key in the secure one. The store is plain
 * TypeScript with its storages passed in, like `createDeviceStore`, so
 * every rule here is tested without React Native.
 */

export interface SavedOrdersCopy {
  /** The account the copy was saved for: under any other it is not shown. */
  accountId: string;
  /** The server's clock of the answer — «Обновлено в {время}» (never the phone's). */
  serverTime: string;
  orders: ActiveOrder[];
  total: number;
  limit: number;
  truncated: boolean;
}

export function copyFromResponse(
  accountId: string,
  response: ActiveOrdersResponse,
): SavedOrdersCopy {
  return {
    accountId,
    serverTime: response.serverTime,
    orders: response.orders,
    total: response.total,
    limit: response.limit,
    truncated: response.truncated,
  };
}

/** A stored copy in the shape this version reads; `null` — not one (it is then deleted). */
export function parseSavedCopy(raw: unknown): SavedOrdersCopy | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.accountId !== "string" ||
    typeof record.serverTime !== "string" ||
    Number.isNaN(new Date(record.serverTime).getTime()) ||
    !Array.isArray(record.orders) ||
    typeof record.total !== "number" ||
    typeof record.limit !== "number" ||
    typeof record.truncated !== "boolean"
  ) {
    return null;
  }
  // An order this version cannot read (a newer server's field it does not
  // know is fine — a missing code is not) is left out rather than shown half.
  const orders: ActiveOrder[] = [];
  for (const entry of record.orders) {
    const parsed = activeOrderSchema.safeParse(entry);
    if (parsed.success) orders.push(parsed.data);
  }
  return {
    accountId: record.accountId,
    serverTime: record.serverTime,
    orders,
    total: record.total,
    limit: record.limit,
    truncated: record.truncated,
  };
}

/**
 * The copy a signed-in account may see: its own, and nothing for a guest or
 * another account (TASK-030 requirement 6: «копия привязана к учётной
 * записи, под которой сохранена»).
 */
export function copyFor(
  copy: SavedOrdersCopy | null,
  accountId: string | null,
): SavedOrdersCopy | null {
  return copy !== null && accountId !== null && copy.accountId === accountId ? copy : null;
}

/** A copy kept on the device for nobody who is signed in now is deleted. */
export function copyIsOrphaned(copy: SavedOrdersCopy | null, accountId: string | null): boolean {
  return copy !== null && copy.accountId !== accountId;
}

/** Whether the device holds active orders to open without a network (M-START-01 rule 5, M-START-03). */
export function hasSavedActiveOrders(
  copy: SavedOrdersCopy | null,
  accountId: string | null,
): boolean {
  return (copyFor(copy, accountId)?.orders.length ?? 0) > 0;
}

/**
 * The copy is behind the order just loaded from the server: the order is
 * active and the copy lacks it or has an older state of it, or the order is
 * over and the copy still holds it. The screen then refreshes the copy, so
 * the full-screen QR and the list without a network show what is true.
 */
export function copyIsBehind(
  copy: SavedOrdersCopy | null,
  order: { id: string; updatedAt: string; active: boolean },
): boolean {
  const kept = copy?.orders.find((entry) => entry.id === order.id);
  if (!order.active) return kept !== undefined;
  return kept === undefined || kept.updatedAt !== order.updatedAt;
}

// ------------------------------------------------------------------ the store

/** One value of a storage: `read`/`write`/`remove`, any of which may fail. */
export interface ValueStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

export interface OrdersCopyStoreDeps {
  /** The sealed copy (`AsyncStorage`). */
  sealed: ValueStorage;
  /** The key (`expo-secure-store`, this device only). */
  key: ValueStorage;
  random: RandomBytes;
}

export interface OrdersCopyStore {
  /** The copy in memory — whoever it was saved for; read it through `copyFor`. */
  get(): SavedOrdersCopy | null;
  subscribe(listener: () => void): () => void;
  /** Resolves once the device's copy has been read (or found missing or broken). */
  ready: Promise<void>;
  /** Replaces the copy and seals it to the device. */
  save(copy: SavedOrdersCopy): Promise<void>;
  /** Forgets the copy and deletes both the sealed text and its key (sign-out, `SESSION_ENDED`). */
  clear(): Promise<void>;
}

export function createOrdersCopyStore({
  sealed,
  key,
  random,
}: OrdersCopyStoreDeps): OrdersCopyStore {
  let value: SavedOrdersCopy | null = null;
  let changedBeforeRead = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  // Every write and delete goes in one line, in the order it was asked for:
  // a sign-out right after a refresh must not be overtaken by the refresh's
  // write landing later and putting the codes back.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const next = queue.then(work, work).catch(() => undefined);
    queue = next;
    return next;
  };

  const wipe = async () => {
    await Promise.allSettled([sealed.remove(), key.remove()]);
  };

  const keyToSeal = async (): Promise<Uint8Array> => {
    const kept = readCopyKey(await key.read().catch(() => null));
    if (kept) return kept;
    const fresh = newCopyKey(random);
    await key.write(fresh);
    return readCopyKey(fresh)!;
  };

  const ready = (async () => {
    try {
      const [text, keyText] = await Promise.all([sealed.read(), key.read()]);
      if (text === null) return;
      const copyKey = readCopyKey(keyText);
      const plain = copyKey ? openCopy(copyKey, text) : null;
      let parsed: SavedOrdersCopy | null = null;
      try {
        parsed = plain === null ? null : parseSavedCopy(JSON.parse(plain));
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        // Broken, cut short, sealed with a key that is gone: it can only
        // ever fail again — deleted, and the app goes on without it.
        await enqueue(wipe);
        return;
      }
      if (!changedBeforeRead) {
        value = parsed;
        notify();
      }
    } catch {
      // A storage that does not answer leaves the app without a copy, never broken.
    }
  })();

  return {
    ready,
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    save(copy) {
      changedBeforeRead = true;
      value = copy;
      notify();
      const plain = JSON.stringify({ version: 1, ...copy });
      return enqueue(async () => {
        // The copy lasts in memory even when the device cannot keep it.
        const copyKey = await keyToSeal();
        await sealed.write(sealCopy(copyKey, plain, random));
      });
    },
    clear() {
      changedBeforeRead = true;
      if (value !== null) {
        value = null;
        notify();
      }
      return enqueue(wipe);
    },
  };
}

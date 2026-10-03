import { describe, expect, it } from "vitest";
import { COPY_KEY_BYTES, newCopyKey, readCopyKey, sealCopy } from "./copy-crypto";
import {
  copyFor,
  copyFromResponse,
  copyIsBehind,
  copyIsOrphaned,
  createOrdersCopyStore,
  hasSavedActiveOrders,
  parseSavedCopy,
  type ValueStorage,
} from "./order-copy";
import { activeOrder, activeOrdersResponse } from "./order-fixtures";

// Plain Node checks: the saved copy of active orders (TASK-030 requirement
// 6, AC-7) — what lies on the device, under which key, and what is shown.

/** A storage that keeps one value in memory, like `AsyncStorage` / `SecureStore` would. */
function memory(
  initial: string | null = null,
): ValueStorage & { value: string | null; fail?: boolean } {
  const store = {
    value: initial,
    fail: false,
    read: async () => {
      if (store.fail) throw new Error("storage is down");
      return store.value;
    },
    write: async (value: string) => {
      if (store.fail) throw new Error("storage is down");
      store.value = value;
    },
    remove: async () => {
      store.value = null;
    },
  };
  return store;
}

let counter = 0;
/** Not random — a test only needs distinct, repeatable bytes. */
const random = (count: number) =>
  Uint8Array.from({ length: count }, () => (counter++ * 37 + 11) % 256);

const ACCOUNT = "acc-1";
const order = activeOrder();
const copy = copyFromResponse(ACCOUNT, activeOrdersResponse([order]));

describe("the saved copy on the device", () => {
  it("never lies in the ordinary storage in the clear: no code, no QR, no item", async () => {
    const sealed = memory();
    const key = memory();
    const store = createOrdersCopyStore({ sealed, key, random });
    await store.ready;
    await store.save(copy);

    expect(sealed.value).not.toBeNull();
    for (const secret of [
      order.confirmation.code,
      order.confirmation.qrPayload,
      "ADCLUB-ORDER",
      "Автомаркет",
      "482",
    ]) {
      expect(sealed.value).not.toContain(secret);
    }
    // The key is in the other (secure) storage, never next to the copy.
    expect(key.value).not.toBeNull();
    expect(sealed.value).not.toContain(key.value!);
    expect(readCopyKey(key.value)).toHaveLength(COPY_KEY_BYTES);
  });

  it("is read back whole on the next start, with the server's time and its account", async () => {
    const sealed = memory();
    const key = memory();
    const first = createOrdersCopyStore({ sealed, key, random });
    await first.ready;
    await first.save(copy);

    const second = createOrdersCopyStore({ sealed, key, random });
    await second.ready;
    expect(second.get()).toEqual(copy);
    expect(second.get()?.serverTime).toBe("2026-10-04T10:12:00.000Z");
  });

  it("is deleted, not shown and not thrown, when broken, cut short or sealed with another key", async () => {
    const plain = JSON.stringify({ version: 1, ...copy });
    const goodKey = newCopyKey(random);
    const otherKey = newCopyKey(random);
    const sealedText = sealCopy(readCopyKey(goodKey)!, plain, random);
    const cases: Array<[string, string | null, string | null]> = [
      ["sealed with another key", sealedText, otherKey],
      ["the key is gone", sealedText, null],
      [
        "one bit changed",
        sealedText.replace(/"c":"(.)/, (_, c: string) => `"c":"${c === "A" ? "B" : "A"}`),
        goodKey,
      ],
      ["cut short", sealedText.slice(0, sealedText.length - 12), goodKey],
      ["not sealed at all — the copy in the clear", plain, goodKey],
      ["garbage", "{{{", goodKey],
      ["a broken key", sealedText, "not-a-key"],
    ];
    for (const [name, text, keyText] of cases) {
      const sealed = memory(text);
      const key = memory(keyText);
      const store = createOrdersCopyStore({ sealed, key, random });
      await expect(store.ready, name).resolves.toBeUndefined();
      expect(store.get(), name).toBeNull();
      expect(sealed.value, name).toBeNull();
      expect(key.value, name).toBeNull();
    }
  });

  it("drops the copy of a format it does not know, and an order it cannot read, keeping the rest", () => {
    expect(parseSavedCopy({ version: 2, ...copy })).toBeNull();
    expect(parseSavedCopy({ ...copy })).toBeNull();
    expect(parseSavedCopy({ version: 1, ...copy, serverTime: "yesterday" })).toBeNull();
    const broken = { ...activeOrder(), confirmation: undefined };
    const parsed = parseSavedCopy({ version: 1, ...copy, orders: [broken, order] });
    expect(parsed?.orders.map((entry) => entry.id)).toEqual([order.id]);
  });

  it("goes with the session: both the sealed text and its key are deleted", async () => {
    const sealed = memory();
    const key = memory();
    const store = createOrdersCopyStore({ sealed, key, random });
    await store.ready;
    await store.save(copy);
    await store.clear();
    expect(store.get()).toBeNull();
    expect(sealed.value).toBeNull();
    expect(key.value).toBeNull();
  });

  it("is not put back by a refresh that finishes after the sign-out", async () => {
    const sealed = memory();
    const key = memory();
    const store = createOrdersCopyStore({ sealed, key, random });
    await store.ready;
    const saving = store.save(copy);
    const clearing = store.clear();
    await Promise.all([saving, clearing]);
    expect(store.get()).toBeNull();
    expect(sealed.value).toBeNull();
    expect(key.value).toBeNull();
  });

  it("makes a new key after a sign-out: what was left of the old text can never be opened", async () => {
    const sealed = memory();
    const key = memory();
    const store = createOrdersCopyStore({ sealed, key, random });
    await store.ready;
    await store.save(copy);
    const before = key.value;
    await store.clear();
    await store.save(copy);
    expect(key.value).not.toBe(before);
  });

  it("keeps working in memory when the device storage fails", async () => {
    const sealed = memory();
    sealed.fail = true;
    const key = memory();
    const store = createOrdersCopyStore({ sealed, key, random });
    await store.ready;
    await expect(store.save(copy)).resolves.toBeUndefined();
    expect(store.get()).toEqual(copy);
  });

  it("does not let a late read overwrite a copy saved meanwhile", async () => {
    const sealed = memory();
    const key = memory();
    const old = createOrdersCopyStore({ sealed, key, random });
    await old.ready;
    await old.save(copyFromResponse(ACCOUNT, activeOrdersResponse([activeOrder()])));

    const store = createOrdersCopyStore({ sealed, key, random });
    await store.save(copy);
    await store.ready;
    expect(store.get()).toEqual(copy);
  });
});

describe("whose copy it is", () => {
  it("is shown only to the account it was saved for", () => {
    expect(copyFor(copy, ACCOUNT)).toBe(copy);
    expect(copyFor(copy, "acc-2")).toBeNull();
    expect(copyFor(copy, null)).toBeNull();
    expect(copyFor(null, ACCOUNT)).toBeNull();
  });

  it("is orphaned — and deleted — under a guest or another account", () => {
    expect(copyIsOrphaned(copy, ACCOUNT)).toBe(false);
    expect(copyIsOrphaned(copy, null)).toBe(true);
    expect(copyIsOrphaned(copy, "acc-2")).toBe(true);
    expect(copyIsOrphaned(null, null)).toBe(false);
  });

  it("counts as saved active orders for the start only with orders in it, and only for its account", () => {
    expect(hasSavedActiveOrders(copy, ACCOUNT)).toBe(true);
    expect(hasSavedActiveOrders(copy, "acc-2")).toBe(false);
    expect(hasSavedActiveOrders({ ...copy, orders: [] }, ACCOUNT)).toBe(false);
  });
});

describe("when the copy is behind the order just loaded", () => {
  it("asks again for an active order it lacks or holds older, and for a finished one it still holds", () => {
    expect(copyIsBehind(copy, { id: order.id, updatedAt: order.updatedAt, active: true })).toBe(
      false,
    );
    expect(
      copyIsBehind(copy, { id: order.id, updatedAt: "2026-10-04T11:00:00.000Z", active: true }),
    ).toBe(true);
    expect(copyIsBehind(copy, { id: "another", updatedAt: order.updatedAt, active: true })).toBe(
      true,
    );
    expect(copyIsBehind(copy, { id: order.id, updatedAt: order.updatedAt, active: false })).toBe(
      true,
    );
    expect(copyIsBehind(copy, { id: "another", updatedAt: order.updatedAt, active: false })).toBe(
      false,
    );
    expect(copyIsBehind(null, { id: order.id, updatedAt: order.updatedAt, active: true })).toBe(
      true,
    );
  });
});

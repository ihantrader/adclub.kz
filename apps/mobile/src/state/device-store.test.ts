import { describe, expect, it, vi } from "vitest";
import { createDeviceStore, readyWithin, type DeviceStorage } from "./device-store";

function memoryStorage(initial: Record<string, string> = {}): DeviceStorage & {
  written: Record<string, string>;
} {
  const written = { ...initial };
  return {
    written,
    read: (key) => Promise.resolve(written[key] ?? null),
    write: (key, value) => {
      written[key] = value;
      return Promise.resolve();
    },
  };
}

const OPTIONS = {
  key: "adclub.test.value",
  initial: "ru" as string,
  parse: (raw: unknown) => (typeof raw === "string" ? raw : null),
};

describe("createDeviceStore", () => {
  it("starts at the initial value and applies the stored one when it is read", async () => {
    const store = createDeviceStore(
      memoryStorage({ "adclub.test.value": JSON.stringify("kk") }),
      OPTIONS,
    );
    expect(store.get()).toBe("ru");
    await store.ready;
    expect(store.get()).toBe("kk");
  });

  it("persists a change and notifies subscribers", async () => {
    const storage = memoryStorage();
    const store = createDeviceStore(storage, OPTIONS);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set("en");
    expect(store.get()).toBe("en");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storage.written["adclub.test.value"]).toBe('"en"');
  });

  it("does not let the stored value overwrite a choice made before the read finished", async () => {
    const store = createDeviceStore(
      memoryStorage({ "adclub.test.value": JSON.stringify("kk") }),
      OPTIONS,
    );
    store.set("en");
    await store.ready;
    expect(store.get()).toBe("en");
  });

  it("keeps working when the stored value is broken or of the wrong shape", async () => {
    const broken = createDeviceStore({ read: () => "{not json", write: () => undefined }, OPTIONS);
    await broken.ready;
    expect(broken.get()).toBe("ru");

    const wrong = createDeviceStore({ read: () => "42", write: () => undefined }, OPTIONS);
    await wrong.ready;
    expect(wrong.get()).toBe("ru");
  });

  it("survives a storage that throws or rejects", async () => {
    const store = createDeviceStore(
      {
        read: () => {
          throw new Error("no storage");
        },
        write: () => {
          throw new Error("no storage");
        },
      },
      OPTIONS,
    );
    await store.ready;
    store.set("kk");
    expect(store.get()).toBe("kk");

    const rejecting = createDeviceStore(
      { read: () => Promise.reject(new Error("locked")), write: () => Promise.reject(new Error()) },
      OPTIONS,
    );
    await rejecting.ready;
    rejecting.set("en");
    expect(rejecting.get()).toBe("en");
  });

  it("unsubscribes", () => {
    const store = createDeviceStore(memoryStorage(), OPTIONS);
    const listener = vi.fn();
    store.subscribe(listener)();
    store.set("kk");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("readyWithin", () => {
  it("resolves on its own when the storage never answers", async () => {
    await expect(readyWithin(new Promise<void>(() => undefined), 5)).resolves.toBeUndefined();
  });

  it("resolves as soon as the storage does", async () => {
    await expect(readyWithin(Promise.resolve(), 10_000)).resolves.toBeUndefined();
  });
});

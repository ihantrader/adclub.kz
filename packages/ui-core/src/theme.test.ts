import { describe, expect, it, vi } from "vitest";
import {
  createThemeModeStore,
  defaultThemeMode,
  resolveThemeName,
  type ThemeModeStorage,
} from "./index";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const storage: ThemeModeStorage = {
    read: () => value,
    write: (next) => {
      value = next;
    },
  };
  return { storage, current: () => value };
}

describe("theme defaults and resolution", () => {
  it("defaults to dark on the phone and light in the cabinet and admin (DESIGN.md 7.3)", () => {
    expect(defaultThemeMode).toEqual({ mobile: "dark", supplierWeb: "light", adminWeb: "light" });
  });

  it("follows the OS scheme only in system mode", () => {
    expect(resolveThemeName("dark", "light", "light")).toBe("dark");
    expect(resolveThemeName("light", "dark", "dark")).toBe("light");
    expect(resolveThemeName("system", "dark", "light")).toBe("dark");
    expect(resolveThemeName("system", "light", "dark")).toBe("light");
  });

  it("falls back to the client default when the OS reports no scheme", () => {
    expect(resolveThemeName("system", null, "dark")).toBe("dark");
    expect(resolveThemeName("system", undefined, "light")).toBe("light");
  });
});

describe("theme mode store", () => {
  it("starts with the default and applies a valid stored mode", async () => {
    expect(createThemeModeStore(memoryStorage().storage, "dark").getMode()).toBe("dark");
    const store = createThemeModeStore(memoryStorage("system").storage, "dark");
    await store.ready;
    expect(store.getMode()).toBe("system");
  });

  it("ignores garbage in storage", () => {
    const store = createThemeModeStore(memoryStorage("purple").storage, "light");
    expect(store.getMode()).toBe("light");
  });

  it("changes immediately, persists and notifies", () => {
    const memory = memoryStorage();
    const store = createThemeModeStore(memory.storage, "light");
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setMode("dark");
    expect(store.getMode()).toBe("dark");
    expect(memory.current()).toBe("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    store.setMode("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.setMode("system");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("works with the default when storage is unavailable (private mode)", async () => {
    const broken: ThemeModeStorage = {
      read: () => {
        throw new Error("SecurityError");
      },
      write: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const store = createThemeModeStore(broken, "light");
    await store.ready;
    expect(store.getMode()).toBe("light");
    expect(() => store.setMode("dark")).not.toThrow();
    expect(store.getMode()).toBe("dark");
  });

  it("reads asynchronous storage (AsyncStorage) and notifies when it arrives", async () => {
    const storage: ThemeModeStorage = {
      read: () => Promise.resolve("light"),
      write: () => Promise.resolve(),
    };
    const store = createThemeModeStore(storage, "dark");
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.getMode()).toBe("dark");
    await store.ready;
    expect(store.getMode()).toBe("light");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps a choice made before the stored value was read", async () => {
    let resolve: (value: string | null) => void = () => undefined;
    const storage: ThemeModeStorage = {
      read: () => new Promise((r) => (resolve = r)),
      write: () => Promise.reject(new Error("disk full")),
    };
    const store = createThemeModeStore(storage, "dark");
    store.setMode("system");
    resolve("light");
    await store.ready;
    expect(store.getMode()).toBe("system");
  });

  it("survives a failing asynchronous read", async () => {
    const storage: ThemeModeStorage = {
      read: () => Promise.reject(new Error("unavailable")),
      write: () => undefined,
    };
    const store = createThemeModeStore(storage, "dark");
    await expect(store.ready).resolves.toBeUndefined();
    expect(store.getMode()).toBe("dark");
  });

  it("keeps separate choices for separate keys (cabinet and admin in one browser)", () => {
    const shared = new Map<string, string>();
    const keyed = (key: string): ThemeModeStorage => ({
      read: () => shared.get(key) ?? null,
      write: (value) => void shared.set(key, value),
    });
    const cabinet = createThemeModeStore(keyed("adclub.supplier-web.theme"), "light");
    cabinet.setMode("dark");
    const admin = createThemeModeStore(keyed("adclub.admin-web.theme"), "light");
    expect(admin.getMode()).toBe("light");
    expect(createThemeModeStore(keyed("adclub.supplier-web.theme"), "light").getMode()).toBe(
      "dark",
    );
  });
});

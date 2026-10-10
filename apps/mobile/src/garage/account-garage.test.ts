import type { AccountCar, AddGarageCarBody, SaveGarageCarBody } from "@adclub/contracts";
import { ApiError } from "@adclub/api-client";
import { sameCarIdentity, carIdentity } from "@adclub/domain";
import { describe, expect, it } from "vitest";
import { catalogEntry } from "../catalog/catalog-gate";
import {
  createAccountGarage,
  parseAccountGarageCopy,
  visibleGarage,
  type AccountGarageApi,
  type AccountGarageCopy,
  type ValueStore,
} from "./account-garage";
import { INITIAL_GARAGE, type GarageCar, type GarageState } from "./garage";

/**
 * The account garage of TASK-029.B against a fake server that keeps one
 * account's garage the way the real one does (I425–I427, ARCHITECTURE 4.46):
 * two "devices" are two `createAccountGarage` with their own copies and the
 * same server.
 */

const ACCOUNT = "account-1";

function level(id: string, label: string) {
  return { id, label };
}

function car(id: string, model: string, overrides: Partial<GarageCar> = {}): GarageCar {
  return {
    id,
    make: level("make-geely", "Geely"),
    model: level(`model-${model}`, model),
    year: 2023,
    generation: null,
    body: null,
    engine: null,
    transmission: null,
    drive: null,
    modificationId: null,
    color: null,
    vin: null,
    plate: null,
    document: null,
    addedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

/** One account's garage on the "server". */
function fakeServer() {
  let clock = Date.parse("2026-10-05T10:00:00.000Z");
  let next = 1;
  const cars: AccountCar[] = [];
  const keys = new Map<string, string>();
  const calls: string[] = [];
  let offline = false;
  /** Holds the answer of the next `list()` until released (a slow read). */
  let gate: Promise<void> | null = null;

  function insert(body: Omit<SaveGarageCarBody, "document">, isPrimary: boolean): AccountCar {
    clock += 1000;
    const at = new Date(clock).toISOString();
    const row: AccountCar = {
      id: `server-car-${String(next++)}`,
      ...body.levels,
      modificationId: body.modificationId ?? null,
      color: body.color,
      vin: body.vin ?? null,
      plate: body.plate ?? null,
      document: null,
      isPrimary,
      createdAt: at,
      updatedAt: at,
    };
    cars.push(row);
    return row;
  }
  const newestFirst = () => [...cars].reverse().map((item) => ({ ...item }));
  const notFound = () =>
    new ApiError({ code: "NOT_FOUND", message: "No such car", status: 404, retryable: false });
  const network = () =>
    new ApiError({ code: "NETWORK_ERROR", message: "offline", status: 0, retryable: true });
  const guard = (name: string) => {
    calls.push(name);
    if (offline) throw network();
  };

  const api: AccountGarageApi = {
    async list() {
      guard("list");
      const snapshot = newestFirst();
      const held = gate;
      gate = null;
      if (held) await held;
      return snapshot;
    },
    async add(body: AddGarageCarBody) {
      guard("add");
      const earlier = body.idempotencyKey ? keys.get(body.idempotencyKey) : undefined;
      const found = cars.find((item) => item.id === earlier);
      if (found) return { ...found };
      const row = insert(body, cars.length === 0);
      if (body.idempotencyKey) keys.set(body.idempotencyKey, row.id);
      return { ...row };
    },
    async update(carId, body) {
      guard("update");
      const row = cars.find((item) => item.id === carId);
      if (!row) throw notFound();
      Object.assign(row, body.levels, {
        modificationId: body.modificationId ?? null,
        color: body.color,
      });
      return { ...row };
    },
    async remove(carId) {
      guard("remove");
      const index = cars.findIndex((item) => item.id === carId);
      if (index < 0) throw notFound();
      const [removed] = cars.splice(index, 1);
      if (removed?.isPrimary && cars[0]) cars[0].isPrimary = true;
    },
    async makePrimary(carId) {
      guard("makePrimary");
      const row = cars.find((item) => item.id === carId);
      if (!row) throw notFound();
      for (const item of cars) item.isPrimary = item.id === carId;
      return { ...row };
    },
    async transfer(body) {
      guard("transfer");
      const hadPrimary = cars.some((item) => item.isPrimary);
      let transferred = 0;
      let primary: string | null = null;
      for (const entry of body.cars) {
        let match = cars.find((item) =>
          sameCarIdentity(carIdentity(item), carIdentity(entry.levels)),
        );
        if (!match) {
          match = insert(entry, false);
          transferred += 1;
        }
        if (entry.isPrimary && primary === null) primary = match.id;
      }
      if (!hadPrimary && cars.length > 0) {
        const chosen = primary ?? cars[0]!.id;
        for (const item of cars) item.isPrimary = item.id === chosen;
      }
      return { cars: newestFirst(), transferred };
    },
  };

  return {
    api,
    cars,
    calls,
    setOffline(value: boolean) {
      offline = value;
    },
    /** Makes the next `list()` wait; call the returned function to let it answer. */
    holdNextList(): () => void {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
  };
}

function memory<T>(initial: T): ValueStore<T> & { value: T } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (value: T) => {
      store.value = value;
    },
  };
  return store;
}

function device(server: ReturnType<typeof fakeServer>, guest: GarageState = INITIAL_GARAGE) {
  const session = { accountId: ACCOUNT as string | null };
  const copy = memory<AccountGarageCopy | null>(null);
  const guestStore = memory<GarageState>(guest);
  const garage = createAccountGarage({
    api: server.api,
    copy,
    guest: guestStore,
    accountId: () => session.accountId,
  });
  const shown = () => visibleGarage(session.accountId, copy.value, guestStore.value);
  return { garage, copy, guest: guestStore, session, shown };
}

const titles = (state: GarageState) => state.cars.map((item) => item.model.label);
const primaryTitle = (state: GarageState) =>
  state.cars.find((item) => item.id === state.primaryId)?.model.label ?? null;

/** Lets the follow-up sync every change starts finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the garage of a signed-in person lives in the account (TASK-029.B)", () => {
  it("shows the guest garage to a guest, and the copy only to its own account", () => {
    const guest: GarageState = { version: 1, cars: [car("g1", "Coolray")], primaryId: "g1" };
    const copy: AccountGarageCopy = {
      version: 1,
      accountId: ACCOUNT,
      garage: { version: 1, cars: [car("a1", "Atlas")], primaryId: "a1" },
    };
    expect(titles(visibleGarage(null, copy, guest))).toEqual(["Coolray"]);
    expect(titles(visibleGarage(ACCOUNT, copy, guest))).toEqual(["Atlas"]);
    // Signed in with another number: never the previous account's cars.
    expect(titles(visibleGarage("account-2", copy, guest))).toEqual(["Coolray"]);
  });

  it("reads a stored copy back, and nothing else", () => {
    const copy: AccountGarageCopy = {
      version: 1,
      accountId: ACCOUNT,
      garage: { version: 1, cars: [car("a1", "Atlas")], primaryId: "a1" },
    };
    expect(parseAccountGarageCopy(JSON.parse(JSON.stringify(copy)))).toEqual(copy);
    expect(parseAccountGarageCopy({ version: 2, accountId: ACCOUNT, garage: copy.garage })).toBe(
      null,
    );
    expect(parseAccountGarageCopy({ version: 1, garage: copy.garage })).toBe(null);
  });

  it("transfers the guest garage at the first sync, with the modification, and empties it", async () => {
    const server = fakeServer();
    const guest: GarageState = {
      version: 1,
      cars: [
        car("g1", "Coolray"),
        car("g2", "Atlas", { modificationId: "mod-atlas", addedAt: "2026-10-01T11:00:00Z" }),
      ],
      primaryId: "g2",
    };
    const phone = device(server, guest);
    expect(titles(phone.shown())).toEqual(["Coolray", "Atlas"]);

    expect(await phone.garage.sync()).toEqual({ kind: "synced", transferred: 2 });
    expect(phone.guest.value).toEqual(INITIAL_GARAGE);
    expect(titles(phone.shown())).toEqual(["Coolray", "Atlas"]);
    expect(primaryTitle(phone.shown())).toBe("Atlas");
    expect(phone.shown().cars.find((item) => item.model.label === "Atlas")?.modificationId).toBe(
      "mod-atlas",
    );
    // Afterwards a sync only reads.
    expect(await phone.garage.sync()).toEqual({ kind: "synced", transferred: 0 });
    expect(server.calls).toEqual(["transfer", "list"]);
  });

  it("writes every change to the account first and shows it on a second phone at its next sync", async () => {
    const server = fakeServer();
    const first = device(server);
    const second = device(server);

    const atlas = await first.garage.add(car("draft-1", "Atlas", { color: "white" }), "key-1");
    const coolray = await first.garage.add(car("draft-2", "Coolray"), "key-2");
    await settle();
    expect(atlas.id).toBe("server-car-1");
    expect(titles(first.shown())).toEqual(["Atlas", "Coolray"]);

    await second.garage.sync();
    expect(titles(second.shown())).toEqual(["Atlas", "Coolray"]);
    expect(primaryTitle(second.shown())).toBe("Atlas");

    // Changing the colour, the main car, a parameter — each on the account.
    await first.garage.update({ ...coolray, color: "red", engine: level("engine-1", "1.5T") });
    await first.garage.makePrimary(coolray.id);
    await settle();
    await second.garage.sync();
    const there = second.shown().cars.find((item) => item.id === coolray.id)!;
    expect(there.color).toBe("red");
    expect(there.engine?.label).toBe("1.5T");
    expect(primaryTitle(second.shown())).toBe("Coolray");
  });

  it("never brings back a car removed on another phone — and the catalog moves to the new main car", async () => {
    const server = fakeServer();
    const first = device(server);
    const second = device(server);
    const atlas = await first.garage.add(car("d1", "Atlas"), "k1");
    await first.garage.add(car("d2", "Coolray"), "k2");
    await settle();
    await second.garage.sync();
    // The second phone's catalog is on the Atlas, the main car.
    const before = catalogEntry(second.shown());
    expect(before.kind === "open" && before.car.model.label).toBe("Atlas");

    await first.garage.remove(atlas.id);
    await settle();
    // Back from the background: the second phone syncs.
    await second.garage.sync();
    expect(titles(second.shown())).toEqual(["Coolray"]);
    const after = catalogEntry(second.shown());
    expect(after.kind === "open" && after.car.model.label).toBe("Coolray");
    // And again: still gone.
    await second.garage.sync();
    expect(titles(second.shown())).toEqual(["Coolray"]);
  });

  it("opens «Добавьте автомобиль» once the last car was removed elsewhere", async () => {
    const server = fakeServer();
    const first = device(server);
    const second = device(server);
    const only = await first.garage.add(car("d1", "Atlas"), "k1");
    await settle();
    await second.garage.sync();
    await first.garage.remove(only.id);
    await settle();
    await second.garage.sync();
    expect(catalogEntry(second.shown())).toEqual({ kind: "needs-car" });
  });

  it("changes nothing on the device when the server refuses or cannot be reached", async () => {
    const server = fakeServer();
    const phone = device(server);
    const atlas = await phone.garage.add(car("d1", "Atlas"), "k1");
    await settle();
    const before = phone.shown();

    server.setOffline(true);
    await expect(phone.garage.add(car("d2", "Coolray"), "k2")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    await expect(phone.garage.update({ ...atlas, color: "red" })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    await expect(phone.garage.remove(atlas.id)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await settle();
    expect(phone.shown()).toEqual(before);
    // The copy is still there to look at without a network.
    expect(await phone.garage.sync()).toMatchObject({ kind: "failed" });
    expect(titles(phone.shown())).toEqual(["Atlas"]);

    // A refusal of the server (a car that is gone) — the copy follows the server.
    server.setOffline(false);
    server.cars.splice(0, server.cars.length);
    await expect(phone.garage.update({ ...atlas, color: "red" })).rejects.toMatchObject({
      status: 404,
    });
    await settle();
    expect(titles(phone.shown())).toEqual([]);
  });

  it("adds one car, not two, when an answer was lost and «Сохранить» is pressed again", async () => {
    const server = fakeServer();
    const phone = device(server);
    // The first request reached the server; its answer never came back.
    await server.api.add({
      levels: {
        make: level("make-geely", "Geely"),
        model: level("model-Atlas", "Atlas"),
        year: 2023,
        generation: null,
        body: null,
        engine: null,
        transmission: null,
        drive: null,
      },
      color: null,
      idempotencyKey: "same-screen",
    });
    await phone.garage.add(car("d1", "Atlas"), "same-screen");
    await settle();
    expect(server.cars).toHaveLength(1);
    expect(titles(phone.shown())).toEqual(["Atlas"]);
  });

  it("takes a removal of a car already gone as done", async () => {
    const server = fakeServer();
    const phone = device(server);
    const atlas = await phone.garage.add(car("d1", "Atlas"), "k1");
    await settle();
    server.cars.splice(0, server.cars.length);
    await expect(phone.garage.remove(atlas.id)).resolves.toBeUndefined();
    expect(titles(phone.shown())).toEqual([]);
  });

  it("drops a read that began before a change and answered after it", async () => {
    const server = fakeServer();
    const phone = device(server);
    await phone.garage.sync();
    const release = server.holdNextList();
    const slowRead = phone.garage.sync();
    // The read has the garage without the Atlas; the Atlas is added meanwhile.
    await phone.garage.add(car("d1", "Atlas"), "k1");
    release();
    expect(await slowRead).toEqual({ kind: "stale" });
    await settle();
    expect(titles(phone.shown())).toEqual(["Atlas"]);
  });

  it("writes nothing for an account that is no longer signed in", async () => {
    const server = fakeServer();
    await server.api.add({
      levels: {
        make: level("make-geely", "Geely"),
        model: level("model-Atlas", "Atlas"),
        year: 2023,
        generation: null,
        body: null,
        engine: null,
        transmission: null,
        drive: null,
      },
      color: null,
    });
    const phone = device(server);
    const release = server.holdNextList();
    const read = phone.garage.sync();
    phone.session.accountId = null;
    release();
    expect(await read).toEqual({ kind: "skipped" });
    expect(phone.copy.value).toBe(null);
    await expect(phone.garage.add(car("d1", "Atlas"), "k")).rejects.toThrow();
  });
});

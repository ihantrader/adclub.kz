import type { Lang } from "@adclub/i18n";
import { describe, expect, it } from "vitest";
import type { CitySelection } from "./city";
import {
  decideProfileSync,
  parseProfileSync,
  runProfileSync,
  type ProfileSyncState,
  type ProfileValues,
} from "./profile-sync";

const ALMATY: CitySelection = { kind: "city", id: "city-almaty", code: "almaty", name: "Алматы" };
const ASTANA: CitySelection = { kind: "city", id: "city-astana", code: "astana", name: "Астана" };
const CITIES = [ALMATY, ASTANA];

/** A phone signed in to one account; the "server" is a shared object. */
function phone(
  server: { values: ProfileValues; patches: unknown[]; offline: boolean },
  device: { city: CitySelection; language: Lang | null },
  options: { citiesUnavailable?: boolean } = {},
) {
  const state = {
    city: device.city,
    language: device.language,
    synced: null as ProfileSyncState | null,
    /** What `synced` was at the moment the device stores changed. */
    syncedWhenApplied: [] as (ProfileSyncState | null)[],
  };
  const cityIdOf = (selection: CitySelection) => (selection.kind === "city" ? selection.id : null);
  const run = (readAccount: boolean) =>
    runProfileSync({
      accountId: "account-1",
      account: readAccount ? { ...server.values } : null,
      device: () => ({ cityId: cityIdOf(state.city), language: state.language }),
      synced: {
        get: () => state.synced,
        set: (value) => {
          state.synced = value;
        },
      },
      resolveCity: async (cityId) =>
        options.citiesUnavailable
          ? "unavailable"
          : (CITIES.find((city) => city.kind === "city" && city.id === cityId) ?? { kind: "all" }),
      setDeviceCity: (selection) => {
        state.syncedWhenApplied.push(state.synced);
        state.city = selection;
      },
      setDeviceLanguage: (lang) => {
        state.syncedWhenApplied.push(state.synced);
        state.language = lang;
      },
      push: async (patch) => {
        if (server.offline) throw new Error("offline");
        server.patches.push(patch);
        server.values = { ...server.values, ...patch };
      },
    });
  return { state, run };
}

function server(values: ProfileValues) {
  return { values, patches: [] as unknown[], offline: false };
}

describe("the city and the language of a signed-in person (TASK-029.B)", () => {
  it("takes the account's city and language on a new phone, without sending the phone's back", async () => {
    const account = server({ cityId: "city-astana", language: "kk" });
    const fresh = phone(account, { city: { kind: "all" }, language: "ru" });
    await fresh.run(true);
    expect(fresh.state.city).toEqual(ASTANA);
    expect(fresh.state.language).toBe("kk");
    expect(account.patches).toEqual([]);
    // What was agreed is written before the device changes: the change of the
    // device store then finds nothing to send.
    expect(fresh.state.syncedWhenApplied).toEqual([
      { accountId: "account-1", cityId: "city-astana", language: "kk" },
      { accountId: "account-1", cityId: "city-astana", language: "kk" },
    ]);
    await fresh.run(false);
    expect(account.patches).toEqual([]);
  });

  it("sends the phone's values to an account that has none yet", async () => {
    const account = server({ cityId: null, language: null });
    const device = phone(account, { city: ALMATY, language: "ru" });
    await device.run(true);
    expect(account.patches).toEqual([{ cityId: "city-almaty", language: "ru" }]);
    expect(device.state.city).toEqual(ALMATY);
  });

  it("sends a change made on this phone, and brings one made on another — the last one wins", async () => {
    const account = server({ cityId: "city-almaty", language: "ru" });
    const first = phone(account, { city: ALMATY, language: "ru" });
    const second = phone(account, { city: ALMATY, language: "ru" });
    await first.run(true);
    await second.run(true);
    expect(account.patches).toEqual([]);

    // On the first phone: Kazakh and Astana (the device stores change, a pass follows).
    first.state.language = "kk";
    first.state.city = ASTANA;
    await first.run(false);
    expect(account.values).toEqual({ cityId: "city-astana", language: "kk" });

    // The second phone comes back from the background.
    await second.run(true);
    expect(second.state.language).toBe("kk");
    expect(second.state.city).toEqual(ASTANA);

    // «Весь Казахстан» on the second phone is a real choice once agreed.
    second.state.city = { kind: "all" };
    await second.run(false);
    await first.run(true);
    expect(first.state.city).toEqual({ kind: "all" });
  });

  it("keeps a change made without a network and sends it next time instead of losing it", async () => {
    const account = server({ cityId: "city-almaty", language: "ru" });
    const device = phone(account, { city: ALMATY, language: "ru" });
    await device.run(true);
    account.offline = true;
    device.state.language = "en";
    await expect(device.run(false)).rejects.toThrow("offline");
    account.offline = false;
    // Back from the background: the account still says Russian, but the
    // phone's English is the newer change.
    await device.run(true);
    expect(device.state.language).toBe("en");
    expect(account.values.language).toBe("en");
  });

  it("treats an archived city like any unknown one, and waits when the list cannot be read", async () => {
    const archived = server({ cityId: "city-gone", language: "ru" });
    const device = phone(archived, { city: ALMATY, language: "ru" });
    await device.run(true);
    expect(device.state.city).toEqual({ kind: "all" });
    // Nothing is written back over the account's city by that.
    expect(archived.patches).toEqual([]);

    const account = server({ cityId: "city-astana", language: "ru" });
    const offlineList = phone(
      account,
      { city: ALMATY, language: "ru" },
      { citiesUnavailable: true },
    );
    await offlineList.run(true);
    expect(offlineList.state.city).toEqual(ALMATY);
    expect(account.patches).toEqual([]);
  });

  it("never asks about a language when the device has none yet, and takes the account's", () => {
    expect(
      decideProfileSync({
        account: { cityId: null, language: "kk" },
        device: { cityId: null, language: null },
        synced: null,
      }).language,
    ).toEqual({ kind: "apply", value: "kk" });
  });

  it("reads what was agreed back, and nothing else", () => {
    expect(parseProfileSync({ accountId: "a", cityId: "c", language: "kk" })).toEqual({
      accountId: "a",
      cityId: "c",
      language: "kk",
    });
    expect(parseProfileSync({ accountId: "a", cityId: 1, language: "de" })).toEqual({
      accountId: "a",
      cityId: null,
      language: null,
    });
    expect(parseProfileSync({ cityId: "c" })).toBe(null);
  });
});

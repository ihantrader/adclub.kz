import { isLang, type Lang } from "@adclub/i18n";
import type { CitySelection } from "./city";

/**
 * The city and the interface language of a signed-in person live in the
 * account (TASK-029.B, ARCHITECTURE 4.46); the device keeps its own copy
 * (`cityStore`, `languageStore`) because a guest has them too and the app
 * must open without a network. This decides, field by field, which side is
 * right — pure, so it is tested as it is.
 *
 * `synced` is what this device and the account last agreed on (kept with the
 * session in `profileSyncStore`):
 *
 * - **Nothing agreed yet** (a sign-in on this device): the account's value
 *   wins when it has one — a new phone takes the city and the language the
 *   person already has; when the account has none, the device's goes there.
 * - **The device moved away from what was agreed** (changed here, not sent
 *   yet — no network, a failed request): the device's value is the newer
 *   one and goes to the account.
 * - **Otherwise the account's value** — changed on another phone — comes to
 *   this device. The last change wins.
 *
 * The city `null` is «Весь Казахстан». In the account it also means «never
 * set», so it counts as «no value» only before anything was agreed.
 */

export interface ProfileValues {
  cityId: string | null;
  language: Lang | null;
}

export interface ProfileSyncState extends ProfileValues {
  accountId: string;
}

export function parseProfileSync(raw: unknown): ProfileSyncState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.accountId !== "string") return null;
  const cityId = typeof value.cityId === "string" ? value.cityId : null;
  const language =
    typeof value.language === "string" && isLang(value.language) ? value.language : null;
  return { accountId: value.accountId, cityId, language };
}

export type FieldDecision<T> =
  /** Send the device's value to the account. */
  | { kind: "push"; value: T }
  /** Put the account's value on the device. */
  | { kind: "apply"; value: T }
  | { kind: "keep" };

export interface ProfileSyncInput {
  /** The account's values; `null` — not read this time (only the device changed). */
  account: ProfileValues | null;
  device: ProfileValues;
  /** What was last agreed with this account on this device; `null` — nothing yet. */
  synced: ProfileValues | null;
}

export interface ProfileSyncDecision {
  city: FieldDecision<string | null>;
  language: FieldDecision<Lang>;
}

function decideCity(input: ProfileSyncInput): FieldDecision<string | null> {
  const device = input.device.cityId;
  const account = input.account?.cityId;
  if (input.synced === null) {
    if (account !== undefined && account !== null) {
      return account === device ? { kind: "keep" } : { kind: "apply", value: account };
    }
    return account === device ? { kind: "keep" } : { kind: "push", value: device };
  }
  if (device !== input.synced.cityId) return { kind: "push", value: device };
  if (account !== undefined && account !== device) return { kind: "apply", value: account };
  return { kind: "keep" };
}

function decideLanguage(input: ProfileSyncInput): FieldDecision<Lang> {
  const device = input.device.language;
  const account = input.account?.language;
  // A device without a language has not finished its start; nothing to say.
  if (device === null) {
    return account ? { kind: "apply", value: account } : { kind: "keep" };
  }
  if (input.synced === null) {
    if (account) return account === device ? { kind: "keep" } : { kind: "apply", value: account };
    return { kind: "push", value: device };
  }
  if (device !== input.synced.language) return { kind: "push", value: device };
  // The account never loses its language once it has one; `null` there is
  // only an account that has not been told yet.
  if (account === null) return { kind: "push", value: device };
  if (account !== undefined && account !== device) return { kind: "apply", value: account };
  return { kind: "keep" };
}

export function decideProfileSync(input: ProfileSyncInput): ProfileSyncDecision {
  return { city: decideCity(input), language: decideLanguage(input) };
}

export interface ProfileSyncDeps {
  accountId: string;
  /** The account's values as just read; `null` — only the device changed, nothing was read. */
  account: ProfileValues | null;
  device: () => ProfileValues;
  synced: { get(): ProfileSyncState | null; set(value: ProfileSyncState | null): void };
  /**
   * The city of an id from the server's list, to show on the device;
   * `{ kind: "all" }` — the list no longer has it (archived): the device
   * behaves as with any unknown city. `"unavailable"` — the list could not
   * be read; nothing is applied this time.
   */
  resolveCity: (cityId: string) => Promise<CitySelection | "unavailable">;
  setDeviceCity: (selection: CitySelection) => void;
  setDeviceLanguage: (lang: Lang) => void;
  /** `PATCH /account/profile`. */
  push: (patch: { cityId?: string | null; language?: Lang }) => Promise<void>;
}

/**
 * One pass of the rule above: what the account has comes to the device,
 * what the device has goes to the account. What was agreed is written
 * **before** the device's stores change — a device store that changes is
 * itself a reason to sync, and must then find nothing to send back.
 */
export async function runProfileSync(deps: ProfileSyncDeps): Promise<void> {
  const stored = deps.synced.get();
  const previous = stored?.accountId === deps.accountId ? stored : null;
  const device = deps.device();
  const decision = decideProfileSync({
    account: deps.account,
    device,
    synced: previous && { cityId: previous.cityId, language: previous.language },
  });

  let city: CitySelection | null = null;
  if (decision.city.kind === "apply") {
    const resolved =
      decision.city.value === null
        ? ({ kind: "all" } as const)
        : await deps.resolveCity(decision.city.value);
    if (resolved !== "unavailable") city = resolved;
  }
  const language = decision.language.kind === "apply" ? decision.language.value : null;

  const agreed: ProfileSyncState = {
    accountId: deps.accountId,
    cityId: city ? cityIdOf(city) : device.cityId,
    language: language ?? device.language,
  };
  deps.synced.set(agreed);
  if (city) deps.setDeviceCity(city);
  if (language) deps.setDeviceLanguage(language);

  const patch: { cityId?: string | null; language?: Lang } = {};
  if (decision.city.kind === "push") patch.cityId = decision.city.value;
  if (decision.language.kind === "push") patch.language = decision.language.value;
  if (Object.keys(patch).length === 0) return;
  try {
    await deps.push(patch);
  } catch (error) {
    // Not agreed after all: the next pass finds the device ahead again and
    // sends it then (or, on a first sign-in, starts over).
    deps.synced.set(
      previous && {
        ...agreed,
        ...("cityId" in patch ? { cityId: previous.cityId } : {}),
        ...("language" in patch ? { language: previous.language } : {}),
      },
    );
    throw error;
  }
}

function cityIdOf(selection: CitySelection): string | null {
  return selection.kind === "city" ? selection.id : null;
}

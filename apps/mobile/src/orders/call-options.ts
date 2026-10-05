/**
 * «Позвонить» on an order (SCREENS M-ORD-03 block 4; TASK-029.B,
 * ARCHITECTURE 4.46): the phone always, and WhatsApp / WhatsApp Business when
 * they are on the phone — then the sheet «Позвонить через…»; with neither,
 * the call starts at once, without a sheet.
 *
 * There is no public link that *calls* in WhatsApp: a row opens the chat
 * with the supplier's number (`whatsapp://send?phone=`), where the call is
 * one tap away. Every WhatsApp row also has the web of the same chat
 * (`https://wa.me/<number>`), so a press never leads nowhere.
 *
 * What the app can know about installed apps depends on where it runs:
 *
 * - **iOS, own build** — `canOpenURL` answers for the schemes the app
 *   declares (`LSApplicationQueriesSchemes` in `app.json`: `whatsapp`,
 *   `whatsapp-smb`): WhatsApp and WhatsApp Business apart;
 * - **Android, own build** — the `<queries>` of the manifest
 *   (`plugins/with-whatsapp-queries.js`) let `canOpenURL` see that *a*
 *   WhatsApp is there; both apps answer the same `whatsapp://` link, so the
 *   one row «WhatsApp» opens the system's own choice between them;
 * - **Expo Go** — the app cannot declare anything, so nothing can be known:
 *   one row «WhatsApp» is shown and opens the app if it is there, otherwise
 *   the web chat (`unknown` below);
 * - **the browser** (dev only) — no WhatsApp rows, the call goes straight.
 */

export type CallOptionId = "phone" | "whatsapp" | "whatsappBusiness";

export interface CallOption {
  id: CallOptionId;
  /** Opens the app (the dialer, the chat). */
  app: string;
  /** Where a press goes when the app refuses: the web chat; `null` — nowhere else (the dialer). */
  web: string | null;
}

/** Which WhatsApp apps the phone has; `unknown` — this environment cannot tell (Expo Go). */
export type WhatsappPresence = { whatsapp: boolean; business: boolean } | "unknown";

export type RunEnvironment = "own-build" | "expo-go" | "web";

/**
 * The number as WhatsApp links take it — international, digits only
 * (`77055550101`). A Kazakh number written the local way (`8 705…`, ten
 * digits) gets its `7`; anything that is not a full number gets no WhatsApp.
 */
export function whatsappNumber(phone: string | null): string | null {
  if (!phone) return null;
  const compact = phone.replace(/[\s()\-.]/g, "");
  if (/^\+\d{8,15}$/.test(compact)) return compact.slice(1);
  if (/^8\d{10}$/.test(compact)) return `7${compact.slice(1)}`;
  if (/^7\d{10}$/.test(compact)) return compact;
  if (/^\d{10}$/.test(compact)) return `7${compact}`;
  return null;
}

/** The dialer (SCREENS M-ORD-03 «Позвонить»); `null` — no phone. */
export function callUrl(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.length > 0 ? `tel:${digits}` : null;
}

/** The ways to call, in the order of the sheet; `[]` — no phone at all. */
export function callOptions(phone: string | null, presence: WhatsappPresence): CallOption[] {
  const tel = callUrl(phone);
  if (!tel) return [];
  const options: CallOption[] = [{ id: "phone", app: tel, web: null }];
  const number = whatsappNumber(phone);
  if (!number) return options;
  const web = `https://wa.me/${number}`;
  const known = presence === "unknown" ? { whatsapp: true, business: false } : presence;
  if (known.whatsapp) {
    options.push({ id: "whatsapp", app: `whatsapp://send?phone=${number}`, web });
  }
  if (known.business) {
    options.push({ id: "whatsappBusiness", app: `whatsapp-smb://send?phone=${number}`, web });
  }
  return options;
}

/**
 * Asks the system what is installed. `canOpen` is `Linking.canOpenURL`; a
 * check that throws (a scheme not declared) counts as «not there».
 */
export async function detectWhatsapp(
  environment: RunEnvironment,
  platform: "ios" | "android" | string,
  canOpen: (url: string) => Promise<boolean>,
): Promise<WhatsappPresence> {
  if (environment === "web") return { whatsapp: false, business: false };
  if (environment === "expo-go") return "unknown";
  const can = (url: string) => canOpen(url).catch(() => false);
  if (platform === "ios") {
    const [whatsapp, business] = await Promise.all([can("whatsapp://"), can("whatsapp-smb://")]);
    return { whatsapp, business };
  }
  // Both Android apps answer `whatsapp://`: one row, the system asks which.
  return { whatsapp: await can("whatsapp://send?phone=77000000000"), business: false };
}

/**
 * Opens an option: the app, and the web chat when the app is not there.
 * `false` — nothing opened.
 */
export async function openCallOption(
  option: CallOption,
  open: (url: string) => Promise<unknown>,
): Promise<boolean> {
  try {
    await open(option.app);
    return true;
  } catch {
    if (!option.web) return false;
    try {
      await open(option.web);
      return true;
    } catch {
      return false;
    }
  }
}

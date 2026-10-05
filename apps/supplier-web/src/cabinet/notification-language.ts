import type { NotificationLanguage } from "@adclub/contracts";
import type { Lang } from "@adclub/i18n";
import { apiClient } from "../api";
import { notificationLanguageSettled, settleNotificationLanguage } from "../prefs";

/**
 * SCREENS 6.0: the language of an employee's WhatsApp notifications is kk
 * or ru and, by default, the interface's — Russian for an English
 * interface. The server starts everyone with Russian (an invitation goes out
 * before the person ever opens the cabinet), so the only default left to
 * apply is Kazakh: once, at the first sign-in of this employee in this
 * browser. A language someone already chose is never overwritten later.
 */
export function defaultNotificationLanguage(
  interfaceLanguage: Lang,
  current: NotificationLanguage,
): NotificationLanguage | null {
  return interfaceLanguage === "kk" && current === "ru" ? "kk" : null;
}

export async function applyDefaultNotificationLanguage(interfaceLanguage: Lang): Promise<void> {
  try {
    const { member } = await apiClient.getSupplierMe();
    if (notificationLanguageSettled(member.id)) return;
    const wanted = defaultNotificationLanguage(interfaceLanguage, member.notificationLanguage);
    if (wanted) await apiClient.updateSupplierMe({ notificationLanguage: wanted });
    settleNotificationLanguage(member.id);
  } catch {
    // Not worth an error on screen: «Мои настройки» show and change it.
  }
}

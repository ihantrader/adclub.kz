import { formatMoment } from "../format";

/** The text of «Скачать как .txt»: the codes and how to use them, nothing else. */
export function backupCodesFile(codes: readonly string[], at: Date): string {
  return [
    "Asia Drive Club — резервные коды входа в админку",
    `Созданы: ${formatMoment(at.toISOString())} (время Алматы)`,
    "",
    "Каждый код действует один раз. Новые коды отменяют эти.",
    "",
    ...codes,
    "",
  ].join("\r\n");
}

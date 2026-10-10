import type { AdminSearchResponse } from "@adclub/contracts";
import { ORDER_STATUS_TEXT, moneyText } from "../orders/order-words";
import { catalogItemPath, orderPath, supplierLeadPath, supplierPath, userPath } from "../router";
import { LEAD_STATUS_TEXT } from "../suppliers/supplier-words";

/**
 * The header's search (TASK-036.B; SCREENS A-SEARCH) without React: the
 * server's groups as one list of entries the keyboard walks through, each
 * with where it opens. The server reads the line (a phone, «№ 4821», a БИН,
 * an article, a text); this only lays its answer out.
 */

export interface SearchEntry {
  key: string;
  group: string;
  label: string;
  note: string | null;
  href: string;
}

/** A moment after typing stops before the server is asked (the route is limited per administrator). */
export const HEADER_SEARCH_DEBOUNCE_MS = 300;

/** The line as the server takes it; `""` — nothing to ask. */
export function headerQuery(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 100);
}

/** The groups in the order the list shows them. */
export function searchEntries(answer: AdminSearchResponse): SearchEntry[] {
  return [
    ...answer.orders.map((order) => ({
      key: `order:${order.id}`,
      group: "Заявки",
      label: `№ ${order.number}`,
      note: `${ORDER_STATUS_TEXT[order.status]} · ${order.supplierName} · ${moneyText(order.total)}`,
      href: orderPath(order.id),
    })),
    ...answer.users.map((user) => ({
      key: `user:${user.accountId}`,
      group: "Пользователи",
      label: user.name ?? "Без имени",
      note: user.phone,
      href: userPath(user.accountId),
    })),
    ...answer.members.map((member) => ({
      key: `member:${member.memberId}`,
      group: "Сотрудники поставщиков",
      label: member.displayName,
      note: `${member.supplierName} · ${member.phone}${member.status === "removed" ? " · удалён" : ""}`,
      href: supplierPath(member.supplierId, "members"),
    })),
    ...answer.suppliers.map((supplier) => ({
      key: `supplier:${supplier.id}`,
      group: "Поставщики",
      label: supplier.name,
      note: [supplier.cityName, supplier.bin ? `БИН ${supplier.bin}` : null]
        .filter(Boolean)
        .join(" · "),
      href: supplierPath(supplier.id),
    })),
    ...answer.leads.map((lead) => ({
      key: `lead:${lead.id}`,
      group: "Заявки на подключение",
      label: lead.companyName,
      note: `БИН ${lead.bin} · ${LEAD_STATUS_TEXT[lead.status as keyof typeof LEAD_STATUS_TEXT] ?? lead.status}`,
      href: supplierLeadPath(lead.id),
    })),
    ...answer.items.map((item) => ({
      key: `item:${item.id}`,
      group: "Позиции справочника",
      label: item.name,
      note: [item.brand, item.article].filter(Boolean).join(" · ") || null,
      href: catalogItemPath(item.id),
    })),
  ];
}

/**
 * Where Enter goes when nothing was walked to: the only entry, or the order
 * whose number the line is («1028» — straight into the order).
 */
export function directEntry(
  answer: AdminSearchResponse,
  entries: readonly SearchEntry[],
): SearchEntry | null {
  if (entries.length === 1) return entries[0]!;
  const number = answer.reading.orderNumber;
  const order = number !== null ? answer.orders.find((row) => row.number === number) : undefined;
  return order ? (entries.find((entry) => entry.key === `order:${order.id}`) ?? null) : null;
}

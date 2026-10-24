import { JournalHistory } from "../audit/JournalHistory";
import { actionText } from "../audit/audit-words";
import { FilterSelect } from "../layout/filters";
import { useAddressFilters } from "./shared";

/** The kinds of entries a supplier's history has, for the filter (the server's action names). */
const ACTIONS = [
  "supplier.changed",
  "supplier.schedule_changed",
  "supplier.verification_changed",
  "supplier.pause_changed",
  "supplier.block_changed",
  "supplier_member.added",
  "supplier_member.removed",
  "supplier_member.restored",
  "supplier_member.changed",
  "supplier_member.contact_person_changed",
  "supplier_member.sessions_ended",
  "supplier_invitation.requested",
  "offer.created",
  "offer.changed",
  "offer.withdrawn",
  "offer.returned",
  "price_import.applied",
  "order.phone_revealed",
] as const;

/**
 * «История» of A-SUP-03 (TASK-036, TASK-080): the journal of the company, its
 * employees and everything its cabinet did, in the journal's rows (alike
 * entries in a row grouped — «Поставщику открыт телефон покупателя · 70
 * раз»), with a filter by the kind of entry in the address (`?action=`).
 */
export function SupplierHistory({ supplierId }: { supplierId: string }) {
  const { query, set } = useAddressFilters();
  const asked = query.get("action");
  const action = ACTIONS.find((entry) => entry === asked);
  return (
    <div className="list-block">
      <div className="filters">
        <FilterSelect<(typeof ACTIONS)[number]>
          label="Действие"
          value={action}
          options={ACTIONS.map((value) => ({ value, label: actionText(value) }))}
          onChange={(next) => set({ action: next })}
        />
      </div>
      <JournalHistory
        filter={{ supplierId, ...(action ? { action } : {}) }}
        loadKey={`supplier-history:${supplierId}:${action ?? ""}`}
        caption="История поставщика"
        empty={action ? "Таких записей нет" : "Изменений пока нет"}
      />
    </div>
  );
}

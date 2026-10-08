import { JournalHistory } from "../audit/JournalHistory";

/**
 * «История» of the card (A-CAT-05): the journal of the item — the item
 * itself and its translations, its photos and its compatibility
 * (`GET /admin/audit-log?itemId=`), newest first, in the journal's rows.
 */
export function ItemHistory({ itemId }: { itemId: string }) {
  return (
    <JournalHistory filter={{ itemId }} loadKey={`history:${itemId}`} caption="История позиции" />
  );
}

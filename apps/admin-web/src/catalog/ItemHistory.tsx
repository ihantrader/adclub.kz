import type { AuditLogEntry, AuditLogPage } from "@adclub/contracts";
import { Banner, Button, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { AuditRow } from "../audit/Audit";
import { loadErrorText } from "../errors";
import { CLUB_TIME_ZONE } from "../format";
import { useLoad } from "../use-load";

const PAGE = 50;

/**
 * «История» of the card (A-CAT-05): the journal of the item — the item
 * itself and its translations, its photos and its compatibility
 * (`GET /admin/audit-log?itemId=`), newest first, in the journal's rows.
 */
export function ItemHistory({ itemId }: { itemId: string }) {
  const request = (cursor?: string) =>
    apiClient.listAuditLog({ query: { itemId, limit: PAGE, cursor } });
  const first = useLoad<AuditLogPage>(() => request(), `history:${itemId}`);
  const [older, setOlder] = useState<{ entries: AuditLogEntry[]; next: string | null }>({
    entries: [],
    next: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const entries = [...(first.data?.entries ?? []), ...older.entries];
  const next = older.entries.length > 0 ? older.next : (first.data?.nextCursor ?? null);

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await request(next);
      setOlder({ entries: [...older.entries, ...page.entries], next: page.nextCursor });
    } catch (thrown) {
      setMoreError(loadErrorText(thrown));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="detail-stack">
      {first.error !== undefined && <Banner tone="danger">{loadErrorText(first.error)}</Banner>}
      <LoadingContent
        ready={first.data !== undefined}
        indicator={first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        {entries.length === 0 ? (
          <EmptyState icon="clock" title="Изменений пока нет" />
        ) : (
          <div className="table-wrap">
            <table className="admin-table audit-table">
              <caption className="ac-visually-hidden">
                История позиции, время — Алматы ({CLUB_TIME_ZONE})
              </caption>
              <thead>
                <tr>
                  <th scope="col">Время</th>
                  <th scope="col">Кто</th>
                  <th scope="col">Действие и объект</th>
                  <th scope="col">Было → стало</th>
                  <th scope="col">Причина</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <AuditRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {moreError && <Banner tone="danger">{moreError}</Banner>}
        {next && (
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
            Показать ещё
          </Button>
        )}
      </LoadingContent>
    </div>
  );
}

import type { AuditLogEntry, AuditLogPage, AuditLogQuery } from "@adclub/contracts";
import { Banner, Button, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { CLUB_TIME_ZONE } from "../format";
import { useLoad } from "../use-load";
import { AuditRow } from "./Audit";

const PAGE = 50;

export type JournalFilter = Omit<Partial<AuditLogQuery>, "limit" | "cursor">;

/**
 * «История» of a card — of a catalog item (A-CAT-05), of a supplier or a
 * connection request (A-SUP-01, A-SUP-03): the journal with the card's
 * filter, newest first, in the journal's rows, «Показать ещё» by the
 * server's cursor. `loadKey` names the filter (a new one loads again).
 */
export function JournalHistory({
  filter,
  loadKey,
  caption,
  empty = "Изменений пока нет",
}: {
  filter: JournalFilter;
  loadKey: string;
  caption: string;
  empty?: string;
}) {
  const request = (cursor?: string) =>
    apiClient.listAuditLog({ query: { ...filter, limit: PAGE, cursor } });
  const first = useLoad<AuditLogPage>(() => request(), loadKey);
  const [older, setOlder] = useState<{
    key: string;
    entries: AuditLogEntry[];
    next: string | null;
  }>({ key: loadKey, entries: [], next: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const extra = older.key === loadKey ? older : { key: loadKey, entries: [], next: null };
  const entries = [...(first.data?.entries ?? []), ...extra.entries];
  const next = extra.entries.length > 0 ? extra.next : (first.data?.nextCursor ?? null);

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await request(next);
      setOlder({
        key: loadKey,
        entries: [...extra.entries, ...page.entries],
        next: page.nextCursor,
      });
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
          <EmptyState icon="clock" title={empty} />
        ) : (
          <div className="table-wrap">
            <table className="admin-table audit-table">
              <caption className="ac-visually-hidden">
                {caption}, время — Алматы ({CLUB_TIME_ZONE})
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

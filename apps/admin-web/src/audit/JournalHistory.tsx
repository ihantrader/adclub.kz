import type { AuditLogEntry, AuditLogPage, AuditLogQuery } from "@adclub/contracts";
import { Banner, Button, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { useLoad } from "../use-load";
import { JournalTable } from "./JournalTable";

const PAGE = 50;

export type JournalFilter = Omit<Partial<AuditLogQuery>, "limit" | "cursor">;

/**
 * «История» of a card — of a catalog item (A-CAT-05), of a supplier or a
 * connection request (A-SUP-01, A-SUP-03), of a user or an order: the
 * journal with the card's filter, newest first, in the journal's rows
 * (TASK-080, X16: words, «Подробнее», alike entries grouped), «Показать
 * ещё» by the server's cursor. `loadKey` names the filter (a new one loads
 * again). The card's own object is not linked from its own rows.
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
  const selfId = filter.entityId ?? filter.itemId ?? filter.supplierId ?? filter.accountId;

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
    <div className="list-block">
      {first.error !== undefined && <Banner tone="danger">{loadErrorText(first.error)}</Banner>}
      <LoadingContent
        ready={first.data !== undefined}
        indicator={first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <div className="list-block">
          {entries.length === 0 ? (
            <EmptyState compact icon="history" title={empty} />
          ) : (
            <JournalTable entries={entries} caption={caption} selfId={selfId} />
          )}
          {moreError && <Banner tone="danger">{moreError}</Banner>}
          {next && (
            <Button variant="secondary" size="s" onClick={loadMore} loading={loadingMore}>
              Показать ещё
            </Button>
          )}
        </div>
      </LoadingContent>
    </div>
  );
}

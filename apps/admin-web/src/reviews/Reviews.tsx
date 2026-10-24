import {
  reviewStatusSchema,
  type AdminReview,
  type AdminReviewPage,
  type ReviewStatusValue,
} from "@adclub/contracts";
import {
  Button,
  EmptyState,
  IconButton,
  LoadingContent,
  SearchSelect,
  SkeletonList,
  TableToolbar,
} from "@adclub/ui";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { FilterSearch, StatusChips } from "../layout/filters";
import { Header } from "../layout/layout";
import { useSupplierChoice } from "../orders/Orders";
import { routePaths } from "../router";
import { createChoiceSources } from "../search-select/sources";
import { useAddressFilters } from "../suppliers/shared";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";
import { ReviewRows } from "./ReviewList";
import { REVIEW_TABS } from "./review-words";
import "./reviews.css";

const supplierSearch = createChoiceSources(apiClient).suppliers();

type SectionTab = "reviews" | "complaints";

/** The head of «Отзывы и жалобы»: the section's name, its two pages as tabs (X11), «Обновить». */
export function ReviewSectionHeader({
  active,
  onRefresh,
}: {
  active: SectionTab;
  onRefresh: () => void;
}) {
  return (
    <Header<SectionTab>
      title="Отзывы и жалобы"
      actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={onRefresh} />}
      tabs={{
        label: "Отзывы и жалобы",
        active,
        items: [
          { key: "reviews", label: "Отзывы", href: routePaths.reviews },
          { key: "complaints", label: "Жалобы", href: routePaths.complaints },
        ],
      }}
    />
  );
}

function statusOf(value: string | null): ReviewStatusValue {
  const parsed = reviewStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "held";
}

/** A list of reviews with the decisions on them, by the filters given (offset pages). */
export function useReviewList(filter: {
  status?: ReviewStatusValue;
  supplierId?: string;
  orderId?: string;
  q?: string;
}) {
  const [edited, setEdited] = useState<Record<string, AdminReview>>({});
  const [counts, setCounts] = useState<AdminReviewPage["counts"] | null>(null);
  const list = usePaged<AdminReview>(async (cursor) => {
    const page: AdminReviewPage = await apiClient.listAdminReviews({
      query: { ...filter, limit: 30, offset: cursor ? Number(cursor) : 0 },
    });
    setCounts(page.counts);
    return {
      items: page.reviews,
      total: page.total,
      nextCursor: page.nextOffset === null ? null : String(page.nextOffset),
    };
  }, JSON.stringify(filter));
  return {
    list,
    counts,
    rows: list.items.map((review) => edited[review.id] ?? review),
    changed: (review: AdminReview) => setEdited((now) => ({ ...now, [review.id]: review })),
  };
}

/**
 * A-REV-01 «Отзывы» (SCREENS 7.7; TASK-049, TASK-080): the status as chips
 * with the server's counts — «На проверке» (the queue, oldest first; a text
 * that waited longer than the threshold is here already), «Опубликованные»,
 * «Скрытые», «Отклонённые» and those still being checked — the words of the
 * text and the supplier in one row, all in the address; the decisions in the
 * rows, «Опубликовать» primary only in the queue.
 */
export function Reviews() {
  const { query, set } = useAddressFilters();
  const status = statusOf(query.get("status"));
  const supplierId = query.get("supplierId") ?? undefined;
  const q = query.get("q")?.trim() || undefined;
  const { list, rows, changed, counts } = useReviewList({ status, supplierId, q });
  const supplier = useSupplierChoice(supplierId ?? null, rows);
  const [search, setSearch] = useState(q ?? "");
  const filtered = q !== undefined || supplierId !== undefined;

  // The words go to the address a moment after typing stops.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === (q ?? "")) return;
    const timer = setTimeout(() => set({ q: trimmed || undefined }), 350);
    return () => clearTimeout(timer);
  });

  const reset = () => {
    setSearch("");
    set({ q: undefined, supplierId: undefined });
  };

  return (
    <>
      <ReviewSectionHeader active="reviews" onRefresh={list.first.reload} />
      <div className="filters__group review-filters">
        <div className="filters">
          <FilterSearch
            label="Слова из текста отзыва"
            placeholder="Слова из текста отзыва"
            value={search}
            onChange={setSearch}
            onSubmit={() => set({ q: search.trim() || undefined })}
          />
          <SearchSelect
            compact
            label="Поставщик"
            value={supplier.value}
            onChange={(choice) => {
              supplier.remember(choice);
              set({ supplierId: choice?.id });
            }}
            search={supplierSearch}
            empty="Все"
          />
        </div>
        <StatusChips<ReviewStatusValue>
          label="Состояние отзыва"
          value={status}
          allLabel={null}
          chips={REVIEW_TABS.map((tab) => ({
            value: tab.status,
            label: tab.label,
            count: counts ? counts[tab.status] : null,
          }))}
          onChange={(next) => set({ status: next === "held" ? undefined : next })}
        />
      </div>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <div className="list-block">
          <TableToolbar total={rows.length === 0 ? null : list.total}>
            {filtered && (
              <Button variant="text" size="s" onClick={reset}>
                Сбросить фильтры
              </Button>
            )}
          </TableToolbar>
          {rows.length === 0 ? (
            filtered ? (
              <EmptyState
                icon="search"
                title="Ничего не нашлось"
                text="Измените слова или поставщика"
                action={
                  <Button variant="secondary" onClick={reset}>
                    Сбросить фильтры
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon="star"
                title={status === "held" ? "Очередь пуста" : "Отзывов нет"}
                text={
                  status === "held"
                    ? "Отзывы, которые проверка задержала или не смогла проверить вовремя, появятся здесь."
                    : "Здесь появятся отзывы в этом состоянии."
                }
              />
            )
          ) : (
            <ReviewRows reviews={rows} onChanged={changed} queue={status === "held"} />
          )}
          <MoreButton list={list} />
        </div>
      </LoadingContent>
    </>
  );
}

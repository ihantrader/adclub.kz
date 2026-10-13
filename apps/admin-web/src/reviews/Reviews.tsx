import {
  reviewStatusSchema,
  type AdminReview,
  type AdminReviewPage,
  type ReviewStatusValue,
} from "@adclub/contracts";
import { EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { follow } from "../catalog/shared";
import { useSupplierChoice } from "../orders/Orders";
import { routePaths, withQuery } from "../router";
import { SearchSelect } from "../search-select/SearchSelect";
import { createChoiceSources } from "../search-select/sources";
import { SearchBox, useAddressFilters } from "../suppliers/shared";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";
import { ReviewRows } from "./ReviewList";
import { REVIEW_TABS } from "./review-words";

const supplierSearch = createChoiceSources(apiClient).suppliers();

const SECTION_TABS = [
  { key: "reviews", label: "Отзывы", href: routePaths.reviews },
  { key: "complaints", label: "Жалобы", href: routePaths.complaints },
] as const;

/** «Отзывы» and «Жалобы» of the section (SCREENS 7.7). */
export function ReviewSectionTabs({ active }: { active: "reviews" | "complaints" }) {
  return (
    <nav className="page-tabs" aria-label="Отзывы и жалобы">
      {SECTION_TABS.map((tab) => (
        <a
          key={tab.key}
          href={tab.href}
          className={tab.key === active ? "page-tabs__tab page-tabs__tab--on" : "page-tabs__tab"}
          aria-current={tab.key === active ? "page" : undefined}
          onClick={(event) => follow(event, tab.href)}
        >
          {tab.label}
        </a>
      ))}
    </nav>
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
 * A-REV-01 «Отзывы» (SCREENS 7.7; TASK-049): tabs by status — «На проверке»
 * (the queue, oldest first; a text that waited longer than the threshold is
 * here already), «Опубликованные», «Скрытые», «Отклонённые» and those still
 * being checked — the filters by supplier and a part of the text in the
 * address, and the decisions in the rows.
 */
export function Reviews() {
  const { query, set } = useAddressFilters();
  const status = statusOf(query.get("status"));
  const supplierId = query.get("supplierId") ?? undefined;
  const q = query.get("q")?.trim() || undefined;
  const { list, rows, changed, counts } = useReviewList({ status, supplierId, q });
  const supplier = useSupplierChoice(supplierId ?? null, rows);

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Отзывы и жалобы</h1>
      </div>
      <ReviewSectionTabs active="reviews" />
      <nav className="page-tabs page-tabs--inner" aria-label="Состояние отзыва">
        {REVIEW_TABS.map((tab) => {
          const href = withQuery(routePaths.reviews, {
            status: tab.status === "held" ? undefined : tab.status,
            supplierId,
            q,
          });
          return (
            <a
              key={tab.status}
              href={href}
              className={
                tab.status === status ? "page-tabs__tab page-tabs__tab--on" : "page-tabs__tab"
              }
              aria-current={tab.status === status ? "page" : undefined}
              onClick={(event) => follow(event, href)}
            >
              {tab.label}
              {counts ? ` · ${counts[tab.status].toLocaleString("ru-RU")}` : ""}
            </a>
          );
        })}
      </nav>
      <div className="filters filters--grid">
        <SearchBox label="Слова из текста отзыва" />
        <div className="filters__select-search">
          <SearchSelect
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
      </div>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted">Всего: {list.total.toLocaleString("ru-RU")}</p>
        {rows.length === 0 ? (
          <EmptyState
            icon="star"
            title={status === "held" ? "Очередь пуста" : "Отзывов нет"}
            text={
              status === "held"
                ? "Отзывы, которые проверка задержала или не смогла проверить вовремя, появятся здесь."
                : "Измените отборы"
            }
          />
        ) : (
          <ReviewRows reviews={rows} onChanged={changed} />
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </>
  );
}

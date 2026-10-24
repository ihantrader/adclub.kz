import type { PriceImport } from "@adclub/contracts";
import { Badge, Button, EmptyState, LoadingContent, SkeletonList, StatusBadge } from "@adclub/ui";
import { Fragment, useState } from "react";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { Muted, Table } from "../layout/layout";
import { LoadError, usePaged } from "../vehicles/shared";
import { MoreButton } from "./shared";
import {
  priceImportFailureText,
  priceImportFacts,
  priceImportTypeText,
  PRICE_IMPORT_STATUS_TEXT,
} from "./supplier-words";

const COLUMNS = [
  { key: "file", header: "Файл" },
  { key: "at", header: "Загружен", width: 150 },
  { key: "state", header: "Состояние", width: 230 },
  { key: "rows", header: "С товарами", width: 120, numeric: true },
  { key: "errors", header: "С ошибками", width: 120, numeric: true },
  { key: "actions", header: "Подробнее", width: 140, actions: true, hiddenHeader: true },
];

/**
 * «Прайс» of A-SUP-03 (TASK-046, TASK-080): the company's price list uploads,
 * newest first, 20 at a time — the file and its type by its content (as
 * the server read it, the same for the cabinet), who uploaded it and when,
 * the state with the reason of a refusal, the rows of goods and those with
 * errors in two numeric columns. Only to look at: the admin panel has no
 * page of one upload, so «Подробнее» opens what the server knows of it in
 * place; the file itself is the supplier's and is not handed out.
 */
export function SupplierPriceImports({ supplierId }: { supplierId: string }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const list = usePaged<PriceImport>(async (cursor) => {
    const page = await apiClient.listAdminSupplierPriceImports(
      { supplierId },
      { query: { limit: 20, ...(cursor ? { cursor } : {}) } },
    );
    return { items: page.imports, total: page.imports.length, nextCursor: page.nextCursor };
  }, `price-imports:${supplierId}`);
  const toggle = (id: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="list-block">
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        <div className="list-block">
          {list.items.length === 0 ? (
            <EmptyState compact icon="fileSpreadsheet" title="Прайс ещё не загружали" />
          ) : (
            <Table label="Загрузки прайса" columns={COLUMNS}>
              {list.items.map((entry) => {
                const shown = open.has(entry.id);
                const errors = entry.stats?.errorRows ?? null;
                return (
                  <Fragment key={entry.id}>
                    <tr className={shown ? "price-row price-row--open" : "price-row"}>
                      <td>
                        <span className="cell-stack">
                          <span
                            className="ac-text-body-strong cell-one-line"
                            title={entry.fileName ?? undefined}
                          >
                            {entry.fileName ?? "Без имени"}
                          </span>
                          <span className="row-title__sub">
                            {priceImportTypeText(entry)} · {entry.uploadedBy.name ?? "сотрудник"}
                          </span>
                        </span>
                      </td>
                      <td className="ac-text-body-s nowrap">{formatMoment(entry.createdAt)}</td>
                      <td>
                        <span className="cell-stack">
                          <span className="badges">
                            <StatusBadge kind="priceImport" status={entry.status}>
                              {PRICE_IMPORT_STATUS_TEXT[entry.status]}
                            </StatusBadge>
                          </span>
                          {entry.failure && (
                            <span className="row-title__sub">
                              {priceImportFailureText(entry.failure)}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="num">
                        {entry.stats ? (
                          entry.stats.dataRows.toLocaleString("ru-RU")
                        ) : (
                          <Muted>—</Muted>
                        )}
                      </td>
                      <td className="num">
                        {errors === null ? (
                          <Muted>—</Muted>
                        ) : errors > 0 ? (
                          <Badge tone="warning" icon="alertTriangle">
                            {errors.toLocaleString("ru-RU")}
                          </Badge>
                        ) : (
                          "0"
                        )}
                      </td>
                      <td className="admin-table__actions">
                        <Button
                          variant="text"
                          size="s"
                          aria-expanded={shown}
                          onClick={() => toggle(entry.id)}
                        >
                          {shown ? "Свернуть" : "Подробнее"}
                        </Button>
                      </td>
                    </tr>
                    {shown && (
                      <tr className="price-detail">
                        <td colSpan={COLUMNS.length}>
                          <dl className="kv supplier-kv">
                            {priceImportFacts(entry, formatMoment).map((fact) => (
                              <Fragment key={fact.label}>
                                <dt>{fact.label}</dt>
                                <dd>{fact.value}</dd>
                              </Fragment>
                            ))}
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </Table>
          )}
          <MoreButton list={list} />
        </div>
      </LoadingContent>
    </div>
  );
}

import type { PriceImport } from "@adclub/contracts";
import { EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";
import {
  priceImportFailureText,
  PRICE_IMPORT_STATUS_TEXT,
  priceImportNumbers,
} from "./supplier-words";

const STATUS_CLASS: Record<PriceImport["status"], string> = {
  parsing: "acknowledged",
  columns: "open",
  reading: "acknowledged",
  parsed: "acknowledged",
  matching: "acknowledged",
  review: "open",
  applying: "acknowledged",
  applied: "done",
  failed: "danger",
  expired: "danger",
};

/**
 * «Прайс» of A-SUP-03 (TASK-046): the company's price list uploads, newest
 * first — the file, who uploaded it and when, the state, the rows and the
 * errors in rows. Only to look at: the file itself is the supplier's and is
 * not handed out (the administrator has no link to it).
 */
export function SupplierPriceImports({ supplierId }: { supplierId: string }) {
  const list = usePaged<PriceImport>(async (cursor) => {
    const page = await apiClient.listAdminSupplierPriceImports(
      { supplierId },
      { query: { limit: 50, ...(cursor ? { cursor } : {}) } },
    );
    return { items: page.imports, total: page.imports.length, nextCursor: page.nextCursor };
  }, `price-imports:${supplierId}`);
  return (
    <div className="detail-stack">
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {list.items.length === 0 ? (
          <EmptyState icon="fileSpreadsheet" title="Прайс ещё не загружали" />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Файл</th>
                  <th scope="col">Загрузил</th>
                  <th scope="col">Состояние</th>
                  <th scope="col">Строки</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div className="cell-stack">
                        <span>{entry.fileName ?? "Без имени"}</span>
                        <span className="ac-text-caption ac-muted">
                          {entry.format === "xlsx" ? "Excel" : "CSV"}
                          {entry.fileKept ? "" : " · файл удалён по сроку хранения"}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="cell-stack ac-text-body-s">
                        <span>{entry.uploadedBy.name ?? "—"}</span>
                        <span className="ac-text-caption ac-muted">
                          {formatMoment(entry.createdAt)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="cell-stack">
                        <span className={`status status--${STATUS_CLASS[entry.status]}`}>
                          {PRICE_IMPORT_STATUS_TEXT[entry.status]}
                        </span>
                        {entry.failure && (
                          <span className="ac-text-caption ac-muted">
                            {priceImportFailureText(entry.failure)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="ac-text-body-s">{priceImportNumbers(entry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </div>
  );
}

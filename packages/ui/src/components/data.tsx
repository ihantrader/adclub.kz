import { createQrMatrix, formatOrderCode, HIDDEN_ORDER_CODE, qr, qrPath } from "@adclub/ui-core";
import { useMemo, type ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";

export interface TableColumn<K extends string> {
  key: K;
  header: ReactNode;
  /** Column recognized automatically: caption "определено автоматически" (7.9). */
  autoDetectedLabel?: string;
  /** Right-aligned tabular figures (prices, quantities). */
  numeric?: boolean;
}

export interface TableCell {
  value: ReactNode;
  /** AI-proposed value awaiting confirmation: `aiTint` + sparkles (7.9). */
  ai?: boolean;
  /** Needs attention (e.g. sharp price change): `warningTint` + icon. */
  warning?: boolean;
}

export interface TableRow<K extends string> {
  id: string;
  cells: Record<K, TableCell | ReactNode>;
}

function isCell(value: unknown): value is TableCell {
  return typeof value === "object" && value !== null && "value" in value;
}

export interface DataTableProps<K extends string> {
  caption: string;
  columns: readonly TableColumn<K>[];
  rows: readonly TableRow<K>[];
}

/** Cabinet/admin table: rows 48, AI and warning cells (DESIGN.md 7.5, 7.9). */
export function DataTable<K extends string>({ caption, columns, rows }: DataTableProps<K>) {
  return (
    <div className="ac-table-wrap">
      <table className="ac-table">
        <caption className="ac-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(column.numeric && "ac-table__numeric")}
              >
                {column.header}
                {column.autoDetectedLabel && (
                  <span className="ac-table__auto">{column.autoDetectedLabel}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column) => {
                const raw = row.cells[column.key];
                const cell: TableCell = isCell(raw) ? raw : { value: raw as ReactNode };
                return (
                  <td
                    key={column.key}
                    className={cx(
                      column.numeric && "ac-table__numeric",
                      cell.ai && "ac-table__cell--ai",
                      cell.warning && "ac-table__cell--warning",
                    )}
                  >
                    <span className="ac-table__cell">
                      {cell.ai && <Icon name="sparkles" size={16} className="ac-table__ai-icon" />}
                      {cell.warning && (
                        <Icon name="alertTriangle" size={16} className="ac-table__warning-icon" />
                      )}
                      <span>{cell.value}</span>
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface QrCodeProps {
  value: string;
  /** Rendered side in px, quiet zone included. */
  size: number;
  label: string;
}

/** QR at level M with a 4-module quiet zone, always black on white (DESIGN.md 7.10). */
export function QrCode({ value, size, label }: QrCodeProps) {
  const { d, viewBoxSize } = useMemo(() => qrPath(createQrMatrix(value)), [value]);
  return (
    <svg
      className="ac-qr"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      shapeRendering="crispEdges"
    >
      <rect width={viewBoxSize} height={viewBoxSize} fill="#FFFFFF" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

export interface CodeBlockProps {
  /** Six digits. */
  code: string;
  /** QR content (defined by the order-code contract). */
  qrValue: string;
  /**
   * Before acceptance: code and QR at 30 % with an explanation on top; the
   * code is hidden ("••• •••") and the QR is a placeholder that encodes nothing.
   */
  pending?: { text: ReactNode };
  /** "Можно забирать": bigger QR. */
  ready?: boolean;
  codeLabel: string;
  qrLabel: string;
}

/** Stand-in pattern shown dimmed before acceptance: the real QR is not rendered yet. */
const PENDING_QR_VALUE = "adclub:pending";

/** Order code block (M-ORD-03 on the phone; reused where suppliers see a code). */
export function CodeBlock({ code, qrValue, pending, ready, codeLabel, qrLabel }: CodeBlockProps) {
  // The white square (176, or 208 when ready) includes its 12 px padding.
  const qrSide = (ready ? qr.cardReady : qr.card) - 2 * qr.padding;
  return (
    <section className={cx("ac-code-block", pending && "ac-code-block--pending")}>
      <div className="ac-code-block__content" aria-hidden={pending ? true : undefined}>
        <div className="ac-code-block__qr">
          <QrCode value={pending ? PENDING_QR_VALUE : qrValue} size={qrSide} label={qrLabel} />
        </div>
        <div>
          <div className="ac-text-caption ac-muted">{codeLabel}</div>
          <div className="ac-text-code">{pending ? HIDDEN_ORDER_CODE : formatOrderCode(code)}</div>
        </div>
      </div>
      {pending && (
        <div className="ac-code-block__overlay ac-text-body-s">
          <span>{pending.text}</span>
        </div>
      )}
    </section>
  );
}

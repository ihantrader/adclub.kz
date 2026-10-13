import { createHmac, timingSafeEqual } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CatalogLanguage, CreatePriceExportBody, PriceExportLink } from "@adclub/contracts";
import {
  priceExportHeader,
  priceExportHint,
  priceExportRoles,
  priceExportRow,
  priceHeaderKey,
  type PriceExportOffer,
} from "@adclub/domain";
import { sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { streamXlsx, type XlsxCell } from "./file/xlsx-stream";
import { headerHash } from "./schema";

/** Where the file is downloaded: outside the client contract (a file, not JSON). */
export const PRICE_EXPORT_DOWNLOAD_PATH = "/supplier-files/price-export";

/** How long a link works: enough to start the download, too short to pass around. */
const LINK_SECONDS = 120;
/** Offers read from the database at a time while the file is written. */
const BATCH = 1000;
/** Widths of the columns of the sheet, in characters. */
const WIDTHS = [38, 18, 16, 50, 12, 16, 12, 12, 12, 18];

type Include = CreatePriceExportBody["include"];

interface ExportClaim {
  supplierId: string;
  memberId: string;
  include: Include;
  lang: CatalogLanguage;
  expiresAt: number;
}

interface OfferRow extends Record<string, unknown> {
  id: string;
  item_id: string;
  supplier_sku: string | null;
  supplier_raw_name: string | null;
  price: number;
  availability: "in_stock" | "on_order";
  lead_days: number;
  status: "active" | "withdrawn" | "suspended";
  pickup: boolean;
  delivery: boolean;
  warranty_months: number | null;
  warranty_text: string | null;
  article: string | null;
  brand: string | null;
  name: string | null;
}

function expired(): ApiException {
  return new ApiException(
    410,
    "GONE",
    "The link has expired: press «Скачать мой прайс» again in the cabinet",
  );
}

/**
 * «Скачать мой прайс» (S-PRICE-01, TASK-048; ARCHITECTURE 12.4, 4.68).
 *
 * The cabinet asks for a link (`POST /supplier/price-exports`, limited per
 * employee) and opens it; the browser downloads the file as an ordinary
 * download — the access token never goes into an address, the link carries
 * a token signed by the server for this employee, this company and two
 * minutes. The file is written while it goes out: offers are read a
 * thousand at a time and each batch is sent before the next is read.
 *
 * Only the company's own offers on parts and goods (services have prices
 * by model) — on sale, or all of them; never another company's, never the
 * catalog. The hidden first column is the item of each offer: the same file
 * uploaded back is matched by it without the search and AI. Asking for the
 * link also remembers the export's columns as the company's format, so the
 * file coming back skips the screen of columns.
 */
@Injectable()
export class PriceExportService {
  private readonly logger = new Logger("PriceImports");
  private readonly key: Buffer;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.key = createHmac("sha256", config.session.tokenSecret)
      .update("adclub.kz price export v1")
      .digest();
  }

  async link(
    actor: { supplierId: string; memberId: string },
    body: CreatePriceExportBody,
    lang: CatalogLanguage,
  ): Promise<PriceExportLink> {
    const db = this.database.db;
    const header = priceExportHeader(lang);
    const headerKey = priceHeaderKey(header);
    await db.execute(sql`
      INSERT INTO price_import_format (supplier_id, header_key, header_hash, roles, remembered_by_member_id)
      VALUES (${actor.supplierId}, ${headerKey}, ${headerHash(headerKey)},
        ${JSON.stringify(priceExportRoles())}::jsonb, ${actor.memberId})
      ON CONFLICT (supplier_id, header_hash) DO UPDATE SET
        header_key = excluded.header_key, roles = excluded.roles,
        remembered_by_member_id = excluded.remembered_by_member_id, updated_at = now()`);
    const counted = await db.execute<{ offers: number }>(sql`
      SELECT count(*)::int AS offers FROM offer
      WHERE supplier_id = ${actor.supplierId} AND item_type <> 'service'
        ${body.include === "on_sale" ? sql`AND status = 'active'` : sql``}`);
    const expiresAt = Date.now() + LINK_SECONDS * 1000;
    // Only what the download needs: the company, the employee, the choice, the language.
    const token = this.sign({
      supplierId: actor.supplierId,
      memberId: actor.memberId,
      include: body.include,
      lang,
      expiresAt,
    });
    return {
      url: `${PRICE_EXPORT_DOWNLOAD_PATH}?token=${encodeURIComponent(token)}`,
      fileName: this.fileName(),
      expiresAt: new Date(expiresAt).toISOString(),
      offers: counted.rows[0]?.offers ?? 0,
    };
  }

  /** The claim of a link; a forged, foreign or old one — 410, and nothing is said about why. */
  verify(token: string | undefined): ExportClaim {
    if (!token) throw expired();
    const [payload, signature] = token.split(".");
    if (!payload || !signature) throw expired();
    const expected = createHmac("sha256", this.key).update(payload).digest();
    const given = Buffer.from(signature, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw expired();
    let claim: ExportClaim;
    try {
      claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ExportClaim;
    } catch {
      throw expired();
    }
    if (typeof claim.expiresAt !== "number" || claim.expiresAt < Date.now()) throw expired();
    return claim;
  }

  /** Whether the employee of the link still works in the company: a removed one downloads nothing. */
  async memberActive(claim: ExportClaim): Promise<boolean> {
    const rows = await this.database.db.execute<{ id: string }>(sql`
      SELECT id FROM supplier_member
      WHERE id = ${claim.memberId} AND supplier_id = ${claim.supplierId} AND status = 'active'`);
    return rows.rows.length > 0;
  }

  /** Writes the workbook to `write` as it is read; resolves with the number of offers. */
  async write(
    claim: ExportClaim,
    write: (chunk: Uint8Array) => Promise<void> | void,
  ): Promise<number> {
    const empty = !(await this.hasOffers(claim));
    const hint = priceExportHint(claim.lang, empty);
    const startedAt = Date.now();
    const { rows } = await streamXlsx({
      sheet: { name: hint.title, widths: WIDTHS, hidden: [0] },
      header: priceExportHeader(claim.lang),
      rows: this.batches(claim),
      second: { name: hint.sheet, lines: hint.lines },
      write,
    });
    this.logger.log(
      `Price list exported supplier=${claim.supplierId} member=${claim.memberId} offers=${String(rows)} durationMs=${String(Date.now() - startedAt)}`,
    );
    return rows;
  }

  fileName(): string {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Almaty",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    return `price-list-${day}.xlsx`;
  }

  private async hasOffers(claim: ExportClaim): Promise<boolean> {
    const rows = await this.database.db.execute<{ id: string }>(sql`
      SELECT id FROM offer WHERE supplier_id = ${claim.supplierId} AND item_type <> 'service'
        ${claim.include === "on_sale" ? sql`AND status = 'active'` : sql``}
      LIMIT 1`);
    return rows.rows.length > 0;
  }

  /** The company's offers a thousand at a time, by id; each batch as the cells of its rows. */
  private async *batches(claim: ExportClaim): AsyncGenerator<XlsxCell[][]> {
    let after: string | null = null;
    for (;;) {
      const page: { rows: OfferRow[] } = await this.database.db.execute<OfferRow>(sql`
        SELECT o.id, o.item_id, o.supplier_sku, o.supplier_raw_name, o.price, o.availability,
          o.lead_days, o.status, o.pickup, o.delivery, o.warranty_months, o.warranty_text,
          i.article,
          (SELECT b.text FROM brand_spelling b WHERE b.brand_id = i.brand_id AND b.is_name) AS brand,
          (SELECT t.text FROM translation t WHERE t.entity_type = 'catalog_item'
             AND t.entity_id = i.id AND t.field = 'name' AND t.lang = 'ru') AS name
        FROM offer o JOIN catalog_item i ON i.id = o.item_id
        WHERE o.supplier_id = ${claim.supplierId} AND o.item_type <> 'service'
          ${claim.include === "on_sale" ? sql`AND o.status = 'active'` : sql``}
          ${after ? sql`AND o.id > ${after}::uuid` : sql``}
        ORDER BY o.id
        LIMIT ${BATCH}`);
      if (page.rows.length === 0) return;
      yield page.rows.map((row) => priceExportRow(this.offerOf(row), claim.lang));
      if (page.rows.length < BATCH) return;
      after = page.rows.at(-1)!.id;
    }
  }

  private offerOf(row: OfferRow): PriceExportOffer {
    return {
      itemId: row.item_id,
      supplierSku: row.supplier_sku,
      catalogArticle: row.article,
      brand: row.brand,
      supplierName: row.supplier_raw_name,
      // Russian, the catalog's own language: a file returned unchanged changes nothing.
      catalogName: row.name ?? "",
      price: row.price,
      availability: row.availability,
      leadDays: row.lead_days,
      status: row.status,
      pickup: row.pickup,
      delivery: row.delivery,
      warrantyMonths: row.warranty_months,
      warrantyText: row.warranty_text,
    };
  }

  private sign(claim: ExportClaim): string {
    const payload = Buffer.from(JSON.stringify(claim), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.key).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }
}

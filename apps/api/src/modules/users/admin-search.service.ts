import { Inject, Injectable } from "@nestjs/common";
import {
  ADMIN_SEARCH_GROUP_LIMIT,
  type AdminSearchResponse,
  type OrderStatusValue,
} from "@adclub/contracts";
import { hidePhone, readAdminQuery } from "@adclub/domain";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { CatalogItemsService } from "../catalog";
import { account, supplier, supplierMember } from "../identity";
import { SupplierLeadsService, SuppliersService } from "../suppliers";
import { appUserCondition, likeEscaped, userSearchCondition } from "./admin-users.service";

const LIMIT = ADMIN_SEARCH_GROUP_LIMIT;

/**
 * The one search line of the admin panel's header (TASK-036.B; SCREENS 7.0
 * A-SEARCH). The line is read once (`readAdminQuery`, `@adclub/domain`) and
 * every reading that fits is looked up — «1028» is both the number of an
 * order and a part of a phone:
 *
 * - a phone → users of the app and employees of suppliers (numbers partly
 *   hidden in the answer, matched against the full number here);
 * - a number of an order → the order;
 * - a БИН → the supplier and the connection requests of that БИН;
 * - an article → items of the catalog;
 * - a text → suppliers and items by name, users and employees by name.
 *
 * Suppliers, requests and items are found by their modules' own list rules
 * (the very search of their sections), users by the rule of the list of
 * users. At most `ADMIN_SEARCH_GROUP_LIMIT` of each kind.
 */
@Injectable()
export class AdminSearch {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SuppliersService) private readonly suppliers: SuppliersService,
    @Inject(SupplierLeadsService) private readonly leads: SupplierLeadsService,
    @Inject(CatalogItemsService) private readonly items: CatalogItemsService,
  ) {}

  async search(q: string): Promise<AdminSearchResponse> {
    const reading = readAdminQuery(q);
    const line = q.trim();
    const [orders, users, members, suppliers, leads, items] = await Promise.all([
      this.ordersOf(reading.orderNumber, reading.phoneDigits),
      reading.phoneDigits || reading.text ? this.usersOf(line) : Promise.resolve([]),
      reading.phoneDigits || reading.text ? this.membersOf(reading.phoneDigits, reading.text) : [],
      reading.bin || reading.text ? this.suppliersOf(reading.bin ?? reading.text!) : [],
      reading.bin || reading.text ? this.leadsOf(reading.bin, reading.text) : [],
      reading.article || reading.text ? this.itemsOf(line) : [],
    ]);
    return {
      reading: {
        phoneDigits: reading.phoneDigits?.at(-1) ?? null,
        orderNumber: reading.orderNumber,
        bin: reading.bin,
        article: reading.article,
        text: reading.text,
      },
      orders,
      users,
      members,
      suppliers,
      leads,
      items,
    };
  }

  private async ordersOf(
    number: number | null,
    phoneDigits: string[] | null,
  ): Promise<AdminSearchResponse["orders"]> {
    const found: SQL[] = [];
    if (number !== null) {
      found.push(sql`purchase.number = ${number}`);
    }
    for (const digits of phoneDigits ?? []) {
      found.push(sql`customer.phone LIKE ${`%${digits}%`}`);
    }
    if (found.length === 0) {
      return [];
    }
    const result = await this.database.db.execute<{
      id: string;
      number: number;
      status: OrderStatusValue;
      supplier_name: string;
      total: number;
      created_at: Date;
    }>(sql`SELECT purchase.id, purchase.number, purchase.status, company.name AS supplier_name,
        purchase.total, purchase.created_at
      FROM customer_order AS purchase
      JOIN account AS customer ON customer.id = purchase.user_account_id
      JOIN supplier AS company ON company.id = purchase.supplier_id
      WHERE ${sql.join(found, sql` OR `)}
      ORDER BY (purchase.number = ${number ?? -1}) DESC, purchase.created_at DESC, purchase.id DESC
      LIMIT ${LIMIT}`);
    return result.rows.map((row) => ({
      id: row.id,
      number: Number(row.number),
      status: row.status,
      supplierName: row.supplier_name,
      total: Number(row.total),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  private async usersOf(line: string): Promise<AdminSearchResponse["users"]> {
    const rows = await this.database.db
      .select({ id: account.id, name: account.name, phone: account.phone })
      .from(account)
      .where(and(appUserCondition(), userSearchCondition(line)))
      .orderBy(desc(account.createdAt), desc(account.id))
      .limit(LIMIT);
    return rows.map((row) => ({ accountId: row.id, name: row.name, phone: hidePhone(row.phone) }));
  }

  private async membersOf(
    phoneDigits: string[] | null,
    text: string | null,
  ): Promise<AdminSearchResponse["members"]> {
    const found: SQL[] = [];
    for (const digits of phoneDigits ?? []) {
      found.push(sql`${account.phone} LIKE ${`%${digits}%`}`);
    }
    if (text !== null) {
      found.push(sql`${supplierMember.displayName} ILIKE ${`%${likeEscaped(text)}%`}`);
    }
    if (found.length === 0) {
      return [];
    }
    const rows = await this.database.db
      .select({
        memberId: supplierMember.id,
        supplierId: supplierMember.supplierId,
        supplierName: supplier.name,
        displayName: supplierMember.displayName,
        phone: account.phone,
        status: supplierMember.status,
      })
      .from(supplierMember)
      .innerJoin(account, eq(account.id, supplierMember.accountId))
      .innerJoin(supplier, eq(supplier.id, supplierMember.supplierId))
      .where(sql`(${sql.join(found, sql` OR `)})`)
      .orderBy(supplierMember.status, supplierMember.displayName, supplierMember.id)
      .limit(LIMIT);
    return rows.map((row) => ({ ...row, phone: hidePhone(row.phone) }));
  }

  private async suppliersOf(q: string): Promise<AdminSearchResponse["suppliers"]> {
    const page = await this.suppliers.list({ q, limit: LIMIT });
    return page.suppliers.map((row) => ({
      id: row.id,
      name: row.name,
      bin: row.bin,
      cityName: row.city.names.ru,
    }));
  }

  private async leadsOf(
    bin: string | null,
    text: string | null,
  ): Promise<AdminSearchResponse["leads"]> {
    const page = await this.leads.list(
      bin ? { bin, limit: LIMIT } : { q: text ?? undefined, limit: LIMIT },
    );
    return page.leads.map((lead) => ({
      id: lead.id,
      companyName: lead.companyName,
      bin: lead.bin,
      status: lead.status,
    }));
  }

  private async itemsOf(line: string): Promise<AdminSearchResponse["items"]> {
    const page = await this.items.page({ q: line, limit: LIMIT });
    return page.items.map((item) => ({
      id: item.id,
      name: (item.names.ru ?? item.names.kk ?? item.names.en)?.text ?? "",
      brand: item.brand?.name ?? null,
      article: item.article,
    }));
  }
}

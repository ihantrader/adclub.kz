import { Inject, Injectable } from "@nestjs/common";
import { hidePhone } from "@adclub/domain";
import { sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";

/**
 * The names the journal reads by (TASK-036.B; SCREENS A-AUD): the object of
 * an entry by its name **now** — a company by its name, an employee or a
 * user by theirs, an order «№ 1028», an item by its name — and the things
 * `before`/`after` refer to by id (a city, a company, an account…), so the
 * admin panel shows «Город: Алматы → Астана», not two ids.
 *
 * **One deliberate exception to «a module reads only its own tables»:** the
 * journal names objects of every module, and asking a dozen modules for one
 * page of it would be a dozen ports for one label each. So this one place
 * reads a label column of their tables by id — read-only, never a write, a
 * page at a time (one query per kind of object on the page). An object that
 * is gone (or an id the journal never knew a table for) is simply not
 * named: the screen falls back to the kind of the object.
 */

/** How the objects of one kind are named: `SELECT id, name FROM … WHERE id = ANY(ids)`. */
type Namer = (ids: readonly string[]) => SQL;

const ids = (list: readonly string[]) => sql`${`{${list.join(",")}}`}::uuid[]`;

/** The Russian name of a catalog thing (the source text of its translations). */
const translated = (entityType: string) => (list: readonly string[]) =>
  sql`SELECT entity_id AS id, text AS name FROM translation
      WHERE entity_type = ${entityType} AND field = 'name' AND lang = 'ru' AND entity_id = ANY(${ids(list)})`;

const NAMERS: Record<string, Namer> = {
  supplier: (list) => sql`SELECT id, name FROM supplier WHERE id = ANY(${ids(list)})`,
  supplier_member: (list) =>
    sql`SELECT id, display_name AS name FROM supplier_member WHERE id = ANY(${ids(list)})`,
  supplier_lead: (list) =>
    sql`SELECT id, company_name AS name FROM supplier_lead WHERE id = ANY(${ids(list)})`,
  supplier_invitation: (list) =>
    sql`SELECT invitation.id, member.display_name AS name
        FROM supplier_invitation AS invitation
        JOIN supplier_member AS member ON member.id = invitation.member_id
        WHERE invitation.id = ANY(${ids(list)})`,
  // An account by its name; without one — by its number, partly hidden.
  account: (list) => sql`SELECT id, name, phone FROM account WHERE id = ANY(${ids(list)})`,
  admin_user: (list) =>
    sql`SELECT admin.id, person.name, person.phone
        FROM admin_user AS admin JOIN account AS person ON person.id = admin.account_id
        WHERE admin.id = ANY(${ids(list)})`,
  order: (list) =>
    sql`SELECT id, '№ ' || number AS name FROM customer_order WHERE id = ANY(${ids(list)})`,
  user_discipline_event: (list) =>
    sql`SELECT mark.id, 'Неявка по № ' || purchase.number AS name
        FROM user_discipline_event AS mark JOIN customer_order AS purchase ON purchase.id = mark.order_id
        WHERE mark.id = ANY(${ids(list)})`,
  club_access_grant: (list) =>
    sql`SELECT grant_row.id, person.name, person.phone
        FROM club_access_grant AS grant_row JOIN account AS person ON person.id = grant_row.account_id
        WHERE grant_row.id = ANY(${ids(list)})`,
  catalog_item: translated("catalog_item"),
  catalog_category: translated("category"),
  catalog_attribute: translated("attribute"),
  catalog_attribute_option: translated("attribute_option"),
  catalog_brand: (list) =>
    sql`SELECT brand_id AS id, text AS name FROM brand_spelling WHERE is_name AND brand_id = ANY(${ids(list)})`,
  catalog_item_photo: (list) =>
    sql`SELECT photo.id, name.text AS name FROM item_photo AS photo
        JOIN translation AS name ON name.entity_type = 'catalog_item' AND name.entity_id = photo.item_id
          AND name.field = 'name' AND name.lang = 'ru'
        WHERE photo.id = ANY(${ids(list)})`,
  item_compatibility: (list) =>
    sql`SELECT record.id, name.text AS name FROM item_compatibility AS record
        JOIN translation AS name ON name.entity_type = 'catalog_item' AND name.entity_id = record.item_id
          AND name.field = 'name' AND name.lang = 'ru'
        WHERE record.id = ANY(${ids(list)})`,
  item_compatibility_proposal: (list) =>
    sql`SELECT proposal.id, name.text AS name FROM item_compatibility_proposal AS proposal
        JOIN translation AS name ON name.entity_type = 'catalog_item' AND name.entity_id = proposal.item_id
          AND name.field = 'name' AND name.lang = 'ru'
        WHERE proposal.id = ANY(${ids(list)})`,
  offer: (list) =>
    sql`SELECT sale.id, name.text || ' · ' || seller.name AS name FROM offer AS sale
        JOIN supplier AS seller ON seller.id = sale.supplier_id
        LEFT JOIN translation AS name ON name.entity_type = 'catalog_item' AND name.entity_id = sale.item_id
          AND name.field = 'name' AND name.lang = 'ru'
        WHERE sale.id = ANY(${ids(list)})`,
  city: (list) => sql`SELECT id, name_ru AS name FROM city WHERE id = ANY(${ids(list)})`,
  vehicle_option: (list) =>
    sql`SELECT id, name_ru AS name FROM vehicle_option WHERE id = ANY(${ids(list)})`,
  vehicle_make: (list) =>
    sql`SELECT make_id AS id, text AS name FROM vehicle_make_spelling WHERE is_name AND make_id = ANY(${ids(list)})`,
  vehicle_model: (list) =>
    sql`SELECT model.model_id AS id, make.text || ' ' || model.text AS name
        FROM vehicle_model_spelling AS model
        JOIN vehicle_make_spelling AS make ON make.make_id = model.make_id AND make.is_name
        WHERE model.is_name AND model.model_id = ANY(${ids(list)})`,
  vehicle_generation: (list) =>
    sql`SELECT generation.id, model.text || ' ' || generation.name AS name
        FROM vehicle_generation AS generation
        JOIN vehicle_model_spelling AS model ON model.model_id = generation.model_id AND model.is_name
        WHERE generation.id = ANY(${ids(list)})`,
  vehicle_engine: (list) =>
    sql`SELECT engine_id AS id, text AS name FROM vehicle_engine_spelling WHERE is_code AND engine_id = ANY(${ids(list)})`,
  vehicle_modification: (list) =>
    sql`SELECT modification.id, model.text || ' ' || generation.name || ' · ' || engine.text AS name
        FROM vehicle_modification AS modification
        JOIN vehicle_generation AS generation ON generation.id = modification.generation_id
        JOIN vehicle_model_spelling AS model ON model.model_id = generation.model_id AND model.is_name
        JOIN vehicle_engine_spelling AS engine ON engine.engine_id = modification.engine_id AND engine.is_code
        WHERE modification.id = ANY(${ids(list)})`,
  vehicle_import: (list) =>
    sql`SELECT id, coalesce(file_name, 'Импорт') AS name FROM vehicle_import WHERE id = ANY(${ids(list)})`,
};

/**
 * The kinds of things a field of `before`/`after` refers to by its id
 * (`cityId: "…"` is a city). A field the journal doesn't know is left as
 * it is — the screen keeps such ids out of «было → стало».
 */
export const AUDIT_REFERENCE_FIELDS: Record<string, string> = {
  cityId: "city",
  supplierId: "supplier",
  accountId: "account",
  memberId: "supplier_member",
  contactPersonMemberId: "supplier_member",
  removedByMemberId: "supplier_member",
  leadId: "supplier_lead",
  orderId: "order",
  otherOrderId: "order",
  offerId: "offer",
  itemId: "catalog_item",
  analogItemId: "catalog_item",
  fromItemId: "catalog_item",
  categoryId: "catalog_category",
  parentId: "catalog_category",
  attributeId: "catalog_attribute",
  optionId: "catalog_attribute_option",
  brandId: "catalog_brand",
  makeId: "vehicle_make",
  modelId: "vehicle_model",
  generationId: "vehicle_generation",
  engineId: "vehicle_engine",
  modificationId: "vehicle_modification",
  bodyTypeId: "vehicle_option",
  transmissionTypeId: "vehicle_option",
  driveTypeId: "vehicle_option",
  fuelId: "vehicle_option",
  adminId: "admin_user",
  grantId: "club_access_grant",
};

/** A translation's entry names the thing it is of (`after.entityType`): the kind to name it as. */
const TRANSLATED_KINDS: Record<string, string> = {
  category: "catalog_category",
  attribute: "catalog_attribute",
  attribute_option: "catalog_attribute_option",
  catalog_item: "catalog_item",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NamedEntry {
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
}

export interface EntryNames {
  /** The object of each entry, by `entityType:entityId`. */
  entity: Map<string, string>;
  /** The things the entries refer to, by id. */
  refs: Map<string, string>;
}

function fieldOf(side: unknown, key: string): unknown {
  return typeof side === "object" && side !== null
    ? (side as Record<string, unknown>)[key]
    : undefined;
}

/** The kind an entry's object is named as (a translation — as the thing it is of). */
export function namedKind(entry: NamedEntry): string {
  if (entry.entityType === "catalog_translation") {
    const of = fieldOf(entry.after, "entityType") ?? fieldOf(entry.before, "entityType");
    return typeof of === "string" ? (TRANSLATED_KINDS[of] ?? of) : entry.entityType;
  }
  return entry.entityType;
}

/** The ids `before`/`after` refer to, by the kind of thing (one level deep). */
export function referencesOf(entry: NamedEntry): [kind: string, id: string][] {
  const found: [string, string][] = [];
  for (const side of [entry.before, entry.after]) {
    if (typeof side !== "object" || side === null || Array.isArray(side)) continue;
    for (const [key, value] of Object.entries(side as Record<string, unknown>)) {
      const kind = AUDIT_REFERENCE_FIELDS[key];
      if (kind && typeof value === "string" && UUID.test(value)) {
        found.push([kind, value]);
      }
    }
  }
  return found;
}

@Injectable()
export class AuditNames {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async of(
    entries: readonly NamedEntry[],
    executor: DbExecutor = this.database.db,
  ): Promise<EntryNames> {
    const wanted = new Map<string, Set<string>>();
    const want = (kind: string, id: string) => {
      if (!NAMERS[kind] || !UUID.test(id)) return;
      const set = wanted.get(kind) ?? new Set<string>();
      set.add(id.toLowerCase());
      wanted.set(kind, set);
    };
    for (const entry of entries) {
      want(namedKind(entry), entry.entityId);
      for (const [kind, id] of referencesOf(entry)) want(kind, id);
    }
    const byKind = new Map<string, Map<string, string>>();
    await Promise.all(
      [...wanted].map(async ([kind, set]) => {
        const result = await executor.execute<{ id: string; name: string | null; phone?: string }>(
          NAMERS[kind]!([...set]),
        );
        const names = new Map<string, string>();
        for (const row of result.rows) {
          const name = row.name?.trim() || (row.phone ? hidePhone(row.phone) : "");
          if (name) names.set(String(row.id).toLowerCase(), name);
        }
        byKind.set(kind, names);
      }),
    );
    const entity = new Map<string, string>();
    const refs = new Map<string, string>();
    for (const entry of entries) {
      const name = byKind.get(namedKind(entry))?.get(entry.entityId.toLowerCase());
      if (name) entity.set(`${entry.entityType}:${entry.entityId}`, name);
      for (const [kind, id] of referencesOf(entry)) {
        const ref = byKind.get(kind)?.get(id.toLowerCase());
        if (ref) refs.set(id, ref);
      }
    }
    return { entity, refs };
  }
}

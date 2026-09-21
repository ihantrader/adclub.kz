import { Inject, Injectable, Logger } from "@nestjs/common";
import type { DayHours, SupplierType } from "@adclub/contracts";
import { kzBinCheckDigit } from "@adclub/domain";
import { eq } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { supplier } from "../identity";
import { CitiesService } from "./cities.service";
import { city, supplierLead } from "./schema";
import type { SupplierAdminActor } from "./supplier-common";
import { SupplierLeadsService } from "./supplier-leads.service";
import { SuppliersService } from "./suppliers.service";

/**
 * Cities and an example supplier for development and tests (TASK-016
 * requirement 1, AC-10): the large cities of Kazakhstan with names in
 * kk/ru/en (the codes are those the migration gives to company cities of
 * before the directory, so the seed finds them), a supplier that came
 * from the public form and was worked through the funnel, and one new
 * request waiting in the funnel.
 *
 * Draft data: the Kazakh names are the common official spellings but were
 * not checked by a native speaker; the БИН are made up (valid check digit,
 * no real company).
 */

interface CitySeed {
  code: string;
  names: { ru: string; kk: string; en: string };
}

export const devCities: readonly CitySeed[] = [
  { code: "almaty", names: { ru: "Алматы", kk: "Алматы", en: "Almaty" } },
  { code: "astana", names: { ru: "Астана", kk: "Астана", en: "Astana" } },
  { code: "shymkent", names: { ru: "Шымкент", kk: "Шымкент", en: "Shymkent" } },
  { code: "karaganda", names: { ru: "Караганда", kk: "Қарағанды", en: "Karaganda" } },
  { code: "aktobe", names: { ru: "Актобе", kk: "Ақтөбе", en: "Aktobe" } },
  { code: "taraz", names: { ru: "Тараз", kk: "Тараз", en: "Taraz" } },
  { code: "pavlodar", names: { ru: "Павлодар", kk: "Павлодар", en: "Pavlodar" } },
  { code: "ust-kamenogorsk", names: { ru: "Усть-Каменогорск", kk: "Өскемен", en: "Oskemen" } },
  { code: "semey", names: { ru: "Семей", kk: "Семей", en: "Semey" } },
  { code: "atyrau", names: { ru: "Атырау", kk: "Атырау", en: "Atyrau" } },
  { code: "kostanay", names: { ru: "Костанай", kk: "Қостанай", en: "Kostanay" } },
  { code: "kyzylorda", names: { ru: "Кызылорда", kk: "Қызылорда", en: "Kyzylorda" } },
  { code: "uralsk", names: { ru: "Уральск", kk: "Орал", en: "Oral" } },
  { code: "petropavlovsk", names: { ru: "Петропавловск", kk: "Петропавл", en: "Petropavl" } },
  { code: "aktau", names: { ru: "Актау", kk: "Ақтау", en: "Aktau" } },
  { code: "turkestan", names: { ru: "Туркестан", kk: "Түркістан", en: "Turkistan" } },
  { code: "kokshetau", names: { ru: "Кокшетау", kk: "Көкшетау", en: "Kokshetau" } },
  { code: "taldykorgan", names: { ru: "Талдыкорган", kk: "Талдықорған", en: "Taldykorgan" } },
];

/** A valid БИН from its first 11 digits (the check digit is computed). */
function bin(first11: string): string {
  const digit = kzBinCheckDigit(first11);
  if (digit === null) {
    throw new Error(`No valid БИН starts with ${first11}`);
  }
  return `${first11}${digit}`;
}

const weekday = [
  { from: "09:00", to: "13:00" },
  { from: "14:00", to: "18:00" },
];

/** Monday to Friday with a lunch break, Saturday short, Sunday off. */
export const devSupplierHours: DayHours[] = [
  { day: 1, intervals: weekday },
  { day: 2, intervals: weekday },
  { day: 3, intervals: weekday },
  { day: 4, intervals: weekday },
  { day: 5, intervals: weekday },
  { day: 6, intervals: [{ from: "10:00", to: "15:00" }] },
  { day: 7, intervals: [] },
];

interface LeadSeed {
  companyName: string;
  bin: string;
  cityCode: string;
  type: SupplierType;
  contactName: string;
  phone: string;
}

/** Worked through the funnel and onboarded: its contact is its first employee. */
export const devOnboardedLead: LeadSeed = {
  companyName: "Автомаркет",
  bin: bin("08074000012"),
  cityCode: "almaty",
  type: "both",
  contactName: "Ерлан",
  phone: "+77055550101",
};

/** Just came from the public form. */
export const devNewLead: LeadSeed = {
  companyName: "Шиномонтаж 24",
  bin: bin("15034000456"),
  cityCode: "astana",
  type: "services",
  contactName: "Динара",
  phone: "+77075550202",
};

export class DevSupplierSeedError extends Error {}

export interface DevSupplierSeedResult {
  created: { cities: number; suppliers: number; leads: number };
  existing: { cities: number; suppliers: number; leads: number };
  /** The example supplier and the number of its first employee (sign in to the cabinet with it). */
  supplierId: string;
  memberPhone: string;
}

const OPERATOR: SupplierAdminActor = { role: "operator" };

/**
 * Fills the cities and the example supplier through the same services the
 * administrator uses (every check applies, every step is in the action
 * journal by the operator). Idempotent: a city by code, the supplier by
 * БИН, a request by БИН — what exists is left as it is.
 */
@Injectable()
export class DevSupplierSeed {
  private readonly logger = new Logger("Suppliers");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CitiesService) private readonly cities: CitiesService,
    @Inject(SupplierLeadsService) private readonly leads: SupplierLeadsService,
    @Inject(SuppliersService) private readonly suppliers: SuppliersService,
  ) {}

  async run(): Promise<DevSupplierSeedResult> {
    if (this.config.nodeEnv !== "development" && this.config.nodeEnv !== "test") {
      throw new DevSupplierSeedError(
        "Cities and suppliers are kept by the administrator; the example data is for development and tests only",
      );
    }
    const result: DevSupplierSeedResult = {
      created: { cities: 0, suppliers: 0, leads: 0 },
      existing: { cities: 0, suppliers: 0, leads: 0 },
      supplierId: "",
      memberPhone: devOnboardedLead.phone,
    };
    const db = this.database.db;
    const cityIds = new Map<string, string>();
    for (const seed of devCities) {
      const [existing] = await db
        .select({ id: city.id })
        .from(city)
        .where(eq(city.code, seed.code));
      const id = existing?.id ?? (await this.cities.create(seed, OPERATOR)).id;
      result[existing ? "existing" : "created"].cities += 1;
      cityIds.set(seed.code, id);
    }

    const [existingSupplier] = await db
      .select({ id: supplier.id })
      .from(supplier)
      .where(eq(supplier.bin, devOnboardedLead.bin));
    if (existingSupplier) {
      // Its request too: both were made together.
      result.existing.suppliers += 1;
      result.existing.leads += 1;
      result.supplierId = existingSupplier.id;
    } else {
      const leadId = await this.publicLead(devOnboardedLead, cityIds);
      result.created.leads += 1;
      let version = 1;
      for (const status of ["contacted", "meeting", "contract_signed"] as const) {
        version = (
          await this.leads.setStatus(leadId, { expectedVersion: version, status }, OPERATOR)
        ).lead.version;
      }
      const onboarded = await this.leads.onboard(
        leadId,
        {
          expectedVersion: version,
          address: "ул. Толе би, 101",
          district: "Алмалинский район",
        },
        OPERATOR,
      );
      const supplierId = onboarded.supplier.id;
      await this.suppliers.setSchedule(
        supplierId,
        {
          expectedVersion: onboarded.supplier.version,
          weeklyHours: devSupplierHours,
          closedDates: [],
        },
        OPERATOR,
      );
      const card = await this.suppliers.adminCard(supplierId);
      await this.suppliers.setVerification(
        supplierId,
        { expectedVersion: card.version, verified: true, contractSignedOn: todayUtc() },
        OPERATOR,
      );
      result.created.suppliers += 1;
      result.supplierId = supplierId;
    }

    const [existingLead] = await db
      .select({ id: supplierLead.id })
      .from(supplierLead)
      .where(eq(supplierLead.bin, devNewLead.bin));
    if (existingLead) {
      result.existing.leads += 1;
    } else {
      await this.publicLead(devNewLead, cityIds);
      result.created.leads += 1;
    }
    this.logger.log(
      `Development suppliers seeded cities=${result.created.cities}/${result.existing.cities} suppliers=${result.created.suppliers}/${result.existing.suppliers} leads=${result.created.leads}/${result.existing.leads}`,
    );
    return result;
  }

  /** A request as the public form leaves it (the form itself is limited per address). */
  private async publicLead(seed: LeadSeed, cityIds: Map<string, string>): Promise<string> {
    const [row] = await this.database.db
      .insert(supplierLead)
      .values({
        companyName: seed.companyName,
        bin: seed.bin,
        cityId: cityIds.get(seed.cityCode)!,
        type: seed.type,
        contactName: seed.contactName,
        phone: seed.phone,
        source: "public_form",
        language: "ru",
        consentAt: new Date(),
        consentVersion: "1",
      })
      .returning({ id: supplierLead.id });
    return row!.id;
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

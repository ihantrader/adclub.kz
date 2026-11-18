import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { describeError } from "../common/health/describe-error";
import { DatabaseService } from "../database";
import { aiJob } from "../modules/ai";
import { almatyDayOf } from "../modules/offer-views";
import { AppSettings } from "../modules/settings";
import { RedisService, rateLimitSubject } from "../redis";

/** What a guest's AI request was (`guestAiTrial` routes, TASK-066). */
export type GuestTrialKind = "photo" | "speech" | "assistant";

export const GUEST_TRIAL_KINDS: readonly GuestTrialKind[] = ["photo", "speech", "assistant"];

/**
 * How long a device is remembered as seen (TASK-066): as long as its trial
 * attempts are (`DEVICE_WINDOW_SECONDS`, a year) and a little more, so a
 * device that comes back within its trial is never «new» again.
 */
const FIRST_SEEN_SECONDS = 400 * 24 * 60 * 60;

/** The counts of a day are kept a week: the command looks at today and the days just before. */
const DAY_KEYS_SECONDS = 8 * 24 * 60 * 60;

/** How many networks of new devices the command lists. */
const TOP_SUBNETS = 10;

const PREFIX = "guest:";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The network of an address as the command shows it (TASK-066): IPv4 by
 * its /24, IPv6 by its /64 — never the address itself.
 */
export function maskedSubnet(ip: string | undefined): string {
  const subject = rateLimitSubject(ip);
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(subject);
  if (v4) {
    return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  }
  // `rateLimitSubject` already gives an IPv6 address as its /64 (`…::/64`).
  return subject;
}

/** A device id the app makes (a UUID); anything else is not counted. */
export function deviceIdOf(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

export interface GuestRequestCounts {
  /** A guest's requests of the kind served today. */
  all: number;
  /** Of them, from devices first seen on an earlier day and still without signing in. */
  olderDevices: number;
}

export interface GuestStatus {
  /** The Almaty day, `YYYY-MM-DD`. */
  day: string;
  /** The switch «ИИ только для вошедших» (`guest_attestation_required`). */
  attestationRequired: boolean;
  /** The guests' AI spend of the day against `guest_ai_daily_budget_usd`. */
  budget: { spentUsd: number; budgetUsd: number; exhausted: boolean };
  /** The guests' model calls of the day by kind and status (`ai_job`). */
  calls: { kind: string; status: string; calls: number }[];
  /** A guest's served AI requests of the day by kind, and from devices seen before today. */
  requests: Record<GuestTrialKind, GuestRequestCounts> & {
    total: GuestRequestCounts & { olderDevicesShare: number | null };
  };
  /** Devices that made a guest's AI request today, and of them those never seen before. */
  devices: { seen: number; new: number };
  /** The networks with the most new devices today: /24 and /64 only, never an address. */
  newDeviceSubnets: { subnet: string; devices: number }[];
}

/**
 * The signs to decide on the switch by (ARCHITECTURE 8.6; TASK-066): which
 * guest devices make AI requests, whether they are new, from which network.
 * Kept in Redis only — the device id is already in the keys of the trial
 * limits; the address is kept only as its /24 or /64 and only in a count of
 * new devices. Counting is best effort: a request is never refused or
 * slowed for it.
 */
@Injectable()
export class GuestActivity {
  private readonly logger = new Logger("GuestActivity");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  /** One served AI request of a guest's device. */
  async record(input: {
    deviceId: string;
    ip: string | undefined;
    kind: GuestTrialKind;
    at?: Date;
  }): Promise<void> {
    const client = this.redis.client;
    if (client.status !== "ready") return;
    const day = almatyDayOf(input.at ?? new Date());
    try {
      const firstKey = `${PREFIX}first-seen:${input.deviceId}`;
      const isNew = (await client.set(firstKey, day, "EX", FIRST_SEEN_SECONDS, "NX")) === "OK";
      const firstDay = isNew ? day : ((await client.get(firstKey)) ?? day);
      const keys = dayKeys(day);
      const batch = client.multi();
      batch.pfadd(keys.devices, input.deviceId);
      batch.incr(keys.requests(input.kind));
      if (firstDay < day) batch.incr(keys.olderRequests(input.kind));
      if (isNew) {
        batch.incr(keys.newDevices);
        batch.zincrby(keys.newSubnets, 1, maskedSubnet(input.ip));
      }
      for (const key of keys.all()) batch.expire(key, DAY_KEYS_SECONDS);
      await batch.exec();
    } catch (error) {
      this.logger.warn(`Guest activity not counted: ${describeError(error)}`);
    }
  }

  /** The signs of a day (today by default) for the operator. */
  async status(day: string = almatyDayOf(new Date())): Promise<GuestStatus> {
    const keys = dayKeys(day);
    const client = this.redis.client;
    const read = async (key: string) => Number((await client.get(key)) ?? 0);
    const requests = {} as Record<GuestTrialKind, GuestRequestCounts>;
    for (const kind of GUEST_TRIAL_KINDS) {
      requests[kind] = {
        all: await read(keys.requests(kind)),
        olderDevices: await read(keys.olderRequests(kind)),
      };
    }
    const all = GUEST_TRIAL_KINDS.reduce((sum, kind) => sum + requests[kind].all, 0);
    const older = GUEST_TRIAL_KINDS.reduce((sum, kind) => sum + requests[kind].olderDevices, 0);
    const subnets = await client.zrevrange(keys.newSubnets, 0, TOP_SUBNETS - 1, "WITHSCORES");
    const newDeviceSubnets: GuestStatus["newDeviceSubnets"] = [];
    for (let index = 0; index + 1 < subnets.length; index += 2) {
      newDeviceSubnets.push({ subnet: subnets[index]!, devices: Number(subnets[index + 1]) });
    }

    const start = sql`(${day}::date::timestamp AT TIME ZONE 'Asia/Almaty')`;
    const end = sql`((${day}::date + 1)::timestamp AT TIME ZONE 'Asia/Almaty')`;
    const ofTheDay = and(
      eq(aiJob.initiatorType, "guest_device"),
      gte(aiJob.createdAt, start),
      lt(aiJob.createdAt, end),
    );
    const [calls, spent, budgetUsd, attestationRequired] = await Promise.all([
      this.database.db
        .select({
          kind: aiJob.kind,
          status: aiJob.status,
          calls: sql<string>`count(*)::text`,
        })
        .from(aiJob)
        .where(ofTheDay)
        .groupBy(aiJob.kind, aiJob.status)
        .orderBy(aiJob.kind, aiJob.status),
      this.database.db
        .select({ spent: sql<string>`COALESCE(sum(${aiJob.costUsd}), 0)::text` })
        .from(aiJob)
        .where(ofTheDay),
      this.settings.get("guest_ai_daily_budget_usd"),
      this.settings.get("guest_attestation_required"),
    ]);
    const spentUsd = Number(spent[0]?.spent ?? 0);
    return {
      day,
      attestationRequired,
      budget: { spentUsd, budgetUsd, exhausted: spentUsd >= budgetUsd },
      calls: calls.map((row) => ({ kind: row.kind, status: row.status, calls: Number(row.calls) })),
      requests: {
        ...requests,
        total: { all, olderDevices: older, olderDevicesShare: all === 0 ? null : older / all },
      },
      devices: {
        seen: await client.pfcount(keys.devices),
        new: await read(keys.newDevices),
      },
      newDeviceSubnets,
    };
  }
}

function dayKeys(day: string) {
  const requests = (kind: GuestTrialKind) => `${PREFIX}requests:${day}:${kind}`;
  const olderRequests = (kind: GuestTrialKind) => `${PREFIX}requests-older:${day}:${kind}`;
  const devices = `${PREFIX}devices:${day}`;
  const newDevices = `${PREFIX}new-devices:${day}`;
  const newSubnets = `${PREFIX}new-subnets:${day}`;
  return {
    requests,
    olderRequests,
    devices,
    newDevices,
    newSubnets,
    all: () => [
      devices,
      newDevices,
      newSubnets,
      ...GUEST_TRIAL_KINDS.flatMap((kind) => [requests(kind), olderRequests(kind)]),
    ],
  };
}

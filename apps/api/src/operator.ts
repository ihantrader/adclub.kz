import "reflect-metadata";
import { parseArgs } from "node:util";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { JsonLoggerService } from "./common/logging";
import {
  ConfigModule,
  ConfigValidationError,
  loadConfig,
  loadEnvFile,
  type AppConfig,
} from "./config";
import { DatabaseModule, withoutQueryParameters } from "./database";
import { StorageModule } from "./storage";
import { describeError } from "./common/health";
import { ApiException } from "./common/errors";
import {
  identityOperatorProviders,
  OperatorCommandError,
  OperatorService,
} from "./modules/identity";
import { AiModule, AiService } from "./modules/ai";
import { MessagingAdmin, MessagingCommandError, MessagingModule } from "./modules/messaging";
import { AuditModule } from "./modules/audit";
import {
  CatalogModule,
  DevCatalogSeed,
  DevCatalogSeedError,
  recheckEvalRun,
  saveEvalRun,
  TranslationEval,
  TranslationQueue,
} from "./modules/catalog";
import { SettingsChangeService, SettingsModule } from "./modules/settings";
import { DevVehicleSeed, DevVehicleSeedError, VehiclesModule } from "./modules/vehicles";
import {
  CompatibilityModule,
  DevCompatibilitySeed,
  DevCompatibilitySeedError,
} from "./modules/compatibility";
import { DevSupplierSeed, DevSupplierSeedError, SuppliersModule } from "./modules/suppliers";
import { ClubAccessGrants, ClubAccessModule } from "./modules/club-access";
import { ObservabilityModule, sanitizeForLog } from "./observability";
import { devAlwaysFailingJob, JobAdmin, JobAdminError, JobQueue, JobsModule } from "./jobs";
import { backgroundJobCatalog, hasDevJobs } from "./background-jobs";

/**
 * The server operator command (ARCHITECTURE 4.8; D-045, D-047). Runs on
 * the server with the API's environment; there is no API for any of it.
 *
 *   admin:grant <phone>          appoint an administrator
 *   admin:revoke <phone>         remove one (their admin sessions end at once)
 *   admin:reset-totp <phone>     reset the second factor (e.g. the only administrator)
 *
 * Club access of users by hand (TASK-020, D-059) — every change is in the
 * journal with `by=operator`:
 *   club-access:grant <phone> --until <YYYY-MM-DD | ISO time> --reason <text>
 *                                give the phone number's account club access
 *                                (a date — through that day, Almaty time); a
 *                                current grant is replaced
 *   club-access:revoke <phone> --reason <text>   end the current grant now
 *   club-access:status <phone>   the access now and every grant of the account
 *
 * Settings (ARCHITECTURE 4.11) — any setting, sign-in security ones
 * included (D-053); every change is recorded with `by=operator`:
 *   settings:list
 *   settings:get <key>
 *   settings:set <key> <value> --reason <text> [--expected-version <n>]
 *   settings:reset <key> --reason <text> [--expected-version <n>]
 *   settings:history <key>
 * `<value>` is JSON (`10`, `true`, `'{"ru":"…","kk":"…","en":"…"}'`); anything
 * that isn't JSON is taken as a string (`1.4.0`). A change applies to the
 * running API and worker within 30 seconds.
 *
 * Background jobs (ARCHITECTURE 4.12) — never shows a job's data:
 *   jobs:status                  every declared job: waiting, retrying, running,
 *                                failed, dead; schedule and last runs of periodic jobs
 *   jobs:dead [--job <name>]     jobs in the dead letter queues
 *   jobs:retry <deadJobId>       put a dead job back on its queue (fresh retries)
 *   jobs:delete <deadJobId>      drop a dead job
 *   jobs:run <name>              start a periodic job now (e.g. identity.cleanup-sessions)
 *
 * AI and automatic translation of the catalog (ARCHITECTURE 4.19):
 *   ai:status                    the provider, today's spend against the daily budget, today's
 *                                calls by kind and status, the latest failed calls
 *   translations:status          the queue: pending, held by a run, waiting after a temporary
 *                                failure, and the tasks refused for good with the reason
 *   translations:queue-missing   queue a translation for every language that has none (what
 *                                came before automatic translation, or was cleared)
 *   translations:run             put a translation run on the queue now
 *   translations:retry-failed    queue the tasks refused for good again
 *
 * Choosing the model of an operation (TASK-053.B, D-058) — development only:
 *   ai:eval:translate --models <a,b,…> --confirm-spend <usd> [--glossary]
 *                     [--batch-size <n>] [--label <text>]
 *                                translate the sample set of `ai-eval/translate`
 *                                once with each model and collect what the run
 *                                cost, how long it took, what failed and what the
 *                                machine checks found; the result is written to
 *                                `ai-eval/translate/results/`. The spend has to be
 *                                stated and must fit in what is left of the daily
 *                                budget, which is what stops a run.
 *   ai:eval:recheck <name>       run the checks over a saved result again (the texts
 *                                are in the file): nothing is called and nothing is
 *                                spent, and a sharper check applies to past runs too
 *
 * Messages to suppliers (ARCHITECTURE 4.35) — never the values of the
 * placeholders, and never a whole number:
 *   messages:list [--limit <n>] [--status <status>] [--template <key>]
 *                                the latest messages: template, language, masked
 *                                number, status, attempts, the provider's id and
 *                                the last error, plus the counts by status
 *   messages:retry <messageId>   put a message that failed or was interrupted back
 *                                on the queue (only while it still has the values
 *                                it would be built from)
 *   messages:webhooks [--limit <n>]
 *                                the latest webhook deliveries of the provider and
 *                                what each of them held
 *
 * Development and tests only (the real flows arrive with TASK-016/017):
 *   dev:supplier:create --name <name> --city <city>
 *   dev:member:add <supplierId> <phone> --name <display name>
 *   dev:member:remove <memberId>
 *   dev:catalog:seed             fill the catalog with the example tree (TASK-010);
 *                                a second run creates nothing
 *   dev:vehicles:seed            fill the vehicle catalog with draft example data
 *                                (TASK-014); a second run creates nothing
 *   dev:compatibility:seed       both seeds above, then compatibility of the
 *                                example items (TASK-015); idempotent
 *   dev:suppliers:seed           the cities of Kazakhstan and an example supplier
 *                                worked through the funnel, plus a new request
 *                                (TASK-016); idempotent
 *   dev:messages:webhook --message <id> [--status delivered|read|sent|failed]
 *                        [--button confirm|decline|<payload>] [--from <phone>]
 *                        [--twice] [--bad-signature]
 *                                send this deployment a webhook of the provider,
 *                                signed with the configured app secret, to its own
 *                                address: the signature check, the receipt, the
 *                                queue and the applying, without Meta
 *   dev:jobs:fail [--note <text>] [--on-query]
 *                                put a job that always fails on the queue;
 *                                with --on-query it fails on a real SQL query
 *                                bound to the note (TASK-009.A)
 *
 * `pnpm --filter api operator <command> …` (dev) or
 * `node dist/operator.js <command> …` (built). Prints the result as JSON;
 * every action is also written to the application log.
 */

@Module({})
class OperatorModule {
  static forRoot(config: AppConfig) {
    return {
      module: OperatorModule,
      imports: [
        ConfigModule.forRoot(config),
        ObservabilityModule.forRoot(config, { http: false }),
        DatabaseModule,
        // The catalog module keeps photos, which live in the object
        // storage (TASK-013).
        StorageModule,
        AuditModule.forRoot({ http: false }),
        SettingsModule.forRoot({ http: false }),
        AiModule.forRoot(config),
        MessagingModule.forRoot(config, { http: false }),
        CatalogModule.forRoot({ http: false }),
        VehiclesModule.forRoot({ http: false }),
        CompatibilityModule.forRoot({ http: false }),
        SuppliersModule.forRoot({ http: false }),
        ClubAccessModule.forRoot({ http: false }),
        JobsModule.forRoot({
          role: "producer",
          catalog: backgroundJobCatalog(config),
          startOnBoot: false,
        }),
      ],
      providers: [JsonLoggerService, ...identityOperatorProviders, TranslationEval],
    };
  }
}

const USAGE = `Usage: operator <command> [arguments]
  admin:grant <phone>
  admin:revoke <phone>
  admin:reset-totp <phone>
  club-access:grant <phone> --until <YYYY-MM-DD | ISO time> --reason <text>
  club-access:revoke <phone> --reason <text>
  club-access:status <phone>
  settings:list
  settings:get <key>
  settings:set <key> <value> --reason <text> [--expected-version <n>]
  settings:reset <key> --reason <text> [--expected-version <n>]
  settings:history <key>
  jobs:status
  jobs:dead [--job <name>]
  jobs:retry <deadJobId>
  jobs:delete <deadJobId>
  jobs:run <name>
  messages:list [--limit <n>] [--status <status>] [--template <key>]
  messages:retry <messageId>
  messages:webhooks [--limit <n>]
  ai:status
  translations:status
  translations:queue-missing
  translations:run
  translations:retry-failed
  ai:eval:translate --models <a,b,...> --confirm-spend <usd> [--glossary] [--batch-size <n>] [--label <text>]
  ai:eval:recheck <result file name>
  dev:supplier:create --name <name> --city <city>
  dev:member:add <supplierId> <phone> --name <display name>
  dev:member:remove <memberId>
  dev:catalog:seed
  dev:vehicles:seed
  dev:compatibility:seed
  dev:suppliers:seed
  dev:messages:webhook --message <id> [--status <status>] [--button confirm|decline|<payload>] [--from <phone>] [--twice] [--bad-signature]
  dev:jobs:fail [--note <text>] [--on-query]`;

function required(value: string | undefined, what: string): string {
  if (!value) {
    throw new OperatorCommandError(`Missing ${what}\n${USAGE}`);
  }
  return value;
}

/** A command-line value: JSON if it parses, otherwise the text itself. */
function settingValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** `--limit`: a whole number, or nothing at all. */
function countOption(text: string | undefined, flag: string): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(text)) {
    throw new OperatorCommandError(`${flag} must be a whole number`);
  }
  return Number(text);
}

function expectedVersion(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(text)) {
    throw new OperatorCommandError("--expected-version must be a whole number");
  }
  return Number(text);
}

const OPERATOR = { kind: "operator" } as const;

/**
 * `--until`: an ISO time, or a date — through that day in Almaty (UTC+5,
 * the one time of Kazakhstan since 2024), that is until 00:00 of the next.
 */
function grantEnd(text: string): Date {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const end = date
    ? new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]) + 1) - 5 * 3_600_000)
    : new Date(text);
  if (Number.isNaN(end.getTime())) {
    throw new OperatorCommandError("--until must be a date (YYYY-MM-DD) or an ISO time");
  }
  return end;
}

interface Services {
  operator: OperatorService;
  messaging: MessagingAdmin;
  settings: SettingsChangeService;
  jobs: JobAdmin;
  queue: JobQueue;
  devJobs: boolean;
  catalogSeed: DevCatalogSeed;
  vehicleSeed: DevVehicleSeed;
  compatibilitySeed: DevCompatibilitySeed;
  supplierSeed: DevSupplierSeed;
  clubAccess: ClubAccessGrants;
  ai: AiService;
  translations: TranslationQueue;
  translationEval: TranslationEval;
  devCommands: boolean;
}

async function run(
  {
    operator,
    messaging,
    settings,
    jobs,
    queue,
    devJobs,
    catalogSeed,
    vehicleSeed,
    compatibilitySeed,
    supplierSeed,
    clubAccess,
    ai,
    translations,
    translationEval,
    devCommands,
  }: Services,
  argv: string[],
): Promise<unknown> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      city: { type: "string" },
      reason: { type: "string" },
      until: { type: "string" },
      "expected-version": { type: "string" },
      job: { type: "string" },
      note: { type: "string" },
      "on-query": { type: "boolean" },
      models: { type: "string" },
      "confirm-spend": { type: "string" },
      "batch-size": { type: "string" },
      glossary: { type: "boolean" },
      label: { type: "string" },
      limit: { type: "string" },
      status: { type: "string" },
      template: { type: "string" },
      message: { type: "string" },
      "provider-message-id": { type: "string" },
      button: { type: "string" },
      from: { type: "string" },
      twice: { type: "boolean" },
      "bad-signature": { type: "boolean" },
    },
  });
  const [command, first, second] = positionals;
  switch (command) {
    case "settings:list":
      return (await settings.list()).groups.flatMap((group) =>
        group.settings.map((setting) => ({
          key: setting.key,
          group: group.id,
          value: setting.value,
          isDefault: setting.isDefault,
          storedValueInvalid: setting.storedValueInvalid,
          version: setting.version,
          editableBy: setting.editableBy,
        })),
      );
    case "settings:get":
      return settings.get(required(first, "<key>"));
    case "settings:set":
      return settings.change({
        key: required(first, "<key>"),
        value: settingValue(required(second, "<value>")),
        reason: required(values.reason, "--reason"),
        expectedVersion: expectedVersion(values["expected-version"]),
        actor: OPERATOR,
      });
    case "settings:reset":
      return settings.reset({
        key: required(first, "<key>"),
        reason: required(values.reason, "--reason"),
        expectedVersion: expectedVersion(values["expected-version"]),
        actor: OPERATOR,
      });
    case "settings:history":
      return settings.history(required(first, "<key>"));
    case "jobs:status":
      return jobs.status();
    case "jobs:dead":
      return jobs.deadJobs(values.job);
    case "jobs:retry":
      return jobs.retryDead(required(first, "<deadJobId>"));
    case "jobs:delete":
      return jobs.deleteDead(required(first, "<deadJobId>"));
    case "jobs:run":
      return jobs.runNow(required(first, "<name>"));
    case "messages:list":
      return messaging.list({
        limit: countOption(values.limit, "--limit"),
        ...(values.status === undefined ? {} : { status: values.status }),
        ...(values.template === undefined ? {} : { template: values.template }),
      });
    case "messages:retry":
      return messaging.retry(required(first, "<messageId>"));
    case "messages:webhooks":
      return messaging.webhooks(countOption(values.limit, "--limit") ?? 20);
    case "dev:messages:webhook": {
      if (!devCommands) {
        throw new MessagingCommandError(
          "dev:messages:webhook is available in development and tests only",
        );
      }
      return messaging.devWebhook({
        ...(values.message === undefined ? {} : { messageId: values.message }),
        ...(values["provider-message-id"] === undefined
          ? {}
          : { providerMessageId: values["provider-message-id"] }),
        ...(values.status === undefined ? {} : { status: values.status }),
        ...(values.button === undefined ? {} : { button: values.button }),
        ...(values.from === undefined ? {} : { from: values.from }),
        twice: values.twice === true,
        badSignature: values["bad-signature"] === true,
      });
    }
    case "ai:status":
      return ai.status();
    case "translations:status":
      return translations.status();
    case "translations:queue-missing":
      return translations.queueMissing();
    case "translations:run":
      return { jobId: await translations.wake() };
    case "translations:retry-failed":
      return translations.retryFailed();
    case "ai:eval:recheck": {
      if (!devCommands) {
        throw new OperatorCommandError(
          "ai:eval:recheck is available in development and tests only",
        );
      }
      return recheckEvalRun(required(first, "<result file name>"));
    }
    case "ai:eval:translate": {
      if (!devCommands) {
        throw new OperatorCommandError(
          "ai:eval:translate is available in development and tests only",
        );
      }
      const models = required(values.models, "--models")
        .split(",")
        .map((model) => model.trim())
        .filter((model) => model.length > 0);
      if (models.length === 0) {
        throw new OperatorCommandError("--models lists no model");
      }
      const confirmed = Number(required(values["confirm-spend"], "--confirm-spend"));
      if (!Number.isFinite(confirmed) || confirmed <= 0) {
        throw new OperatorCommandError("--confirm-spend must be an amount in USD, e.g. 0.5");
      }
      // What stops a run is the daily budget itself (the comparison goes
      // through `AiService` like everything else), so the stated spend has to
      // fit in what is left of it; otherwise the run could quietly cost more.
      const budget = await ai.budget();
      const left = budget.budgetUsd - budget.spentUsd;
      if (confirmed > left) {
        throw new OperatorCommandError(
          `--confirm-spend $${confirmed} is more than the daily AI budget has left ($${left.toFixed(4)} of $${budget.budgetUsd}); lower it or raise ai_daily_budget_usd`,
        );
      }
      const batchSize = values["batch-size"] === undefined ? 10 : Number(values["batch-size"]);
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
        throw new OperatorCommandError("--batch-size must be a whole number from 1 to 100");
      }
      const run = await translationEval.run({
        models,
        batchSize,
        glossary: values.glossary === true,
        languages: ["kk", "en"],
        ...(values.label === undefined ? {} : { label: values.label }),
      });
      const name = `${run.startedAt.slice(0, 10)}-${values.label ?? "models"}`;
      const path = saveEvalRun(run, name);
      return {
        saved: path,
        dataVersion: run.dataVersion,
        samples: run.samples,
        glossary: run.options.glossary,
        // The texts themselves are in the saved file; here only the numbers.
        results: run.results.map((result) => ({
          model: result.model,
          calls: result.calls,
          failedCalls: result.failedCalls,
          failureKinds: [...new Set(result.failures.map((failure) => failure.kind))],
          costUsd: result.costUsd,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: result.latencyMs,
          answered: result.quality?.answered ?? 0,
          expected: result.quality?.expected ?? 0,
          problemTexts: result.quality?.problemTexts ?? null,
          problemShare: result.quality?.problemShare ?? null,
          counts: result.quality?.counts ?? null,
          observations: result.quality?.observations ?? null,
        })),
      };
    }
    case "dev:jobs:fail": {
      if (!devJobs) {
        throw new OperatorCommandError("dev:jobs:fail is available in development and tests only");
      }
      const jobId = await queue.enqueue(devAlwaysFailingJob, {
        note: values.note ?? "operator dev:jobs:fail",
        ...(values["on-query"] && { failOnQuery: true }),
      });
      return { job: devAlwaysFailingJob.name, jobId };
    }
    case "admin:grant":
      return operator.grantAdmin(required(first, "<phone>"));
    case "admin:revoke":
      return operator.revokeAdmin(required(first, "<phone>"));
    case "admin:reset-totp":
      return operator.resetAdminTotp(required(first, "<phone>"));
    case "club-access:grant":
      return clubAccess.grant(
        {
          phone: required(first, "<phone>"),
          validUntil: grantEnd(required(values.until, "--until")),
          reason: required(values.reason, "--reason"),
        },
        { role: "operator" },
      );
    case "club-access:revoke":
      return clubAccess.revoke(
        { phone: required(first, "<phone>"), reason: required(values.reason, "--reason") },
        { role: "operator" },
      );
    case "club-access:status":
      return clubAccess.statusOf(required(first, "<phone>"));
    case "dev:supplier:create":
      return operator.createSupplier({
        name: required(values.name, "--name"),
        city: required(values.city, "--city"),
      });
    case "dev:member:add":
      return operator.addMember({
        supplierId: required(first, "<supplierId>"),
        phone: required(second, "<phone>"),
        displayName: required(values.name, "--name"),
      });
    case "dev:catalog:seed":
      return catalogSeed.run();
    case "dev:vehicles:seed":
      return vehicleSeed.run();
    case "dev:compatibility:seed":
      return {
        catalog: await catalogSeed.run(),
        vehicles: await vehicleSeed.run(),
        compatibility: await compatibilitySeed.run(),
      };
    case "dev:suppliers:seed":
      return supplierSeed.run();
    case "dev:member:remove":
      return { removed: true, ...(await operator.removeMember(required(first, "<memberId>"))) };
    default:
      throw new OperatorCommandError(USAGE);
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const app = await NestFactory.createApplicationContext(OperatorModule.forRoot(config), {
    bufferLogs: true,
  });
  app.useLogger(app.get(JsonLoggerService));
  app.flushLogs();
  try {
    const result = await run(
      {
        operator: app.get(OperatorService),
        messaging: app.get(MessagingAdmin),
        settings: app.get(SettingsChangeService),
        jobs: app.get(JobAdmin),
        queue: app.get(JobQueue),
        devJobs: hasDevJobs(config),
        catalogSeed: app.get(DevCatalogSeed),
        vehicleSeed: app.get(DevVehicleSeed),
        compatibilitySeed: app.get(DevCompatibilitySeed),
        supplierSeed: app.get(DevSupplierSeed),
        clubAccess: app.get(ClubAccessGrants),
        ai: app.get(AiService),
        translations: app.get(TranslationQueue),
        translationEval: app.get(TranslationEval),
        devCommands: hasDevJobs(config),
      },
      process.argv.slice(2),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  if (
    error instanceof ConfigValidationError ||
    error instanceof OperatorCommandError ||
    error instanceof DevCatalogSeedError ||
    error instanceof DevVehicleSeedError ||
    error instanceof DevCompatibilitySeedError ||
    error instanceof DevSupplierSeedError ||
    error instanceof JobAdminError ||
    error instanceof MessagingCommandError
  ) {
    console.error(error.message);
  } else if (error instanceof ApiException) {
    // A refused change: the same code and details the API would answer.
    console.error(
      `${error.code}: ${error.message}${error.options.details === undefined ? "" : ` ${JSON.stringify(error.options.details)}`}`,
    );
  } else {
    // Query errors carry bound values (phone numbers): never print those.
    console.error(
      sanitizeForLog(`Operator command failed: ${describeError(withoutQueryParameters(error))}`),
    );
  }
  process.exitCode = 1;
});

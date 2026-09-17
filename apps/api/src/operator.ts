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
import { describeError } from "./common/health";
import { ApiException } from "./common/errors";
import {
  identityOperatorProviders,
  OperatorCommandError,
  OperatorService,
} from "./modules/identity";
import { SettingsChangeService, SettingsModule } from "./modules/settings";

/**
 * The server operator command (ARCHITECTURE 4.8; D-045, D-047). Runs on
 * the server with the API's environment; there is no API for any of it.
 *
 *   admin:grant <phone>          appoint an administrator
 *   admin:revoke <phone>         remove one (their admin sessions end at once)
 *   admin:reset-totp <phone>     reset the second factor (e.g. the only administrator)
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
 * Development and tests only (the real flows arrive with TASK-016/017):
 *   dev:supplier:create --name <name> --city <city>
 *   dev:member:add <supplierId> <phone> --name <display name>
 *   dev:member:remove <memberId>
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
        DatabaseModule,
        SettingsModule.forRoot({ http: false }),
      ],
      providers: [JsonLoggerService, ...identityOperatorProviders],
    };
  }
}

const USAGE = `Usage: operator <command> [arguments]
  admin:grant <phone>
  admin:revoke <phone>
  admin:reset-totp <phone>
  settings:list
  settings:get <key>
  settings:set <key> <value> --reason <text> [--expected-version <n>]
  settings:reset <key> --reason <text> [--expected-version <n>]
  settings:history <key>
  dev:supplier:create --name <name> --city <city>
  dev:member:add <supplierId> <phone> --name <display name>
  dev:member:remove <memberId>`;

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

async function run(
  operator: OperatorService,
  settings: SettingsChangeService,
  argv: string[],
): Promise<unknown> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      city: { type: "string" },
      reason: { type: "string" },
      "expected-version": { type: "string" },
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
    case "admin:grant":
      return operator.grantAdmin(required(first, "<phone>"));
    case "admin:revoke":
      return operator.revokeAdmin(required(first, "<phone>"));
    case "admin:reset-totp":
      return operator.resetAdminTotp(required(first, "<phone>"));
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
      app.get(OperatorService),
      app.get(SettingsChangeService),
      process.argv.slice(2),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigValidationError || error instanceof OperatorCommandError) {
    console.error(error.message);
  } else if (error instanceof ApiException) {
    // A refused change: the same code and details the API would answer.
    console.error(
      `${error.code}: ${error.message}${error.options.details === undefined ? "" : ` ${JSON.stringify(error.options.details)}`}`,
    );
  } else {
    // Query errors carry bound values (phone numbers): never print those.
    console.error(`Operator command failed: ${describeError(withoutQueryParameters(error))}`);
  }
  process.exitCode = 1;
});

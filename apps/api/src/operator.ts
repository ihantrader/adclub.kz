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
import {
  identityOperatorProviders,
  OperatorCommandError,
  OperatorService,
} from "./modules/identity";

/**
 * The server operator command (ARCHITECTURE 4.8; D-045, D-047). Runs on
 * the server with the API's environment; there is no API for any of it.
 *
 *   admin:grant <phone>          appoint an administrator
 *   admin:revoke <phone>         remove one (their admin sessions end at once)
 *   admin:reset-totp <phone>     reset the second factor (e.g. the only administrator)
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
      imports: [ConfigModule.forRoot(config), DatabaseModule],
      providers: [JsonLoggerService, ...identityOperatorProviders],
    };
  }
}

const USAGE = `Usage: operator <command> [arguments]
  admin:grant <phone>
  admin:revoke <phone>
  admin:reset-totp <phone>
  dev:supplier:create --name <name> --city <city>
  dev:member:add <supplierId> <phone> --name <display name>
  dev:member:remove <memberId>`;

function required(value: string | undefined, what: string): string {
  if (!value) {
    throw new OperatorCommandError(`Missing ${what}\n${USAGE}`);
  }
  return value;
}

async function run(operator: OperatorService, argv: string[]): Promise<unknown> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { name: { type: "string" }, city: { type: "string" } },
  });
  const [command, first, second] = positionals;
  switch (command) {
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
      await operator.removeMember(required(first, "<memberId>"));
      return { removed: true };
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
    const result = await run(app.get(OperatorService), process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigValidationError || error instanceof OperatorCommandError) {
    console.error(error.message);
  } else {
    // Query errors carry bound values (phone numbers): never print those.
    console.error(`Operator command failed: ${describeError(withoutQueryParameters(error))}`);
  }
  process.exitCode = 1;
});

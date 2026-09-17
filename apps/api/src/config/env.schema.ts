import type { LoginCodeChannel } from "@adclub/contracts";
import { isValidAppVersion } from "@adclub/domain";
import { z } from "zod";
import {
  MonitoringDsnError,
  parseMonitoringDsn,
  type MonitoringTarget,
} from "../observability/monitoring-dsn";

const urlWithProtocol = (protocols: string[]) =>
  z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: `Must be a URL with protocol ${protocols.join(" or ")}` },
    );

export const logLevels = ["error", "warn", "log", "debug", "verbose"] as const;
export type LogLevel = (typeof logLevels)[number];

const nodeEnvs = ["development", "test", "staging", "production"] as const;
export type NodeEnv = (typeof nodeEnvs)[number];

/**
 * The admin panel version the development checkout serves
 * (`apps/admin-web/package.json`; `env.schema.test.ts` keeps them equal).
 */
export const DEV_ADMIN_WEB_RELEASE_VERSION = "0.1.0";

/**
 * Former environment variables whose values are settings now (TASK-007,
 * ARCHITECTURE 4.11). Still present in an environment, they are ignored —
 * `loadConfig` reports them so nobody believes they still apply.
 */
const SETTINGS_FORMERLY_IN_ENVIRONMENT = [
  /^CLIENT_MIN_VERSION_/,
  /^CLIENT_UPDATE_MESSAGE_/,
  /^LOGIN_CODE_(LENGTH|TTL_SECONDS|MAX_ATTEMPTS|RESEND_INTERVAL_SECONDS|VERIFY_|REQUESTS_|VERIFICATIONS_|SMS_)/,
  /^SESSION_(ACCESS_TOKEN_TTL_SECONDS|MOBILE_TTL_SECONDS|SUPPLIER_WEB_TTL_SECONDS|ADMIN_WEB_TTL_SECONDS|REFRESH_)/,
  /^SIGN_IN_/,
  /^ADMIN_TOTP_(ALLOWED_DRIFT_STEPS|VERIFY_)/,
  /^ADMIN_BACKUP_CODE_COUNT$/,
];

/**
 * Where login codes are sent from. Only `test` exists today (in-process
 * stand-ins for WhatsApp and SMS, TASK-004); the real providers arrive in
 * TASK-026. `test` is refused in production.
 */
export const loginCodeChannelProviders = ["test"] as const;
export type LoginCodeChannelProvider = (typeof loginCodeChannelProviders)[number];

const loginCodeChannelList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(z.enum(["whatsapp", "sms"])));

/**
 * Used only when no secret is configured in development and tests, so a
 * fresh checkout runs without extra setup. Every other environment must
 * set `LOGIN_CODE_HASH_SECRET`.
 */
const DEV_LOGIN_CODE_HASH_SECRET = "adclub-dev-only-login-code-hash-secret";

/**
 * Signs access tokens and derives refresh tokens. Development and tests
 * only, like the login code secret above.
 */
const DEV_SESSION_TOKEN_SECRET = "adclub-dev-only-session-token-secret-value";

/**
 * Encrypts administrators' TOTP secrets and keys the backup code hashes.
 * Development and tests only, like the secrets above.
 */
const DEV_ADMIN_TOTP_ENCRYPTION_KEY = "adclub-dev-only-admin-totp-encryption-key";

/** Web client origins the Vite dev servers run on (apps/*-web/vite.config.ts). */
const DEV_SUPPLIER_WEB_ORIGINS = "http://localhost:5175,http://127.0.0.1:5175";
const DEV_ADMIN_WEB_ORIGINS = "http://localhost:5174,http://127.0.0.1:5174";

/**
 * A comma-separated list of browser origins (`https://cabinet.example.kz`,
 * scheme + host + optional port, nothing else). Unset: `undefined`, so the
 * per-environment default applies.
 */
const originList = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
  )
  .pipe(
    z
      .array(
        z.string().refine(
          (value) => {
            try {
              const url = new URL(value);
              return (
                (url.protocol === "http:" || url.protocol === "https:") && url.origin === value
              );
            } catch {
              return false;
            }
          },
          { message: "Must be an origin like https://cabinet.example.kz (no path, no trailing /)" },
        ),
      )
      .optional(),
  );

/**
 * Raw environment schema, keyed by the actual `.env` variable names.
 * Kept separate from `AppConfig` so validation errors report the variable
 * name a developer actually needs to set.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(nodeEnvs).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(logLevels).default("log"),

  DATABASE_URL: urlWithProtocol(["postgres:", "postgresql:"]),

  REDIS_URL: urlWithProtocol(["redis:", "rediss:"]),

  S3_ENDPOINT: urlWithProtocol(["http:", "https:"]),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),

  // The admin panel version this deployment serves (a release fact, not a
  // setting): the admin panel minimum version can't go above it (SCREENS
  // A-SET-02). Required outside development/test.
  ADMIN_WEB_RELEASE_VERSION: z
    .string()
    .refine(isValidAppVersion, { message: "Must be a MAJOR.MINOR.PATCH version, e.g. 1.4.0" })
    .optional(),
  // Express `trust proxy`: how many reverse proxies (or which addresses) to
  // trust for the client IP in X-Forwarded-For. Rate limits by IP depend on
  // it behind a proxy. `false` (default): the socket address is the client.
  TRUST_PROXY: z
    .string()
    .trim()
    .default("false")
    .transform((value): boolean | number | string => {
      if (value === "false" || value === "") return false;
      if (value === "true") return true;
      return /^\d+$/.test(value) ? Number(value) : value;
    }),
  // Login codes (ARCHITECTURE 8.1, 14; TASK-004).
  LOGIN_CODE_CHANNELS: z.enum(loginCodeChannelProviders).default("test"),
  LOGIN_CODE_TEST_FAILING_CHANNELS: loginCodeChannelList,
  LOGIN_CODE_DEV_OUTBOX: z.stringbool().optional(),
  LOGIN_CODE_HASH_SECRET: z.string().min(32).optional(),
  // Browser origins of the web clients (CORS, cookie session checks; TASK-005).
  SUPPLIER_WEB_ORIGINS: originList,
  ADMIN_WEB_ORIGINS: originList,
  // Sessions (ARCHITECTURE 8.2, 14; TASK-005).
  SESSION_TOKEN_SECRET: z.string().min(32).optional(),
  // Roles, cabinet and admin sign-in (ARCHITECTURE 8.1, 8.3, 14; TASK-006).
  ADMIN_TOTP_ENCRYPTION_KEY: z.string().min(32).optional(),
  // Observability (ARCHITECTURE 15.3, 4.13; TASK-009). Where error events
  // go (a Sentry-compatible receiver, self-hosted or SaaS); unset — nothing
  // is sent and the application behaves as before. Real accounts: TASK-055.
  MONITORING_DSN: z.string().trim().optional(),
  // Which deployment an event came from; default: NODE_ENV.
  MONITORING_ENVIRONMENT: z.string().trim().min(1).optional(),
  // Publish GET /metrics (Prometheus text format).
  METRICS_ENABLED: z.stringbool().optional(),
  // When set, the collector must present it: `Authorization: Bearer <token>`.
  METRICS_TOKEN: z.string().min(16).optional(),
});

export interface RateLimitSettings {
  max: number;
  windowSeconds: number;
}

export type AppConfig = {
  nodeEnv: NodeEnv;
  port: number;
  logLevel: LogLevel;
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  storage: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region: string;
  };
  adminWeb: {
    /** The admin panel version this deployment serves. */
    releaseVersion: string;
  };
  http: {
    trustProxy: boolean | number | string;
    /** Browser origins allowed to call the API (CORS) and to use cookie sessions. */
    webOrigins: {
      supplierWeb: string[];
      adminWeb: string[];
    };
  };
  loginCode: {
    channels: LoginCodeChannelProvider;
    /** `test` channels only: channels that report a delivery failure. */
    testFailingChannels: LoginCodeChannel[];
    /** Serve sent codes at `GET /dev/login-codes` (never in production). */
    devOutbox: boolean;
    hashSecret: string;
  };
  session: {
    /** HMAC key of access tokens and refresh tokens. */
    tokenSecret: string;
  };
  signIn: {
    /** AES-256-GCM key material of TOTP secrets, also keys the backup code hashes. */
    totpEncryptionKey: string;
  };
  monitoring: {
    /** Where error events go; `undefined` — reporting is off. */
    target: MonitoringTarget | undefined;
    /** The deployment an event is tagged with. */
    environment: string;
  };
  metrics: {
    /** Serve `GET /metrics`. */
    enabled: boolean;
    /** Bearer token the collector must present; `undefined` — no token needed. */
    token: string | undefined;
  };
  /**
   * Variables present in the environment that used to hold what are
   * settings now; they have no effect (`main.ts`, `worker.ts` warn).
   */
  ignoredVariables: string[];
};

export class ConfigValidationError extends Error {
  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigValidationError";
  }
}

/**
 * Parses and validates `process.env` (or an injected map, for tests) into
 * a typed `AppConfig`. Throws `ConfigValidationError` — listing which
 * variables are missing or malformed, never their values — if validation
 * fails, so the process can exit with a readable message instead of a
 * dependency crashing later with a confusing error. Product thresholds are
 * not configuration: they are settings (ARCHITECTURE 14, 4.11).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigValidationError(issues);
  }

  const parsed = result.data;

  const isLocal = parsed.NODE_ENV === "development" || parsed.NODE_ENV === "test";
  const devOutbox = parsed.LOGIN_CODE_DEV_OUTBOX ?? isLocal;
  // Production must never run with stand-in channels (nobody would get a
  // code) or with a way to read codes without owning the phone.
  const environmentIssues: string[] = [];
  if (parsed.NODE_ENV === "production" && parsed.LOGIN_CODE_CHANNELS === "test") {
    environmentIssues.push(
      "LOGIN_CODE_CHANNELS: test channels are not allowed when NODE_ENV=production",
    );
  }
  if (parsed.NODE_ENV === "production" && devOutbox) {
    environmentIssues.push(
      "LOGIN_CODE_DEV_OUTBOX: the dev code outbox is not allowed when NODE_ENV=production",
    );
  }
  for (const name of [
    "LOGIN_CODE_HASH_SECRET",
    "SESSION_TOKEN_SECRET",
    "ADMIN_TOTP_ENCRYPTION_KEY",
    "ADMIN_WEB_RELEASE_VERSION",
  ] as const) {
    if (!isLocal && !parsed[name]) {
      environmentIssues.push(`${name}: required when NODE_ENV=${parsed.NODE_ENV}`);
    }
  }
  let monitoringTarget: MonitoringTarget | undefined;
  if (parsed.MONITORING_DSN) {
    try {
      monitoringTarget = parseMonitoringDsn(parsed.MONITORING_DSN);
    } catch (error) {
      environmentIssues.push(
        `MONITORING_DSN: ${error instanceof MonitoringDsnError ? error.message : "invalid"}`,
      );
    }
  }
  if (environmentIssues.length > 0) {
    throw new ConfigValidationError(environmentIssues);
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    database: {
      url: parsed.DATABASE_URL,
    },
    redis: {
      url: parsed.REDIS_URL,
    },
    storage: {
      endpoint: parsed.S3_ENDPOINT,
      accessKey: parsed.S3_ACCESS_KEY,
      secretKey: parsed.S3_SECRET_KEY,
      bucket: parsed.S3_BUCKET,
      region: parsed.S3_REGION,
    },
    adminWeb: {
      releaseVersion: parsed.ADMIN_WEB_RELEASE_VERSION ?? DEV_ADMIN_WEB_RELEASE_VERSION,
    },
    http: {
      trustProxy: parsed.TRUST_PROXY,
      // No browser origin is trusted outside development unless configured.
      webOrigins: {
        supplierWeb:
          parsed.SUPPLIER_WEB_ORIGINS ?? (isLocal ? DEV_SUPPLIER_WEB_ORIGINS.split(",") : []),
        adminWeb: parsed.ADMIN_WEB_ORIGINS ?? (isLocal ? DEV_ADMIN_WEB_ORIGINS.split(",") : []),
      },
    },
    loginCode: {
      channels: parsed.LOGIN_CODE_CHANNELS,
      testFailingChannels: parsed.LOGIN_CODE_TEST_FAILING_CHANNELS,
      devOutbox,
      hashSecret: parsed.LOGIN_CODE_HASH_SECRET ?? DEV_LOGIN_CODE_HASH_SECRET,
    },
    session: {
      tokenSecret: parsed.SESSION_TOKEN_SECRET ?? DEV_SESSION_TOKEN_SECRET,
    },
    signIn: {
      totpEncryptionKey: parsed.ADMIN_TOTP_ENCRYPTION_KEY ?? DEV_ADMIN_TOTP_ENCRYPTION_KEY,
    },
    monitoring: {
      target: monitoringTarget,
      environment: parsed.MONITORING_ENVIRONMENT ?? parsed.NODE_ENV,
    },
    metrics: {
      enabled: parsed.METRICS_ENABLED ?? true,
      token: parsed.METRICS_TOKEN,
    },
    ignoredVariables: Object.keys(env)
      .filter((name) => SETTINGS_FORMERLY_IN_ENVIRONMENT.some((pattern) => pattern.test(name)))
      .sort(),
  };
}

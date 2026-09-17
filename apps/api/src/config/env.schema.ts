import type { ClientPlatform, LoginCodeChannel } from "@adclub/contracts";
import { isValidAppVersion } from "@adclub/domain";
import type { Lang } from "@adclub/i18n";
import { z } from "zod";

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

const minClientVersion = z
  .string()
  .refine(isValidAppVersion, { message: "Must be a MAJOR.MINOR.PATCH version, e.g. 1.4.0" })
  .default("0.0.0");

/**
 * Default "update required" texts (ARCHITECTURE 7.4). Overridable per
 * language from the environment until they move to the settings table
 * (TASK-007), together with the minimum versions above.
 */
export const defaultClientUpdateMessages: Record<Lang, string> = {
  ru: "Эта версия приложения больше не поддерживается. Обновите приложение, чтобы продолжить.",
  kk: "Қосымшаның бұл нұсқасына қолдау көрсетілмейді. Жалғастыру үшін қосымшаны жаңартыңыз.",
  en: "This version of the app is no longer supported. Please update the app to continue.",
};

const positiveInt = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

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

  CLIENT_MIN_VERSION_IOS: minClientVersion,
  CLIENT_MIN_VERSION_ANDROID: minClientVersion,
  CLIENT_MIN_VERSION_SUPPLIER_WEB: minClientVersion,
  CLIENT_MIN_VERSION_ADMIN_WEB: minClientVersion,
  CLIENT_UPDATE_MESSAGE_RU: z.string().trim().min(1).default(defaultClientUpdateMessages.ru),
  CLIENT_UPDATE_MESSAGE_KK: z.string().trim().min(1).default(defaultClientUpdateMessages.kk),
  CLIENT_UPDATE_MESSAGE_EN: z.string().trim().min(1).default(defaultClientUpdateMessages.en),
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
  LOGIN_CODE_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  LOGIN_CODE_TTL_SECONDS: positiveInt(300),
  LOGIN_CODE_MAX_ATTEMPTS: positiveInt(5),
  LOGIN_CODE_RESEND_INTERVAL_SECONDS: positiveInt(60),
  LOGIN_CODE_VERIFY_FREE_FAILURES: z.coerce.number().int().min(0).default(2),
  LOGIN_CODE_VERIFY_DELAY_BASE_SECONDS: positiveInt(2),
  LOGIN_CODE_REQUESTS_PER_PHONE: positiveInt(5),
  LOGIN_CODE_REQUESTS_PER_PHONE_WINDOW_SECONDS: positiveInt(3600),
  LOGIN_CODE_REQUESTS_PER_IP: positiveInt(30),
  LOGIN_CODE_REQUESTS_PER_IP_WINDOW_SECONDS: positiveInt(3600),
  LOGIN_CODE_VERIFICATIONS_PER_PHONE: positiveInt(15),
  LOGIN_CODE_VERIFICATIONS_PER_PHONE_WINDOW_SECONDS: positiveInt(3600),
  LOGIN_CODE_SMS_PER_PHONE_DAILY: positiveInt(5),
  LOGIN_CODE_SMS_PER_IP_DAILY: positiveInt(10),
});

const DAY_SECONDS = 24 * 60 * 60;

export interface RateLimitSettings {
  max: number;
  windowSeconds: number;
}

/**
 * Login code thresholds (ARCHITECTURE 8.1, 14), read through
 * `LoginCodeSettingsSource` — the replacement point for the settings
 * table (TASK-007).
 */
export interface LoginCodeSettings {
  codeLength: number;
  ttlSeconds: number;
  /** Wrong entries a single code survives; the last one invalidates it. */
  maxAttempts: number;
  /** Minimum time between two codes for one number, whatever the channel. */
  resendIntervalSeconds: number;
  /** Wrong entries allowed without any delay before the next try. */
  verifyFreeFailures: number;
  /** Delay after the first delayed failure; doubles with each next one. */
  verifyDelayBaseSeconds: number;
  requestsPerPhone: RateLimitSettings;
  requestsPerIp: RateLimitSettings;
  verificationsPerPhone: RateLimitSettings;
  smsPerPhoneDaily: RateLimitSettings;
  smsPerIpDaily: RateLimitSettings;
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
  clientPolicy: {
    minSupportedVersions: Record<ClientPlatform, string>;
    updateMessage: Record<Lang, string>;
  };
  http: {
    trustProxy: boolean | number | string;
  };
  loginCode: {
    channels: LoginCodeChannelProvider;
    /** `test` channels only: channels that report a delivery failure. */
    testFailingChannels: LoginCodeChannel[];
    /** Serve sent codes at `GET /dev/login-codes` (never in production). */
    devOutbox: boolean;
    hashSecret: string;
    settings: LoginCodeSettings;
  };
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
 * dependency crashing later with a confusing error.
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
  if (!isLocal && !parsed.LOGIN_CODE_HASH_SECRET) {
    environmentIssues.push(`LOGIN_CODE_HASH_SECRET: required when NODE_ENV=${parsed.NODE_ENV}`);
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
    clientPolicy: {
      minSupportedVersions: {
        ios: parsed.CLIENT_MIN_VERSION_IOS,
        android: parsed.CLIENT_MIN_VERSION_ANDROID,
        "supplier-web": parsed.CLIENT_MIN_VERSION_SUPPLIER_WEB,
        "admin-web": parsed.CLIENT_MIN_VERSION_ADMIN_WEB,
      },
      updateMessage: {
        ru: parsed.CLIENT_UPDATE_MESSAGE_RU,
        kk: parsed.CLIENT_UPDATE_MESSAGE_KK,
        en: parsed.CLIENT_UPDATE_MESSAGE_EN,
      },
    },
    http: {
      trustProxy: parsed.TRUST_PROXY,
    },
    loginCode: {
      channels: parsed.LOGIN_CODE_CHANNELS,
      testFailingChannels: parsed.LOGIN_CODE_TEST_FAILING_CHANNELS,
      devOutbox,
      hashSecret: parsed.LOGIN_CODE_HASH_SECRET ?? DEV_LOGIN_CODE_HASH_SECRET,
      settings: {
        codeLength: parsed.LOGIN_CODE_LENGTH,
        ttlSeconds: parsed.LOGIN_CODE_TTL_SECONDS,
        maxAttempts: parsed.LOGIN_CODE_MAX_ATTEMPTS,
        resendIntervalSeconds: parsed.LOGIN_CODE_RESEND_INTERVAL_SECONDS,
        verifyFreeFailures: parsed.LOGIN_CODE_VERIFY_FREE_FAILURES,
        verifyDelayBaseSeconds: parsed.LOGIN_CODE_VERIFY_DELAY_BASE_SECONDS,
        requestsPerPhone: {
          max: parsed.LOGIN_CODE_REQUESTS_PER_PHONE,
          windowSeconds: parsed.LOGIN_CODE_REQUESTS_PER_PHONE_WINDOW_SECONDS,
        },
        requestsPerIp: {
          max: parsed.LOGIN_CODE_REQUESTS_PER_IP,
          windowSeconds: parsed.LOGIN_CODE_REQUESTS_PER_IP_WINDOW_SECONDS,
        },
        verificationsPerPhone: {
          max: parsed.LOGIN_CODE_VERIFICATIONS_PER_PHONE,
          windowSeconds: parsed.LOGIN_CODE_VERIFICATIONS_PER_PHONE_WINDOW_SECONDS,
        },
        smsPerPhoneDaily: {
          max: parsed.LOGIN_CODE_SMS_PER_PHONE_DAILY,
          windowSeconds: DAY_SECONDS,
        },
        smsPerIpDaily: { max: parsed.LOGIN_CODE_SMS_PER_IP_DAILY, windowSeconds: DAY_SECONDS },
      },
    },
  };
}

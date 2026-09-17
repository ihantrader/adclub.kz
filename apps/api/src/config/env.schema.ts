import type { ClientPlatform, LoginCodeChannel, SessionKind } from "@adclub/contracts";
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
 * Admin sessions never move past sign-in + lifetime (unlike mobile and
 * supplier-web, which slide on refresh) — a hard cap on how long a stolen
 * admin token stays usable (business rule, TASK-005.A). No configuration
 * may raise it past 12 hours.
 */
const ADMIN_WEB_MAX_TTL_SECONDS = 12 * 60 * 60;
/**
 * The longest an unfinished sign-in may stay open (ARCHITECTURE 4.9):
 * enough to install an authenticator app, short enough that a leaked
 * step is worthless soon.
 */
const SIGN_IN_STEP_MAX_TTL_SECONDS = 30 * 60;

const signInStepTtl = (defaultValue: number) =>
  z.coerce
    .number()
    .int()
    .positive()
    .max(SIGN_IN_STEP_MAX_TTL_SECONDS, {
      message: `Must be at most ${SIGN_IN_STEP_MAX_TTL_SECONDS} (30 minutes) — an unfinished sign-in never stays open longer`,
    })
    .default(defaultValue);

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
  // Browser origins of the web clients (CORS, cookie session checks; TASK-005).
  SUPPLIER_WEB_ORIGINS: originList,
  ADMIN_WEB_ORIGINS: originList,
  // Sessions (ARCHITECTURE 8.2, 14; TASK-005).
  SESSION_TOKEN_SECRET: z.string().min(32).optional(),
  SESSION_ACCESS_TOKEN_TTL_SECONDS: positiveInt(900),
  SESSION_MOBILE_TTL_SECONDS: positiveInt(90 * 24 * 60 * 60),
  SESSION_SUPPLIER_WEB_TTL_SECONDS: positiveInt(180 * 24 * 60 * 60),
  SESSION_ADMIN_WEB_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(ADMIN_WEB_MAX_TTL_SECONDS, {
      message: `Must be at most ${ADMIN_WEB_MAX_TTL_SECONDS} (12 hours) — admin sessions never live longer`,
    })
    .default(ADMIN_WEB_MAX_TTL_SECONDS),
  SESSION_REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).default(60),
  SESSION_REFRESH_PER_SESSION: positiveInt(30),
  SESSION_REFRESH_PER_SESSION_WINDOW_SECONDS: positiveInt(3600),
  SESSION_REFRESH_PER_IP: positiveInt(600),
  SESSION_REFRESH_PER_IP_WINDOW_SECONDS: positiveInt(3600),
  // Roles, cabinet and admin sign-in (ARCHITECTURE 8.1, 8.3, 14; TASK-006).
  SIGN_IN_SUPPLIER_SELECTION_TTL_SECONDS: signInStepTtl(600),
  SIGN_IN_ADMIN_TOTP_TTL_SECONDS: signInStepTtl(600),
  ADMIN_TOTP_ENCRYPTION_KEY: z.string().min(32).optional(),
  ADMIN_TOTP_ALLOWED_DRIFT_STEPS: z.coerce.number().int().min(0).max(5).default(1),
  ADMIN_BACKUP_CODE_COUNT: z.coerce.number().int().min(1).max(50).default(10),
  ADMIN_TOTP_VERIFY_PER_ADMIN: positiveInt(5),
  ADMIN_TOTP_VERIFY_PER_ADMIN_WINDOW_SECONDS: positiveInt(900),
  ADMIN_TOTP_VERIFY_PER_IP: positiveInt(20),
  ADMIN_TOTP_VERIFY_PER_IP_WINDOW_SECONDS: positiveInt(900),
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

/**
 * Session lifetimes and refresh thresholds (ARCHITECTURE 8.2, 14), read
 * through `SessionSettingsSource` — the replacement point for the settings
 * table (TASK-007).
 */
export interface SessionSettings {
  accessTokenTtlSeconds: number;
  /**
   * Session lifetime per kind. `mobile` and `supplier_web` slide: every
   * refresh moves the end to now + lifetime. `admin_web` never moves past
   * sign-in + lifetime.
   */
  ttlSeconds: Record<SessionKind, number>;
  /**
   * How long after a refresh the token it replaced still returns the same
   * new pair (a retried or concurrent refresh by the same client) instead
   * of counting as reuse.
   */
  refreshReuseGraceSeconds: number;
  refreshPerSession: RateLimitSettings;
  refreshPerIp: RateLimitSettings;
}

/**
 * Thresholds of the cabinet and admin sign-in steps (ARCHITECTURE 8.1,
 * 14), read through `SignInSettingsSource` — the replacement point for
 * the settings table (TASK-007).
 */
export interface SignInSettings {
  /** How long a started company choice stays usable. */
  supplierSelectionTtlSeconds: number;
  /** How long an admin sign-in may wait for the second factor (setup included). */
  adminTotpTtlSeconds: number;
  /** Authenticator codes this many 30-second steps early or late are accepted. */
  totpAllowedDriftSteps: number;
  /** Backup codes in one set. */
  backupCodeCount: number;
  /** Second factor checks (right or wrong) per administrator. */
  totpVerifyPerAdmin: RateLimitSettings;
  /** Second factor checks per client address. */
  totpVerifyPerIp: RateLimitSettings;
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
    settings: LoginCodeSettings;
  };
  session: {
    /** HMAC key of access tokens and refresh tokens. */
    tokenSecret: string;
    settings: SessionSettings;
  };
  signIn: {
    /** AES-256-GCM key material of TOTP secrets, also keys the backup code hashes. */
    totpEncryptionKey: string;
    settings: SignInSettings;
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
  if (!isLocal && !parsed.SESSION_TOKEN_SECRET) {
    environmentIssues.push(`SESSION_TOKEN_SECRET: required when NODE_ENV=${parsed.NODE_ENV}`);
  }
  if (!isLocal && !parsed.ADMIN_TOTP_ENCRYPTION_KEY) {
    environmentIssues.push(`ADMIN_TOTP_ENCRYPTION_KEY: required when NODE_ENV=${parsed.NODE_ENV}`);
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
    session: {
      tokenSecret: parsed.SESSION_TOKEN_SECRET ?? DEV_SESSION_TOKEN_SECRET,
      settings: {
        accessTokenTtlSeconds: parsed.SESSION_ACCESS_TOKEN_TTL_SECONDS,
        ttlSeconds: {
          mobile: parsed.SESSION_MOBILE_TTL_SECONDS,
          supplier_web: parsed.SESSION_SUPPLIER_WEB_TTL_SECONDS,
          admin_web: parsed.SESSION_ADMIN_WEB_TTL_SECONDS,
        },
        refreshReuseGraceSeconds: parsed.SESSION_REFRESH_REUSE_GRACE_SECONDS,
        refreshPerSession: {
          max: parsed.SESSION_REFRESH_PER_SESSION,
          windowSeconds: parsed.SESSION_REFRESH_PER_SESSION_WINDOW_SECONDS,
        },
        refreshPerIp: {
          max: parsed.SESSION_REFRESH_PER_IP,
          windowSeconds: parsed.SESSION_REFRESH_PER_IP_WINDOW_SECONDS,
        },
      },
    },
    signIn: {
      totpEncryptionKey: parsed.ADMIN_TOTP_ENCRYPTION_KEY ?? DEV_ADMIN_TOTP_ENCRYPTION_KEY,
      settings: {
        supplierSelectionTtlSeconds: parsed.SIGN_IN_SUPPLIER_SELECTION_TTL_SECONDS,
        adminTotpTtlSeconds: parsed.SIGN_IN_ADMIN_TOTP_TTL_SECONDS,
        totpAllowedDriftSteps: parsed.ADMIN_TOTP_ALLOWED_DRIFT_STEPS,
        backupCodeCount: parsed.ADMIN_BACKUP_CODE_COUNT,
        totpVerifyPerAdmin: {
          max: parsed.ADMIN_TOTP_VERIFY_PER_ADMIN,
          windowSeconds: parsed.ADMIN_TOTP_VERIFY_PER_ADMIN_WINDOW_SECONDS,
        },
        totpVerifyPerIp: {
          max: parsed.ADMIN_TOTP_VERIFY_PER_IP,
          windowSeconds: parsed.ADMIN_TOTP_VERIFY_PER_IP_WINDOW_SECONDS,
        },
      },
    },
  };
}

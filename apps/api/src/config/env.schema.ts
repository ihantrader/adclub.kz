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

/** An unset variable and one set to whitespace mean the same: not configured. */
const blankAsUndefined = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
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
/** The public address of OpenRouter (D-055); `OPENROUTER_BASE_URL` overrides it in development. */
export const OPENROUTER_PUBLIC_URL = "https://openrouter.ai/api/v1";

/** Variables of a provider the project no longer has (TASK-053: the direct Anthropic channel). */
const REMOVED_FROM_ENVIRONMENT = [/^ANTHROPIC_API_KEY$/];

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
 * Where AI calls go (TASK-053, ARCHITECTURE 9.6, 4.20; D-055). OpenRouter
 * is the only provider of the project — one key, one account, the model of
 * every operation chosen by a setting. `openrouter` needs
 * `OPENROUTER_API_KEY`; `test` is an in-process stand-in that calls nothing
 * (development, tests and CI) and is refused in production, where its
 * made-up texts would end up in the catalog.
 */
export const aiProviders = ["test", "openrouter"] as const;
export type AiProviderName = (typeof aiProviders)[number];

/**
 * What the test AI provider does with a request (`AI_TEST_MODE`, development
 * and tests): `ok` — translates (deterministically); `unavailable` — fails
 * like an unreachable provider; `rejected` — refuses like a bad key;
 * `no_private_provider` — refuses like a model no provider serves without
 * storing the request (D-057); `slow` — answers after a delay;
 * `incomplete` — leaves the last text of the batch out, like a provider
 * that answered only partly; `no_cost` — answers without saying what the
 * call cost; `empty`, `too_long`, `control_characters`, `wrong_language` —
 * answers with a text the checks refuse; `unreadable`, `other_document` —
 * reads every photo of a registration certificate as unreadable or as
 * another document (TASK-057; otherwise the synthetic samples are read by
 * their control strip, `test-vehicle-documents.ts`).
 */
/**
 * Where messages to suppliers are sent from (TASK-024, ARCHITECTURE 9.1,
 * 4.35). `whatsapp_cloud` is Meta's WhatsApp Cloud API and needs the
 * access token, the phone number id and the app secret; `test` is an
 * in-process stand-in that sends nothing (development, tests and CI) and
 * is refused in production, where nobody would get a message.
 */
export const messageProviders = ["test", "whatsapp_cloud"] as const;

/**
 * Where photos of items are searched (TASK-068, ARCHITECTURE 9.7, 4.95):
 * `serpapi` — SerpAPI (Google Images), needs `SERPAPI_API_KEY`; `test` —
 * the fixtures of `apps/api/fixtures/photo-search`, no network (development,
 * tests and CI). Outside development and tests `test` means **no search**:
 * the button answers «поиск не настроен» and the job does nothing.
 * `IMAGE_SEARCH_TEST_MODE`: `ok`, or `unavailable` — the test provider fails
 * like an unreachable one.
 */
export const imageSearchProviders = ["test", "serpapi"] as const;
export const imageSearchTestModes = ["ok", "unavailable"] as const;
export type ImageSearchProviderName = (typeof imageSearchProviders)[number] | "disabled";
export type MessageProviderName = (typeof messageProviders)[number];

/**
 * What the test message channel does with a request (`MESSAGE_TEST_MODE`,
 * development and tests): `ok` — accepts it and keeps it for
 * `GET /dev/messages`; `unavailable` — fails like an unreachable provider
 * (retried); `rate_limited` — like a 429 with `Retry-After` (retried);
 * `rejected` — refuses for good; `template_not_approved` — the template is
 * not approved for this language (for good); `no_whatsapp` — the number is
 * not on WhatsApp (for good, PRODUCT 15: no SMS fallback for
 * notifications); `outcome_unknown` — the request may have reached the
 * provider and nobody can tell (not retried by itself: the message is
 * `unknown` and a person decides); `slow` — answers after a delay.
 */
export const messageTestModes = [
  "ok",
  "unavailable",
  "rate_limited",
  "rejected",
  "template_not_approved",
  "no_whatsapp",
  "outcome_unknown",
  "slow",
] as const;
export type MessageTestMode = (typeof messageTestModes)[number];

/**
 * Where push notifications to the user go (TASK-051, ARCHITECTURE 9.3,
 * 4.79, 4.81). `live` sends for real by the device's platform — Android
 * through Firebase Cloud Messaging HTTP v1 (`FCM_*`), iOS straight to APNs
 * (`APNS_*`, TASK-056) — and needs both; `test` is an in-process stand-in
 * that sends nothing (development, tests and CI), refused in production.
 * TASK-051's `fcm` is refused with the new name: it sent iOS through FCM,
 * which an iPhone's APNs token cannot take (I866).
 */
export const pushProviders = ["test", "live"] as const;
export type PushProviderName = (typeof pushProviders)[number];

/** The APNs environment the server sends to: `sandbox` — development builds only. */
export const apnsEnvironments = ["sandbox", "production"] as const;

/**
 * What the test push provider does (`PUSH_TEST_MODE`): `ok` — accepts and
 * keeps it for `GET /dev/pushes`; `unavailable` — fails like an unreachable
 * provider (retried); `rejected` — refuses for good; `invalid_token` — the
 * token is dead (the device is taken off push); `unknown` — the request may
 * have reached the provider (not retried by itself); `slow` — answers after
 * a delay.
 */
export const pushTestModes = [
  "ok",
  "unavailable",
  "rejected",
  "invalid_token",
  "unknown",
  "slow",
] as const;
export type PushTestMode = (typeof pushTestModes)[number];

/** Where FCM HTTP v1 and Google's token endpoint are. */
export const FCM_PUBLIC_URL = "https://fcm.googleapis.com";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The environments of the App Store (TASK-041): where a purchase was made. */
export const appleEnvironments = ["production", "sandbox"] as const;
export type AppleEnvironment = (typeof appleEnvironments)[number];

/** The App Store Server API (Apple's documentation, 2026). */
export const APPLE_API_URLS: Record<AppleEnvironment, string> = {
  production: "https://api.storekit.apple.com",
  sandbox: "https://api.storekit-sandbox.apple.com",
};
export const GOOGLE_PLAY_API_URL = "https://androidpublisher.googleapis.com";
/** Google's keys that sign the OIDC tokens of Pub/Sub push. */
export const GOOGLE_OIDC_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/**
 * The stand-ins of development and tests (TASK-041): the bundle and the
 * package the dev command and the tests sign for, the audience and the
 * sender of the imitated Pub/Sub push.
 */
export const DEV_STORE_APP_ID = "kz.adclub.app";
export const DEV_PUBSUB_AUDIENCE = "https://adclub.local/webhooks/stores/google";
export const DEV_PUBSUB_SERVICE_ACCOUNT = "pubsub-dev@adclub-dev.iam.gserviceaccount.com";

/** What a deployment knows about the App Store (TASK-041, ARCHITECTURE 4.98). */
export interface AppleStoreConfig {
  /** Every variable of the set is given. */
  configured: boolean;
  bundleId: string;
  /** Checked against notifications from production; `null` — not known (development). */
  appAppleId: number | null;
  /** Where purchases and notifications may come from. */
  environments: AppleEnvironment[];
  /** The App Store Server API key; `null` — no API calls (the store answers «unavailable»). */
  api: { issuerId: string; keyId: string; privateKey: string } | null;
  apiUrls: Record<AppleEnvironment, string>;
  /** Trust the local development chain beside Apple's root (development and tests only). */
  devTrust: boolean;
}

/** What a deployment knows about Google Play (TASK-041, ARCHITECTURE 4.98). */
export interface GoogleStoreConfig {
  configured: boolean;
  packageName: string;
  /** The service account of the Play Developer API; `null` — no API calls. */
  api: { clientEmail: string; privateKey: string; tokenUrl: string } | null;
  apiUrl: string;
  /** Whose OIDC token a Pub/Sub push must carry; `null` — no push is accepted. */
  pubsub: { audience: string; serviceAccount: string } | null;
  certsUrl: string;
  /** Accept the local development key of OIDC tokens (development and tests only). */
  devTrust: boolean;
}

/**
 * Where a supplier's card subscription is charged (TASK-042, ARCHITECTURE
 * 9.4.2, 4.77). `card_kz` is the card processor of Kazakhstan (Freedom Pay or
 * CloudPayments KZ) and has no implementation yet — no contract, no API
 * access; `test` is an in-process stand-in that charges nothing (development,
 * tests and CI), refused in production.
 */
export const paymentProviders = ["test", "card_kz"] as const;
export type PaymentProviderConfigName = (typeof paymentProviders)[number];

/**
 * What the test payment provider does with a charge (`PAYMENT_TEST_MODE`,
 * development and tests): `ok` — the card of the page decides; `unavailable`
 * — every call fails as an unreachable provider (retried in an hour, no
 * notice to the payer); `outcome_unknown` — a charge goes through at the
 * provider and the answer is lost (looked up by its key before anything is
 * sent again); `declined` — every charge is refused for lack of funds;
 * `slow` — answers after a delay.
 */
export const paymentTestModes = [
  "ok",
  "unavailable",
  "outcome_unknown",
  "declined",
  "slow",
] as const;
export type PaymentTestMode = (typeof paymentTestModes)[number];

/**
 * Seals the cards' tokens in development and tests only; a constant anybody
 * can read in this repository, so never the key of a deployed environment.
 */
const DEV_PAYMENT_TOKEN_ENCRYPTION_KEY = "adclub-dev-only-payment-token-encryption-key";

/** Signs and checks the test payment provider's webhook in development and tests. */
const DEV_PAYMENT_WEBHOOK_SECRET = "adclub-dev-only-payment-webhook-secret";

/** The Cloud API version the real channel calls (Meta keeps versions ~2 years). */
export const WHATSAPP_API_VERSION = "v21.0";
/** Where the Cloud API is; only development points this elsewhere. */
export const WHATSAPP_PUBLIC_URL = "https://graph.facebook.com";

/**
 * Signs and checks the provider's webhook in development and tests only, so
 * a signed webhook can be tried without a Meta account. It is a constant
 * anybody can read in this repository, so it is never the secret of a
 * deployed environment: elsewhere an unset `WHATSAPP_APP_SECRET` means no
 * webhook is accepted at all (`appSecret` is `undefined`).
 */
const DEV_WHATSAPP_APP_SECRET = "adclub-dev-only-whatsapp-app-secret";

/** The token Meta echoes when the webhook subscription is confirmed (development default). */
const DEV_WHATSAPP_WEBHOOK_VERIFY_TOKEN = "adclub-dev-only-webhook-verify-token";

export const aiTestModes = [
  "ok",
  "unavailable",
  "rejected",
  "no_private_provider",
  "slow",
  "incomplete",
  "no_cost",
  "empty",
  "too_long",
  "control_characters",
  "wrong_language",
  // Reading a registration certificate (TASK-057): every photo is unreadable,
  // or every photo is some other document.
  "unreadable",
  "other_document",
  // The dashboard and a part (TASK-058): every photo of a dashboard is not
  // one; no article on any label. `unreadable` above reads every photo of
  // the three as unreadable.
  "not_dashboard",
  "no_article",
  // A draft maintenance plan (TASK-061): an answer of another shape.
  "invalid_output",
] as const;
export type AiTestMode = (typeof aiTestModes)[number];

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
  // Publish GET /metrics (Prometheus text format). Default: on in
  // development and test; elsewhere on only with METRICS_TOKEN — and
  // METRICS_ENABLED=true without a token there refuses to start.
  METRICS_ENABLED: z.stringbool().optional(),
  // When set, the collector must present it: `Authorization: Bearer <token>`.
  METRICS_TOKEN: z.string().min(16).optional(),
  // AI (ARCHITECTURE 9.6, 4.20; TASK-053). Unset provider: `openrouter`
  // when a key is set, `test` otherwise. An empty variable counts as unset.
  AI_PROVIDER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(aiProviders).optional(),
  ),
  OPENROUTER_API_KEY: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(10).optional(),
  ),
  // Where OpenRouter is; only development changes it (an unreachable
  // address, to see the retries of translation without touching the network).
  OPENROUTER_BASE_URL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.url().optional(),
  ),
  AI_TEST_MODE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(aiTestModes).default("ok"),
  ),
  // Messages to suppliers (ARCHITECTURE 9.1, 4.35; TASK-024). Unset
  // provider: `whatsapp_cloud` when the channel is fully configured,
  // `test` otherwise. An empty variable counts as unset.
  MESSAGE_PROVIDER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(messageProviders).optional(),
  ),
  MESSAGE_TEST_MODE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(messageTestModes).default("ok"),
  ),
  // The permanent access token of the system user of the WhatsApp Business
  // account; the id of the sending phone number.
  WHATSAPP_ACCESS_TOKEN: blankAsUndefined(z.string().trim().min(20)),
  WHATSAPP_PHONE_NUMBER_ID: blankAsUndefined(
    z
      .string()
      .trim()
      .regex(/^\d{5,25}$/),
  ),
  // The Meta app secret: the webhook signature (`X-Hub-Signature-256`) is
  // checked with it, so without it no provider event is ever applied.
  WHATSAPP_APP_SECRET: blankAsUndefined(z.string().trim().min(16)),
  // The token echoed back when Meta confirms the webhook subscription.
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: blankAsUndefined(z.string().trim().min(16)),
  // Where the Cloud API is; development only (an address nothing answers
  // at, to watch retries and the dead letter queue without the network).
  WHATSAPP_API_BASE_URL: blankAsUndefined(z.url()),
  // Push to the user (ARCHITECTURE 9.3, 4.79, 4.81; TASK-051, TASK-056).
  // Unset provider: `live` when both FCM and APNs are fully given, `test`
  // otherwise.
  PUSH_PROVIDER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .enum(pushProviders, {
        error: (issue) =>
          issue.input === "fcm"
            ? "PUSH_PROVIDER=fcm was renamed to live (TASK-056): iOS now goes to APNs, so APNS_* are needed too"
            : undefined,
      })
      .optional(),
  ),
  PUSH_TEST_MODE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(pushTestModes).default("ok"),
  ),
  // The Firebase project and its service account (the JSON key's
  // `project_id`, `client_email` and `private_key`; the key's line breaks
  // may be written as `\n`).
  FCM_PROJECT_ID: blankAsUndefined(
    z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{4,61}$/),
  ),
  FCM_CLIENT_EMAIL: blankAsUndefined(z.email()),
  FCM_PRIVATE_KEY: blankAsUndefined(z.string().trim().min(100)),
  // Where FCM is; development only.
  FCM_API_BASE_URL: blankAsUndefined(z.url()),
  // APNs for iPhones (TASK-056): the `.p8` key of the Apple Developer team
  // (its id, the team's id and the PEM, line breaks may be written as `\n`),
  // the app's bundle identifier (the `apns-topic`) and the environment —
  // `sandbox` reaches development builds only, TestFlight and the store need
  // `production`.
  APNS_KEY_ID: blankAsUndefined(
    z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{10}$/),
  ),
  APNS_TEAM_ID: blankAsUndefined(
    z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{10}$/),
  ),
  APNS_PRIVATE_KEY: blankAsUndefined(z.string().trim().min(100)),
  APNS_BUNDLE_ID: blankAsUndefined(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/),
  ),
  APNS_ENVIRONMENT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(apnsEnvironments).optional(),
  ),
  // Where APNs is; development only (a local HTTP/2 server).
  APNS_API_URL: blankAsUndefined(z.url()),
  // A user's subscription through the stores (ARCHITECTURE 9.4.1, 4.98;
  // TASK-041). Each store is all or nothing: a part of a set refuses to
  // start. Without a set the store's routes answer «unavailable» (production
  // starts, a signal tells the administrator what is missing).
  // App Store: the app's bundle id and its Apple ID (numeric, App Store
  // Connect → App Information), the environment notifications and
  // transactions must come from, and the App Store Server API key (Users and
  // Access → Integrations → In-App Purchase: issuer id, key id, the `.p8` PEM,
  // line breaks may be written as `\n`).
  APPLE_BUNDLE_ID: blankAsUndefined(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/),
  ),
  APPLE_APP_APPLE_ID: blankAsUndefined(
    z
      .string()
      .trim()
      .regex(/^\d{1,15}$/),
  ),
  APPLE_ENVIRONMENT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(appleEnvironments).optional(),
  ),
  // Production also accepts sandbox purchases (App Review buys in the
  // sandbox with the production build); off unless set.
  APPLE_ALLOW_SANDBOX: z.stringbool().optional(),
  // Apple's issuer ids look like UUIDs but are not RFC 4122 ones (no version or variant).
  APPLE_ISSUER_ID: blankAsUndefined(
    z
      .string()
      .trim()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  ),
  APPLE_KEY_ID: blankAsUndefined(
    z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{10}$/),
  ),
  APPLE_PRIVATE_KEY: blankAsUndefined(z.string().trim().min(100)),
  // Where the App Store Server API is; development only (a local server).
  APPLE_API_BASE_URL: blankAsUndefined(z.url()),
  // Google Play: the app's package name, the service account that reads
  // purchases (Play Console → Users and permissions; its JSON key's
  // `client_email` and `private_key`), and the Pub/Sub push subscription of
  // Real-time Developer Notifications: the audience its OIDC token is minted
  // for and the service account it is minted as.
  GOOGLE_PLAY_PACKAGE_NAME: blankAsUndefined(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/),
  ),
  GOOGLE_PLAY_CLIENT_EMAIL: blankAsUndefined(z.email()),
  GOOGLE_PLAY_PRIVATE_KEY: blankAsUndefined(z.string().trim().min(100)),
  GOOGLE_PUBSUB_AUDIENCE: blankAsUndefined(z.string().trim().min(3).max(500)),
  GOOGLE_PUBSUB_SERVICE_ACCOUNT: blankAsUndefined(z.email()),
  // Where the Play Developer API, Google's token endpoint and Google's
  // signing keys are; development only (a local server).
  GOOGLE_PLAY_API_BASE_URL: blankAsUndefined(z.url()),
  GOOGLE_PLAY_TOKEN_URL: blankAsUndefined(z.url()),
  GOOGLE_OIDC_CERTS_URL: blankAsUndefined(z.url()),
  // A supplier's card subscription (ARCHITECTURE 9.4.2, 4.77; TASK-042).
  // Unset provider: `test`, which production refuses.
  PAYMENT_PROVIDER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(paymentProviders).optional(),
  ),
  PAYMENT_TEST_MODE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(paymentTestModes).default("ok"),
  ),
  // Seals the tokens of cards (AES-256-GCM); required outside development.
  PAYMENT_TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
  // The secret the provider's webhook is signed with; without it none is accepted.
  PAYMENT_WEBHOOK_SECRET: blankAsUndefined(z.string().trim().min(16)),
  // The search index of the catalog (ARCHITECTURE 10, 4.65; TASK-045).
  // Unset — no index: the users' search runs on PostgreSQL (TASK-044) and
  // the worker leaves the outbox alone.
  MEILISEARCH_URL: blankAsUndefined(urlWithProtocol(["http:", "https:"])),
  // A key with the rights the API and the worker need; unset — the master
  // key of the local container (`MEILI_MASTER_KEY`, compose.dev.yml).
  MEILISEARCH_API_KEY: blankAsUndefined(z.string().trim().min(16)),
  MEILI_MASTER_KEY: blankAsUndefined(z.string().trim().min(16)),
  // The name of the index of items; tests give each run its own.
  MEILISEARCH_INDEX: blankAsUndefined(
    z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/),
  ),
  // The image search of photos of items (TASK-068, ARCHITECTURE 9.7, 4.95).
  // Unset: `test` in development and tests (fixtures, no network), and no
  // search at all elsewhere — production starts without one.
  IMAGE_SEARCH_PROVIDER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(imageSearchProviders).optional(),
  ),
  IMAGE_SEARCH_TEST_MODE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(imageSearchTestModes).default("ok"),
  ),
  SERPAPI_API_KEY: blankAsUndefined(z.string().trim().min(16)),
});

export interface RateLimitSettings {
  max: number;
  windowSeconds: number;
}

export type AppConfig = {
  /** A supplier's card subscription (TASK-042, ARCHITECTURE 4.77). */
  payments: {
    provider: PaymentProviderConfigName;
    /** What the test provider does (ignored by any other). */
    testMode: PaymentTestMode;
    /** Seals the tokens of cards; a fixed development value only in development and tests. */
    tokenEncryptionKey: string;
    /** Signs the provider's webhook; `undefined` — none is accepted. */
    webhookSecret: string | undefined;
  };
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
  ai: {
    provider: AiProviderName;
    /** The OpenRouter key; `undefined` without one (then only the test provider runs). */
    openRouterApiKey: string | undefined;
    /** Where OpenRouter is (the public address unless development says otherwise). */
    openRouterBaseUrl: string;
    /** What the test provider does (ignored by `claude`). */
    testMode: AiTestMode;
  };
  messaging: {
    provider: MessageProviderName;
    /** What the test channel does (ignored by the real one). */
    testMode: MessageTestMode;
    whatsapp: {
      /** `undefined` without one (then only the test channel runs). */
      accessToken: string | undefined;
      phoneNumberId: string | undefined;
      /**
       * Checks the webhook signature. Development and tests use a fixed
       * value so a signed webhook can be tried without a Meta account;
       * anywhere else it is set or nothing is accepted: `undefined` refuses
       * every webhook (the real channel cannot start without it).
       */
      appSecret: string | undefined;
      /**
       * Echoed back when Meta confirms the webhook subscription. `undefined`
       * — the subscription cannot be confirmed.
       */
      webhookVerifyToken: string | undefined;
      /** Where the Cloud API is, with the version (`…/v21.0`). */
      baseUrl: string;
    };
  };
  push: {
    provider: PushProviderName;
    /** What the test provider does (ignored by `live`). */
    testMode: PushTestMode;
    /** The service account of FCM (Android); `undefined` with the test provider. */
    fcm:
      | {
          projectId: string;
          clientEmail: string;
          /** PEM, with real line breaks. */
          privateKey: string;
          /** FCM itself (`https://fcm.googleapis.com` unless development says otherwise). */
          baseUrl: string;
          tokenUrl: string;
        }
      | undefined;
    /** The `.p8` key of APNs (iOS, TASK-056); `undefined` with the test provider. */
    apns:
      | {
          keyId: string;
          teamId: string;
          /** PEM, with real line breaks. */
          privateKey: string;
          bundleId: string;
          environment: (typeof apnsEnvironments)[number];
          /** APNs itself unless development says otherwise. */
          origin: string | undefined;
        }
      | undefined;
  };
  /** A user's subscription through the stores (TASK-041). */
  stores: {
    apple: AppleStoreConfig;
    google: GoogleStoreConfig;
    /** The variables a store lacks to be whole (for the administrator's signal); empty — whole. */
    missing: { apple: string[]; google: string[] };
  };
  search: {
    /** Where Meilisearch is; `undefined` — no index, the search runs on PostgreSQL. */
    url: string | undefined;
    apiKey: string | undefined;
    /** The index of items users search (the live one; a rebuild swaps into it). */
    index: string;
  };
  /** The image search of photos of items (TASK-068); `disabled` — none here. */
  imageSearch: {
    provider: ImageSearchProviderName;
    testMode: (typeof imageSearchTestModes)[number];
    /** `undefined` without one. */
    serpApiKey: string | undefined;
  };
  /**
   * Variables present in the environment that used to hold what are
   * settings now, or belong to something the project no longer has; they
   * have no effect (`main.ts`, `worker.ts` warn).
   */
  ignoredVariables: string[];
};

/**
 * Every value of a secret that is public in this repository (TASK-055):
 * the development stand-ins above, `.env.example` and `compose.dev.yml`
 * (`adclub-dev-master-key`, `adclub-dev-secret`, the password `adclub`).
 */
export const DEVELOPMENT_SECRET_VALUES: ReadonlySet<string> = new Set([
  DEV_LOGIN_CODE_HASH_SECRET,
  DEV_SESSION_TOKEN_SECRET,
  DEV_ADMIN_TOTP_ENCRYPTION_KEY,
  DEV_PAYMENT_TOKEN_ENCRYPTION_KEY,
  DEV_PAYMENT_WEBHOOK_SECRET,
  DEV_WHATSAPP_APP_SECRET,
  DEV_WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  "adclub-dev-master-key",
  "adclub-dev-secret",
  "adclub",
]);

/** The variables that hold a secret value as a whole. */
const SECRET_VARIABLES = [
  "LOGIN_CODE_HASH_SECRET",
  "SESSION_TOKEN_SECRET",
  "ADMIN_TOTP_ENCRYPTION_KEY",
  "PAYMENT_TOKEN_ENCRYPTION_KEY",
  "PAYMENT_WEBHOOK_SECRET",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "METRICS_TOKEN",
  "MEILI_MASTER_KEY",
  "MEILISEARCH_API_KEY",
  "S3_SECRET_KEY",
  "SERPAPI_API_KEY",
] as const;

/** The variables that are addresses with a password in them. */
const SECRET_URL_VARIABLES = ["DATABASE_URL", "REDIS_URL"] as const;

/**
 * Names (never values) of the secrets set to a development value; checked
 * outside development and test, where the process then refuses to start.
 */
function developmentSecretIssues(env: NodeJS.ProcessEnv, nodeEnv: NodeEnv): string[] {
  const issues: string[] = [];
  const known = (value: string | undefined): boolean =>
    value !== undefined && DEVELOPMENT_SECRET_VALUES.has(value.trim());
  for (const name of SECRET_VARIABLES) {
    if (known(env[name])) {
      issues.push(`${name}: a development value is not allowed when NODE_ENV=${nodeEnv}`);
    }
  }
  for (const name of SECRET_URL_VARIABLES) {
    const value = env[name];
    if (value === undefined) continue;
    let password: string;
    try {
      password = decodeURIComponent(new URL(value).password);
    } catch {
      continue;
    }
    if (known(password)) {
      issues.push(
        `${name}: the password is a development value, not allowed when NODE_ENV=${nodeEnv}`,
      );
    }
  }
  return issues;
}

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
  const aiProvider: AiProviderName =
    parsed.AI_PROVIDER ?? (parsed.OPENROUTER_API_KEY ? "openrouter" : "test");
  if (aiProvider === "openrouter" && !parsed.OPENROUTER_API_KEY) {
    environmentIssues.push("OPENROUTER_API_KEY: required when AI_PROVIDER=openrouter");
  }
  if (parsed.NODE_ENV === "production" && aiProvider === "test") {
    environmentIssues.push(
      "AI_PROVIDER: the test AI provider is not allowed when NODE_ENV=production (set OPENROUTER_API_KEY)",
    );
  }
  // Messages to suppliers (TASK-024): the real channel needs all three —
  // the token and the number to send with, the app secret to believe an
  // event of the provider. Without them the test channel does the work,
  // which production refuses (nobody would get a message).
  const whatsappConfigured =
    parsed.WHATSAPP_ACCESS_TOKEN !== undefined &&
    parsed.WHATSAPP_PHONE_NUMBER_ID !== undefined &&
    parsed.WHATSAPP_APP_SECRET !== undefined;
  const messageProvider: MessageProviderName =
    parsed.MESSAGE_PROVIDER ?? (whatsappConfigured ? "whatsapp_cloud" : "test");
  if (messageProvider === "whatsapp_cloud") {
    for (const name of [
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    ] as const) {
      if (!parsed[name]) {
        environmentIssues.push(`${name}: required when MESSAGE_PROVIDER=whatsapp_cloud`);
      }
    }
  }
  if (parsed.NODE_ENV === "production" && messageProvider === "test") {
    environmentIssues.push(
      "MESSAGE_PROVIDER: the test message channel is not allowed when NODE_ENV=production (configure WHATSAPP_*)",
    );
  }
  if (parsed.WHATSAPP_API_BASE_URL && !isLocal) {
    environmentIssues.push(
      `WHATSAPP_API_BASE_URL: not allowed when NODE_ENV=${parsed.NODE_ENV} (messages would leave for another address)`,
    );
  }
  // Push to the user (TASK-051, TASK-056): `live` needs FCM's service account
  // and APNs' key whole — a server that reaches one platform only would
  // leave the other one's people silently without push; the test provider
  // sends nothing, which production refuses.
  const fcmVariables = ["FCM_PROJECT_ID", "FCM_CLIENT_EMAIL", "FCM_PRIVATE_KEY"] as const;
  const apnsVariables = [
    "APNS_KEY_ID",
    "APNS_TEAM_ID",
    "APNS_PRIVATE_KEY",
    "APNS_BUNDLE_ID",
    "APNS_ENVIRONMENT",
  ] as const;
  const fcmConfigured = fcmVariables.every((name) => parsed[name] !== undefined);
  const apnsConfigured = apnsVariables.every((name) => parsed[name] !== undefined);
  const pushProvider: PushProviderName =
    parsed.PUSH_PROVIDER ?? (fcmConfigured && apnsConfigured ? "live" : "test");
  if (pushProvider === "live") {
    for (const name of [...fcmVariables, ...apnsVariables]) {
      if (!parsed[name]) {
        environmentIssues.push(`${name}: required when PUSH_PROVIDER=live`);
      }
    }
  }
  if (parsed.NODE_ENV === "production" && pushProvider === "test") {
    environmentIssues.push(
      "PUSH_PROVIDER: the test push provider is not allowed when NODE_ENV=production (configure FCM_* and APNS_*)",
    );
  }
  if (parsed.NODE_ENV === "production" && parsed.APNS_ENVIRONMENT === "sandbox") {
    environmentIssues.push(
      "APNS_ENVIRONMENT: sandbox is not allowed when NODE_ENV=production (it reaches development builds only)",
    );
  }
  for (const name of ["FCM_API_BASE_URL", "APNS_API_URL"] as const) {
    if (parsed[name] && !isLocal) {
      environmentIssues.push(
        `${name}: not allowed when NODE_ENV=${parsed.NODE_ENV} (pushes would leave for another address)`,
      );
    }
  }
  // The stores (TASK-041): each set is whole or absent — a part of one is a
  // mistake that would leave its purchases half checked. A deployment
  // without a set starts; its store answers «unavailable».
  const appleVariables = [
    "APPLE_BUNDLE_ID",
    "APPLE_APP_APPLE_ID",
    "APPLE_ENVIRONMENT",
    "APPLE_ISSUER_ID",
    "APPLE_KEY_ID",
    "APPLE_PRIVATE_KEY",
  ] as const;
  const googleVariables = [
    "GOOGLE_PLAY_PACKAGE_NAME",
    "GOOGLE_PLAY_CLIENT_EMAIL",
    "GOOGLE_PLAY_PRIVATE_KEY",
    "GOOGLE_PUBSUB_AUDIENCE",
    "GOOGLE_PUBSUB_SERVICE_ACCOUNT",
  ] as const;
  const appleMissing = appleVariables.filter((name) => parsed[name] === undefined);
  const googleMissing = googleVariables.filter((name) => parsed[name] === undefined);
  for (const [store, variables, missing] of [
    ["App Store", appleVariables, appleMissing],
    ["Google Play", googleVariables, googleMissing],
  ] as const) {
    if (missing.length > 0 && missing.length < variables.length) {
      environmentIssues.push(
        `${missing.join(", ")}: required with the rest of the ${store} variables (a store is configured whole or not at all)`,
      );
    }
  }
  for (const name of [
    "APPLE_API_BASE_URL",
    "GOOGLE_PLAY_API_BASE_URL",
    "GOOGLE_PLAY_TOKEN_URL",
    "GOOGLE_OIDC_CERTS_URL",
  ] as const) {
    if (parsed[name] && !isLocal) {
      environmentIssues.push(
        `${name}: not allowed when NODE_ENV=${parsed.NODE_ENV} (purchases would be checked elsewhere)`,
      );
    }
  }
  const appleConfigured = appleMissing.length === 0;
  const googleConfigured = googleMissing.length === 0;
  const appleEnvironmentsAccepted: AppleEnvironment[] = appleConfigured
    ? parsed.APPLE_ENVIRONMENT === "production" && parsed.APPLE_ALLOW_SANDBOX
      ? ["production", "sandbox"]
      : [parsed.APPLE_ENVIRONMENT!]
    : isLocal
      ? ["sandbox", "production"]
      : [];
  if (parsed.NODE_ENV === "production" && parsed.APPLE_ENVIRONMENT === "sandbox") {
    environmentIssues.push(
      "APPLE_ENVIRONMENT: sandbox is not allowed when NODE_ENV=production (use APPLE_ALLOW_SANDBOX for App Review)",
    );
  }
  // Cards of suppliers (TASK-042): the test provider charges nobody, so
  // production refuses it. `card_kz` starts (the application must), but until
  // the acquirer's class exists every call of it answers «unavailable» —
  // `UnconfiguredPaymentProvider`, nothing is charged and nobody is paused.
  const paymentProvider: PaymentProviderConfigName = parsed.PAYMENT_PROVIDER ?? "test";
  if (parsed.NODE_ENV === "production" && paymentProvider === "test") {
    environmentIssues.push(
      "PAYMENT_PROVIDER: the test payment provider is not allowed when NODE_ENV=production",
    );
  }
  // The image search (TASK-068): SerpAPI needs its key; the test provider
  // outside development and tests means no search — the application starts.
  if (parsed.IMAGE_SEARCH_PROVIDER === "serpapi" && !parsed.SERPAPI_API_KEY) {
    environmentIssues.push("SERPAPI_API_KEY: required when IMAGE_SEARCH_PROVIDER=serpapi");
  }
  const imageSearchProvider: ImageSearchProviderName =
    parsed.IMAGE_SEARCH_PROVIDER === "serpapi"
      ? "serpapi"
      : isLocal && parsed.IMAGE_SEARCH_PROVIDER !== undefined
        ? parsed.IMAGE_SEARCH_PROVIDER
        : isLocal
          ? "test"
          : "disabled";
  if (!isLocal && !parsed.PAYMENT_TOKEN_ENCRYPTION_KEY) {
    environmentIssues.push(
      `PAYMENT_TOKEN_ENCRYPTION_KEY: required when NODE_ENV=${parsed.NODE_ENV}`,
    );
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
  // System data is never served anonymously outside a developer's machine
  // (TASK-009.A): without a token there, metrics are off unless asked for,
  // and asking for them without a token is a configuration error.
  const metricsEnabled = parsed.METRICS_ENABLED ?? (isLocal || parsed.METRICS_TOKEN !== undefined);
  if (!isLocal && metricsEnabled && !parsed.METRICS_TOKEN) {
    environmentIssues.push(
      `METRICS_TOKEN: required when METRICS_ENABLED=true and NODE_ENV=${parsed.NODE_ENV}`,
    );
  }
  // A deployed environment never runs on a value anybody can read in this
  // repository (TASK-055, ARCHITECTURE 4.82): the stand-ins of development
  // and tests, the values of `.env.example` and of `compose.dev.yml`.
  if (!isLocal) {
    environmentIssues.push(...developmentSecretIssues(env, parsed.NODE_ENV));
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
      enabled: metricsEnabled,
      token: parsed.METRICS_TOKEN,
    },
    ai: {
      provider: aiProvider,
      openRouterApiKey: parsed.OPENROUTER_API_KEY,
      openRouterBaseUrl: parsed.OPENROUTER_BASE_URL ?? OPENROUTER_PUBLIC_URL,
      testMode: parsed.AI_TEST_MODE,
    },
    messaging: {
      provider: messageProvider,
      testMode: parsed.MESSAGE_TEST_MODE,
      whatsapp: {
        accessToken: parsed.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: parsed.WHATSAPP_PHONE_NUMBER_ID,
        appSecret: parsed.WHATSAPP_APP_SECRET ?? (isLocal ? DEV_WHATSAPP_APP_SECRET : undefined),
        webhookVerifyToken:
          parsed.WHATSAPP_WEBHOOK_VERIFY_TOKEN ??
          (isLocal ? DEV_WHATSAPP_WEBHOOK_VERIFY_TOKEN : undefined),
        baseUrl: `${parsed.WHATSAPP_API_BASE_URL ?? WHATSAPP_PUBLIC_URL}/${WHATSAPP_API_VERSION}`,
      },
    },
    payments: {
      provider: paymentProvider,
      testMode: parsed.PAYMENT_TEST_MODE,
      tokenEncryptionKey: parsed.PAYMENT_TOKEN_ENCRYPTION_KEY ?? DEV_PAYMENT_TOKEN_ENCRYPTION_KEY,
      webhookSecret:
        parsed.PAYMENT_WEBHOOK_SECRET ?? (isLocal ? DEV_PAYMENT_WEBHOOK_SECRET : undefined),
    },
    push: {
      provider: pushProvider,
      testMode: parsed.PUSH_TEST_MODE,
      fcm:
        pushProvider === "live" && fcmConfigured
          ? {
              projectId: parsed.FCM_PROJECT_ID!,
              clientEmail: parsed.FCM_CLIENT_EMAIL!,
              privateKey: parsed.FCM_PRIVATE_KEY!.replaceAll("\\n", "\n"),
              baseUrl: (parsed.FCM_API_BASE_URL ?? FCM_PUBLIC_URL).replace(/\/+$/, ""),
              tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
            }
          : undefined,
      apns:
        pushProvider === "live" && apnsConfigured
          ? {
              keyId: parsed.APNS_KEY_ID!,
              teamId: parsed.APNS_TEAM_ID!,
              privateKey: parsed.APNS_PRIVATE_KEY!.replaceAll("\\n", "\n"),
              bundleId: parsed.APNS_BUNDLE_ID!,
              environment: parsed.APNS_ENVIRONMENT!,
              origin: parsed.APNS_API_URL?.replace(/\/+$/, ""),
            }
          : undefined,
    },
    stores: {
      apple: {
        configured: appleConfigured,
        bundleId: parsed.APPLE_BUNDLE_ID ?? DEV_STORE_APP_ID,
        appAppleId: parsed.APPLE_APP_APPLE_ID ? Number(parsed.APPLE_APP_APPLE_ID) : null,
        environments: appleEnvironmentsAccepted,
        api: appleConfigured
          ? {
              issuerId: parsed.APPLE_ISSUER_ID!,
              keyId: parsed.APPLE_KEY_ID!,
              privateKey: parsed.APPLE_PRIVATE_KEY!.replaceAll("\\n", "\n"),
            }
          : null,
        apiUrls: parsed.APPLE_API_BASE_URL
          ? {
              production: parsed.APPLE_API_BASE_URL.replace(/\/+$/, ""),
              sandbox: parsed.APPLE_API_BASE_URL.replace(/\/+$/, ""),
            }
          : APPLE_API_URLS,
        devTrust: isLocal,
      },
      google: {
        configured: googleConfigured,
        packageName: parsed.GOOGLE_PLAY_PACKAGE_NAME ?? DEV_STORE_APP_ID,
        api: googleConfigured
          ? {
              clientEmail: parsed.GOOGLE_PLAY_CLIENT_EMAIL!,
              privateKey: parsed.GOOGLE_PLAY_PRIVATE_KEY!.replaceAll("\\n", "\n"),
              tokenUrl: parsed.GOOGLE_PLAY_TOKEN_URL ?? GOOGLE_OAUTH_TOKEN_URL,
            }
          : null,
        apiUrl: (parsed.GOOGLE_PLAY_API_BASE_URL ?? GOOGLE_PLAY_API_URL).replace(/\/+$/, ""),
        pubsub: googleConfigured
          ? {
              audience: parsed.GOOGLE_PUBSUB_AUDIENCE!,
              serviceAccount: parsed.GOOGLE_PUBSUB_SERVICE_ACCOUNT!,
            }
          : isLocal
            ? { audience: DEV_PUBSUB_AUDIENCE, serviceAccount: DEV_PUBSUB_SERVICE_ACCOUNT }
            : null,
        certsUrl: parsed.GOOGLE_OIDC_CERTS_URL ?? GOOGLE_OIDC_CERTS_URL,
        devTrust: isLocal,
      },
      missing: { apple: [...appleMissing], google: [...googleMissing] },
    },
    search: {
      url: parsed.MEILISEARCH_URL?.replace(/\/+$/, ""),
      apiKey: parsed.MEILISEARCH_API_KEY ?? parsed.MEILI_MASTER_KEY,
      index: parsed.MEILISEARCH_INDEX ?? "catalog_items",
    },
    imageSearch: {
      provider: imageSearchProvider,
      testMode: parsed.IMAGE_SEARCH_TEST_MODE,
      serpApiKey: parsed.SERPAPI_API_KEY,
    },
    ignoredVariables: Object.keys(env)
      .filter((name) =>
        [...SETTINGS_FORMERLY_IN_ENVIRONMENT, ...REMOVED_FROM_ENVIRONMENT].some((pattern) =>
          pattern.test(name),
        ),
      )
      .sort(),
  };
}

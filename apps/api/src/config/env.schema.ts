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
});

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
  };
}

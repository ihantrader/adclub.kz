import { z } from "zod";

export const dependencyCheckSchema = z.object({
  status: z.enum(["ok", "error"]),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

/**
 * `GET /ready` response (ARCHITECTURE 15.3): unlike `/health` (liveness,
 * always `ok` while the process is up), this reflects the current state
 * of every dependency the API needs. `status` is `degraded` as soon as
 * one check fails; a failing dependency never crashes the process.
 */
export const readinessResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  checks: z.object({
    postgres: dependencyCheckSchema,
    redis: dependencyCheckSchema,
    s3: dependencyCheckSchema,
  }),
});

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

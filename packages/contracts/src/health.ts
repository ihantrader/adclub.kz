import { z } from "zod";

/**
 * Demo contract schema (TASK-001): proves one zod schema, defined once,
 * is used both by the API to shape its response and by a client to type
 * what it receives. Real product schemas arrive in TASK-003.
 */
export const healthCheckResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.enum(["api", "worker"]),
  timestamp: z.string(),
  // Demo additive field (TASK-003 AC-5), not for merge.
  uptimeSeconds: z.number().optional(),
});

export type HealthCheckResponse = z.infer<typeof healthCheckResponseSchema>;

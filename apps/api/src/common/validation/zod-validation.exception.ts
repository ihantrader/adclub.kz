import type { ZodError } from "zod";

/**
 * Thrown by `ZodValidationPipe`. Carries the zod issues so the global
 * exception filter can build `details` without re-parsing anything.
 */
export class ZodValidationException extends Error {
  constructor(public readonly zodError: ZodError) {
    super("Validation failed");
    this.name = "ZodValidationException";
  }
}

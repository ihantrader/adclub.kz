import { Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { ZodValidationException } from "./zod-validation.exception";

/**
 * Validates a request value (body, query or params) against a zod schema
 * from `@adclub/contracts` (ARCHITECTURE 7.2 — the schema is the source of
 * truth). On failure, throws `ZodValidationException`, which the global
 * exception filter turns into the unified `VALIDATION_ERROR` response.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new ZodValidationException(result.error);
    }

    return result.data;
  }
}

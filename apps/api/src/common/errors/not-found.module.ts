import { Module } from "@nestjs/common";
import { NotFoundController } from "./not-found.controller";

/**
 * Nest registers a module's own routes before walking its `imports`
 * (verified: putting `NotFoundController` directly on `AppModule` made its
 * catch-all route shadow `/health` and `/ready`). Wrapping it in its own
 * module and importing that module *last* fixes the ordering.
 */
@Module({
  controllers: [NotFoundController],
})
export class NotFoundModule {}

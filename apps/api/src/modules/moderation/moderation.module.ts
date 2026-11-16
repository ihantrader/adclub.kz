import { Controller, Inject, Module, Query, type OnModuleInit } from "@nestjs/common";
import {
  adminModerationQuerySchema,
  apiRoutes,
  type AdminModerationPage,
  type AdminModerationQuery,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { JobRegistry } from "../../jobs";
import { SessionRoute } from "../identity";
import { ModerationDigest, moderationDigestJob } from "./moderation-digest";
import { ModerationQueueService } from "./moderation-queue.service";

/** «Модерация» of the admin panel (context `admin`). */
@Controller()
export class AdminModerationController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(ModerationQueueService) private readonly queue: ModerationQueueService) {}

  @SessionRoute(apiRoutes.listAdminModeration)
  list(
    @Query(new ZodValidationPipe(adminModerationQuerySchema)) query: AdminModerationQuery,
  ): Promise<AdminModerationPage> {
    return this.queue.page(query);
  }
}

/**
 * Moderation in one place (TASK-071; ARCHITECTURE 4.89): the admin's queue
 * of what suppliers wait for, its count for the home screen. The decisions
 * stay where they are (the price-imports and the compatibility modules).
 */
@Module({
  controllers: [AdminModerationController],
  providers: [ModerationQueueService],
  exports: [ModerationQueueService],
})
export class ModerationModule {}

/** The worker's part: the daily digest W-06. */
@Module({ providers: [ModerationDigest] })
export class ModerationJobsModule implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(ModerationDigest) private readonly digest: ModerationDigest,
  ) {}

  onModuleInit(): void {
    this.registry.handlePeriodic(moderationDigestJob, this.digest);
  }
}

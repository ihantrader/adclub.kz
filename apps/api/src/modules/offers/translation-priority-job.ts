import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { DatabaseService } from "../../database";
import {
  JobRegistry,
  type JobRunContext,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { translationPriorityJob, walkItemPriorities } from "../catalog";
import { shownItemIds } from "./offer-list-rule";

/**
 * `catalog.translation-priority` (TASK-054; ARCHITECTURE 4.97): every
 * minute the items whose translation waits are walked page by page and
 * their tasks move to «on the showcase» or back to «the rest» by the one
 * rule of the showcase (`shownOffers`). An item that gained its first
 * offer while its translation waited rises within a minute; one that lost
 * them goes down. Nothing is translated here — only the order is kept.
 */
@Injectable()
export class TranslationPriorityRunner implements PeriodicJobHandler {
  private readonly logger = new Logger("Translation");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async run(context: JobRunContext): Promise<JobRunOutcome> {
    const walk = await walkItemPriorities(this.database.db, shownItemIds, {
      signal: context.signal,
    });
    if (walk.raised + walk.lowered === 0) {
      return { worked: false };
    }
    this.logger.log(
      `Translation queue reordered raised=${walk.raised} lowered=${walk.lowered} items=${walk.items} pages=${walk.pages}`,
    );
    return { worked: true };
  }
}

/** The worker's part of the offers module: the order of the translation queue. */
@Module({ providers: [TranslationPriorityRunner] })
export class OfferJobsModule implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(TranslationPriorityRunner) private readonly runner: TranslationPriorityRunner,
  ) {}

  onModuleInit(): void {
    this.registry.handlePeriodic(translationPriorityJob, this.runner);
  }
}

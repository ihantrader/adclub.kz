import { Inject, Module, type DynamicModule, type OnModuleInit } from "@nestjs/common";
import { JobRegistry } from "../../jobs";
import { ReminderFacts } from "./reminder-facts";
import { GarageRemind, remindJob } from "./reminder-jobs";
import { RemindersController } from "./reminders.controller";
import { GarageReminders } from "./reminders.service";

export interface RemindersModuleOptions {
  /** Serve the app's routes (the API process only). */
  http: boolean;
  /**
   * The very instances of the application's modules it reads through: the
   * one compatibility calculation (the car of an order on an item), the
   * client catalog (the filters of a rule), the maintenance plans (the plan
   * of a car and «Подобрать»), and — in the API — the garage (the mileage of
   * «Уже поменял» is written by its own way).
   */
  compatibility: DynamicModule;
  showcase: DynamicModule;
  maintenance: DynamicModule;
  garage?: DynamicModule;
}

/**
 * Reminders about a planned replacement (TASK-069; PRODUCT 6.5; ARCHITECTURE
 * 4.87): one service of facts and the one rule `reminderState` — the routes of
 * the app, the admin panel's view and the daily job `garage.remind` all take
 * them.
 */
@Module({})
export class RemindersModule {
  static forRoot(options: RemindersModuleOptions): DynamicModule {
    return {
      module: RemindersModule,
      imports: [
        options.compatibility,
        options.showcase,
        options.maintenance,
        ...(options.garage ? [options.garage] : []),
      ],
      controllers: options.http ? [RemindersController] : [],
      providers: [ReminderFacts, ...(options.garage ? [GarageReminders] : []), GarageRemind],
      exports: [ReminderFacts, GarageRemind, ...(options.garage ? [GarageReminders] : [])],
    };
  }
}

/** The worker's part: the daily job. */
@Module({})
export class ReminderJobsModule implements OnModuleInit {
  static forRoot(options: Omit<RemindersModuleOptions, "http" | "garage">): DynamicModule {
    return {
      module: ReminderJobsModule,
      imports: [RemindersModule.forRoot({ ...options, http: false })],
    };
  }

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(GarageRemind) private readonly remind: GarageRemind,
  ) {}

  onModuleInit(): void {
    this.registry.handlePeriodic(remindJob, this.remind);
  }
}

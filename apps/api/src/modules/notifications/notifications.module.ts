import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleInit,
} from "@nestjs/common";
import type { AppConfig } from "../../config";
import { JobRegistry } from "../../jobs";
import { Metrics } from "../../observability";
import { AppSettings } from "../settings";
import { DeviceTokenCleanup } from "./device-token-cleanup";
import { DevPushesController, DevPushOutbox } from "./dev-pushes.controller";
import { FcmPushProvider } from "./fcm-push-provider";
import { NotificationsAdmin } from "./notifications-admin";
import { NotificationsController } from "./notifications.controller";
import { Notifications } from "./notifications.service";
import {
  PushFallbacks,
  pushFallbackJob,
  PushFallbackShareWatch,
  pushFallbackShareJob,
  PushFallbackSweep,
} from "./push-fallback";
import { deviceTokenCleanupJob, pushRecoveryJob, sendPushJob } from "./push-jobs";
import { DatabaseService } from "../../database";
import { AccountDirectory, countWithoutWhatsapp } from "../identity";
import { AdminSignals } from "../signals";
import { NotificationSubjects } from "./notification-subjects";
import { PushProvider } from "./push-provider";
import { InterruptedPushSweep, PushSender } from "./push-sender";
import { checkPushTemplates } from "./push-templates";
import { TestPushProvider } from "./test-push-provider";

/** Refuses to start when a push text lost a language or a placeholder. */
@Injectable()
export class PushTemplateCheck implements OnModuleInit {
  onModuleInit(): void {
    const problems = checkPushTemplates();
    if (problems.length > 0) {
      throw new Error(`The push templates are not sound:\n  - ${problems.join("\n  - ")}`);
    }
  }
}

/** Push to users as metrics, sampled when metrics are scraped. */
@Injectable()
export class PushMetrics implements OnModuleInit {
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(Notifications) private readonly notifications: Notifications,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.metrics.collectPushes(async () => {
      for (const row of await this.notifications.countsByKind()) {
        this.metrics.setPushNotifications(row.kind, row.status, row.count);
      }
      const deliveries = await this.notifications.deliveryCounts();
      for (const state of ["queued", "sending", "sent", "failed", "unknown", "cancelled"]) {
        this.metrics.setPushDeliveries(state, deliveries[state] ?? 0);
      }
      const { sent, unacked } = await this.notifications.unacked();
      this.metrics.setPushUnackedRatio(sent === 0 ? 0 : unacked / sent);
      for (const row of await this.notifications.fallbackCounts()) {
        this.metrics.setPushFallbacks(row.kind, row.status, row.count);
      }
      this.metrics.setPushFallbackRatio((await this.notifications.fallbackShare()).share);
      this.metrics.setPushRecipients("push_unreliable", await this.notifications.unreliableCount());
      this.metrics.setPushRecipients("no_whatsapp", await countWithoutWhatsapp(this.database.db));
    });
  }
}

export interface NotificationsModuleOptions {
  /** Serve the app's routes (the API process). */
  http: boolean;
  metrics?: boolean;
  /** Serve `GET /dev/pushes` (the switch of the login code dev outbox). */
  devOutbox?: boolean;
}

/**
 * Push to the user (TASK-051; PRODUCT 15; ARCHITECTURE 9.3, 4.79): one
 * port with a test and a real provider chosen by configuration, the texts of
 * SCREENS 8.4 as data, the queue, the devices' tokens and the confirmations.
 * Global, as messaging is: a module that sends a push injects
 * `Notifications` without importing this one.
 */
@Global()
@Module({})
export class NotificationsModule {
  static forRoot(config: AppConfig, options: NotificationsModuleOptions): DynamicModule {
    const testProvider = config.push.provider !== "fcm" || !config.push.fcm;
    const devPage = options.http && options.devOutbox === true && testProvider;
    return {
      module: NotificationsModule,
      controllers: options.http
        ? [NotificationsController, ...(devPage ? [DevPushesController] : [])]
        : [],
      providers: [
        ...providerOf(config),
        Notifications,
        PushFallbacks,
        NotificationSubjects,
        NotificationsAdmin,
        PushTemplateCheck,
        ...(options.metrics ? [PushMetrics] : []),
        ...(devPage ? [DevPushOutbox] : []),
      ],
      exports: [
        Notifications,
        PushFallbacks,
        NotificationSubjects,
        NotificationsAdmin,
        PushProvider,
      ],
    };
  }
}

function providerOf(config: AppConfig) {
  const fcm = config.push.fcm;
  if (config.push.provider === "fcm" && fcm) {
    return [{ provide: PushProvider, useFactory: () => new FcmPushProvider(fcm) }];
  }
  return [
    {
      provide: TestPushProvider,
      useFactory: () => {
        const provider = new TestPushProvider();
        provider.mode = config.push.testMode;
        return provider;
      },
    },
    { provide: PushProvider, useExisting: TestPushProvider },
  ];
}

/** The push jobs, for the worker process. */
@Module({ providers: [PushSender, PushFallbackShareWatch, AdminSignals, AccountDirectory] })
export class NotificationJobsModule implements OnModuleInit {
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(PushSender) private readonly sender: PushSender,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(PushFallbacks) private readonly fallbacks: PushFallbacks,
    @Inject(PushFallbackShareWatch) private readonly shareWatch: PushFallbackShareWatch,
  ) {}

  onModuleInit(): void {
    this.registry.handle(sendPushJob, this.sender);
    this.registry.sweep(pushFallbackJob, new PushFallbackSweep(this.fallbacks));
    this.registry.handlePeriodic(pushFallbackShareJob, this.shareWatch);
    this.registry.sweep(pushRecoveryJob, new InterruptedPushSweep());
    this.registry.sweep(deviceTokenCleanupJob, new DeviceTokenCleanup(this.settings));
  }
}

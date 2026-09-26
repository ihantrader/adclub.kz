import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleInit,
} from "@nestjs/common";
import { DatabaseService } from "../../database";
import { JobRegistry } from "../../jobs";
import { Metrics } from "../../observability";
import { AppSettings } from "../settings";
import { ButtonPayloads } from "./button-payloads";
import { applyButtonPressJob, ButtonPressApplier, ButtonPressHandlers } from "./button-presses";
import { DevMessageOutbox, DevMessagesController } from "./dev-messages.controller";
import { MessageChannel } from "./message-channel";
import {
  applyWebhookEventJob,
  messageRecoveryJob,
  messageVariablesCleanupJob,
  sendMessageJob,
  webhookEventCleanupJob,
} from "./message-jobs";
import { MessageSender } from "./message-sender";
import { MessagingAdmin } from "./messaging-admin";
import { MessageSubjects } from "./message-subjects";
import { InterruptedMessagesSweep } from "./message-recovery";
import { MessageVariablesCleanup } from "./message-variables-cleanup";
import { checkTemplateRegistry } from "./message-templates";
import { Messaging } from "./messaging.service";
import { TestMessageChannel } from "./test-message-channel";
import { WebhookEventApplier } from "./webhook-apply.handler";
import { WebhookEventCleanup, WebhookEvents } from "./webhook-events.service";
import { WhatsappCloudChannel } from "./whatsapp-cloud-channel";
import { WhatsappWebhookController } from "./whatsapp-webhook.controller";
import type { AppConfig } from "../../config";

/** The depth of the message queue as a metric, sampled when metrics are scraped. */
@Injectable()
export class MessageMetrics implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(Messaging) private readonly messaging: Messaging,
  ) {}

  onModuleInit(): void {
    this.metrics.collectMessages(async () => {
      const counts = await this.messaging.countsByStatus();
      for (const state of [
        "queued",
        "sending",
        "sent",
        "delivered",
        "read",
        "failed",
        "cancelled",
        "unknown",
      ]) {
        this.metrics.setMessageQueueDepth(state, counts[state] ?? 0);
      }
      for (const row of await this.messaging.countsByTemplate()) {
        this.metrics.setMessagesByTemplate(row.template, row.status, row.count);
      }
      for (const row of await this.messaging.webhookEventKinds()) {
        this.metrics.setWebhookEventKind(row.kind, row.count);
      }
    });
  }
}

/** Refuses to start when a template lost a language or a placeholder (requirement 2). */
@Injectable()
export class MessageTemplateCheck implements OnModuleInit {
  onModuleInit(): void {
    const problems = checkTemplateRegistry();
    if (problems.length > 0) {
      throw new Error(`The message templates are not sound:\n  - ${problems.join("\n  - ")}`);
    }
  }
}

export interface MessagingModuleOptions {
  /** Serve the webhook and the development page (the API process). */
  http: boolean;
  /** Sample the queue depth for metrics (the process that serves them). */
  metrics?: boolean;
  /** Serve `GET /dev/messages` (the switch of the login code dev outbox). */
  devOutbox?: boolean;
}

/**
 * The gateway of messages to suppliers (TASK-024; PRODUCT 8.4, 15;
 * ARCHITECTURE 9.1, 4.35): one port with a test and a real channel chosen
 * by configuration, the templates of SCREENS 8.5 as data, the queue, and
 * the provider's webhook with its signature checked.
 *
 * Global, as the AI module is: a module that sends a message injects
 * `Messaging` without importing this one.
 */
@Global()
@Module({})
export class MessagingModule {
  static forRoot(config: AppConfig, options: MessagingModuleOptions): DynamicModule {
    // The development page shows whole numbers and the text of each message,
    // so it exists only while the channel is the test one — the switch of the
    // login code outbox alone (which a staging environment may turn on) is not
    // enough to put real recipients' numbers behind an open route.
    const devPage = options.devOutbox === true && usesTestChannel(config);
    return {
      module: MessagingModule,
      controllers: options.http
        ? [WhatsappWebhookController, ...(devPage ? [DevMessagesController] : [])]
        : [],
      providers: [
        ...channelProviders(config),
        MessageSubjects,
        ButtonPressHandlers,
        ButtonPayloads,
        Messaging,
        MessagingAdmin,
        WebhookEvents,
        MessageTemplateCheck,
        ...(options.metrics ? [MessageMetrics] : []),
        ...(options.http && devPage ? [DevMessageOutbox] : []),
      ],
      exports: [
        Messaging,
        MessageSubjects,
        ButtonPressHandlers,
        ButtonPayloads,
        MessageChannel,
        MessagingAdmin,
        WebhookEvents,
      ],
    };
  }
}

/**
 * The real channel only with everything it needs; the test channel
 * otherwise (production refuses it — `loadConfig`).
 */
/** Whether the channel that runs is the test one (nothing is sent anywhere). */
function usesTestChannel(config: AppConfig): boolean {
  const { provider, whatsapp } = config.messaging;
  return !(provider === "whatsapp_cloud" && whatsapp.accessToken && whatsapp.phoneNumberId);
}

function channelProviders(config: AppConfig) {
  const { provider, testMode, whatsapp } = config.messaging;
  if (provider === "whatsapp_cloud" && whatsapp.accessToken && whatsapp.phoneNumberId) {
    return [
      {
        provide: MessageChannel,
        useFactory: () =>
          new WhatsappCloudChannel(
            whatsapp.accessToken!,
            whatsapp.phoneNumberId!,
            whatsapp.baseUrl,
          ),
      },
    ];
  }
  return [
    {
      provide: TestMessageChannel,
      useFactory: () => {
        const channel = new TestMessageChannel();
        channel.mode = testMode;
        return channel;
      },
    },
    { provide: MessageChannel, useExisting: TestMessageChannel },
  ];
}

/** The messaging jobs, for the worker process. */
@Module({ providers: [MessageSender, WebhookEventApplier, ButtonPressApplier] })
export class MessagingJobsModule implements OnModuleInit {
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(MessageSender) private readonly sender: MessageSender,
    @Inject(WebhookEventApplier) private readonly applier: WebhookEventApplier,
    @Inject(ButtonPressApplier) private readonly presses: ButtonPressApplier,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(MessageSubjects) private readonly subjects: MessageSubjects,
  ) {}

  onModuleInit(): void {
    this.registry.handle(sendMessageJob, this.sender);
    this.registry.handle(applyWebhookEventJob, this.applier);
    this.registry.handle(applyButtonPressJob, this.presses);
    this.registry.sweep(
      webhookEventCleanupJob,
      new WebhookEventCleanup(this.database, this.settings),
    );
    this.registry.sweep(messageVariablesCleanupJob, new MessageVariablesCleanup(this.settings));
    this.registry.sweep(messageRecoveryJob, new InterruptedMessagesSweep(this.subjects));
  }
}

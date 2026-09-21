import { Inject, Module, type DynamicModule, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config";
import { JobRegistry } from "../../jobs";
import { AccountStore, AdminUserStore, SupplierMembershipStore } from "../identity";
import { CitiesController } from "./cities.controller";
import { CitiesService } from "./cities.service";
import { DevSupplierInvitationsController } from "./dev-supplier-invitations.controller";
import { DevSupplierSeed } from "./dev-supplier-seed";
import {
  DevInvitationOutbox,
  InvitationSender,
  sendInvitationJob,
  SupplierInvitations,
  SupplierMessages,
  TestSupplierMessages,
} from "./supplier-invitations";
import { SupplierLeadForm } from "./supplier-lead-form.service";
import { SupplierLeadsController } from "./supplier-leads.controller";
import { SupplierLeadsService } from "./supplier-leads.service";
import { SupplierCabinetController, SuppliersAdminController } from "./suppliers.controller";
import { SuppliersService } from "./suppliers.service";

export interface SuppliersModuleOptions {
  /** Serve the routes (the API process only; the public form needs Redis). */
  http: boolean;
  /** Serve `GET /dev/supplier-invitations` (the switch of the login code dev outbox). */
  devOutbox?: boolean;
}

/**
 * The stores of accounts, administrators and memberships are stateless
 * wrappers of their tables; the module lists them itself so the operator
 * command (which has no identity module, only its operator providers)
 * can create suppliers too.
 */
const sharedProviders = [
  AccountStore,
  AdminUserStore,
  SupplierMembershipStore,
  CitiesService,
  SupplierInvitations,
  SuppliersService,
  SupplierLeadsService,
  DevSupplierSeed,
];

/**
 * Cities and suppliers (ARCHITECTURE 5.5, 4.26; TASK-016): the directory
 * of cities, connection requests and the funnel, creating suppliers with
 * their pickup point and first employee, the card, the schedule, the
 * states, invitations of employees.
 */
@Module({})
export class SuppliersModule {
  static forRoot(options: SuppliersModuleOptions): DynamicModule {
    return {
      module: SuppliersModule,
      controllers: options.http
        ? [
            CitiesController,
            SupplierLeadsController,
            SuppliersAdminController,
            SupplierCabinetController,
            ...(options.devOutbox ? [DevSupplierInvitationsController] : []),
          ]
        : [],
      providers: [
        ...sharedProviders,
        ...(options.http ? [SupplierLeadForm] : []),
        ...(options.http && options.devOutbox ? [DevInvitationOutbox] : []),
      ],
      exports: [CitiesService, SuppliersService, SupplierLeadsService, DevSupplierSeed],
    };
  }
}

function createSupplierMessages(config: AppConfig): SupplierMessages {
  // The same switch as the login code channels: only test channels exist
  // until TASK-026, and production refuses them at start.
  switch (config.loginCode.channels) {
    case "test":
      return new TestSupplierMessages();
  }
}

/** The suppliers' background jobs, for the worker process. */
@Module({
  providers: [
    {
      provide: SupplierMessages,
      useFactory: createSupplierMessages,
      inject: [APP_CONFIG],
    },
    InvitationSender,
  ],
  exports: [SupplierMessages],
})
export class SupplierJobsModule implements OnModuleInit {
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(InvitationSender) private readonly sender: InvitationSender,
  ) {}

  onModuleInit(): void {
    this.registry.handle(sendInvitationJob, this.sender);
  }
}

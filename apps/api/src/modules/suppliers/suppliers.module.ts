import { Inject, Module, type DynamicModule, type OnModuleInit } from "@nestjs/common";
import { JobRegistry } from "../../jobs";
import {
  AccountStore,
  AdminUserStore,
  SessionStore,
  SupplierMemberRemover,
  SupplierMembershipStore,
} from "../identity";
import { CitiesController } from "./cities.controller";
import { CitiesService } from "./cities.service";
import { DevSupplierSeed } from "./dev-supplier-seed";
import {
  InvitationSender,
  sendInvitationJob,
  SupplierInvitationMessages,
  SupplierInvitations,
} from "./supplier-invitations";
import {
  SupplierMembersAdminController,
  SupplierMembersCabinetController,
} from "./supplier-members.controller";
import { SupplierMembersService } from "./supplier-members.service";
import { SupplierLeadForm } from "./supplier-lead-form.service";
import { SupplierLeadsController } from "./supplier-leads.controller";
import { SupplierLeadsService } from "./supplier-leads.service";
import { SupplierCabinetController, SuppliersAdminController } from "./suppliers.controller";
import { SuppliersService } from "./suppliers.service";

export interface SuppliersModuleOptions {
  /** Serve the routes (the API process only; the public form needs Redis). */
  http: boolean;
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
  SessionStore,
  SupplierMemberRemover,
  CitiesService,
  SupplierInvitations,
  SupplierMembersService,
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
            SupplierMembersCabinetController,
            SupplierMembersAdminController,
          ]
        : [],
      providers: [...sharedProviders, ...(options.http ? [SupplierLeadForm] : [])],
      exports: [CitiesService, SuppliersService, SupplierLeadsService, DevSupplierSeed],
    };
  }
}

/**
 * The suppliers' background jobs, for the worker process. The invitation
 * of an employee (W-08) goes out through the message gateway (TASK-024):
 * this module turns a queued invitation into a message and answers the
 * gateway's two questions about it (`SupplierInvitationMessages`).
 */
@Module({ providers: [InvitationSender, SupplierInvitationMessages] })
export class SupplierJobsModule implements OnModuleInit {
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(InvitationSender) private readonly sender: InvitationSender,
  ) {}

  onModuleInit(): void {
    this.registry.handle(sendInvitationJob, this.sender);
  }
}

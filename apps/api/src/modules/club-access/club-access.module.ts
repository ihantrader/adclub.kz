import { Module, type DynamicModule } from "@nestjs/common";
import { AccountStore } from "../identity";
import { ClubAccess } from "./club-access";
import { ClubAccessAdminController } from "./club-access.controller";
import { ClubAccessGrants } from "./club-access-grants.service";

export interface ClubAccessModuleOptions {
  /** Serve the admin routes (the API process only). */
  http: boolean;
}

/**
 * Club access of users (D-059; ARCHITECTURE 4.29; TASK-020): the one
 * function every rule of visibility asks (`ClubAccess`) and its only
 * source until the stores' subscriptions — grants by hand
 * (`ClubAccessGrants`: the admin panel and the operator command).
 */
@Module({})
export class ClubAccessModule {
  static forRoot(options: ClubAccessModuleOptions): DynamicModule {
    return {
      module: ClubAccessModule,
      controllers: options.http ? [ClubAccessAdminController] : [],
      providers: [AccountStore, ClubAccess, ClubAccessGrants],
      exports: [ClubAccess, ClubAccessGrants],
    };
  }
}

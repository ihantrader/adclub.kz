import { Module, type DynamicModule } from "@nestjs/common";
import { GarageController } from "./garage.controller";
import { GarageService } from "./garage.service";
import { GarageStore } from "./garage.store";

/**
 * The account's own garage (ARCHITECTURE 4.41, TASK-029): once signed in,
 * the account is the source of truth for a member's cars (PRODUCT 6.4),
 * not the device — the device keeps a copy for offline viewing (mobile
 * side). No dependency on the vehicles or compatibility modules: it stores
 * whatever ids and labels it is given and never computes compatibility
 * itself (that stays the client's job, fed by `/catalog/compatibility/check`).
 */
@Module({})
export class GarageModule {
  static forRoot(options: { http: boolean }): DynamicModule {
    return {
      module: GarageModule,
      controllers: options.http ? [GarageController] : [],
      providers: [GarageStore, GarageService],
      exports: [GarageService],
    };
  }
}

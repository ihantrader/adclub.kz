import { Module, type DynamicModule } from "@nestjs/common";
import { DocumentAttempts, DocumentProofs, PhotoRecognitions } from "../vehicle-document";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
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
 *
 * With TASK-058 a car has a mileage journal, and the mileage is read off a
 * photo of the dashboard through the one way a photo reaches AI
 * (`PhotoRecognitions` of the certificate's module, ARCHITECTURE 4.83).
 */
@Module({})
export class GarageModule {
  static forRoot(options: { http: boolean }): DynamicModule {
    return {
      module: GarageModule,
      controllers: options.http ? [GarageController, DashboardController] : [],
      // `DocumentProofs` has no state but a key derived from the config: the
      // garage checks the proof a car is saved with (TASK-057) with its own.
      // `DocumentAttempts` and `PhotoRecognitions` keep their state in Redis
      // and the database: an instance here counts the very same attempts.
      providers: [
        GarageStore,
        GarageService,
        DocumentProofs,
        DocumentAttempts,
        PhotoRecognitions,
        DashboardService,
      ],
      exports: [GarageService],
    };
  }
}

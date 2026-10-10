import { Module, type DynamicModule } from "@nestjs/common";
import { GarageService, GarageStore } from "../garage";
import { SessionStore } from "../identity";
import { DocumentProofs } from "../vehicle-document";
import { AdminSearch } from "./admin-search.service";
import { AdminUsersService } from "./admin-users.service";
import { PhoneReveals } from "./phone-reveals.service";
import { AdminUsersController } from "./users.controller";

/** The one instance of each module of the process the search and the card ask. */
export interface UsersModuleOptions {
  catalog: DynamicModule;
  clubAccess: DynamicModule;
  suppliers: DynamicModule;
}

/**
 * The users of the app in the admin panel, «Показать номер» and the
 * header's search (TASK-036.B; ARCHITECTURE 4.57; SCREENS A-USR-01…03,
 * A-SEARCH). It owns no table: an account is the identity module's, club
 * access — `ClubAccess`, the garage — the garage module's, the sessions —
 * `SessionStore`; suppliers, requests and items are found by their own
 * modules' list rules.
 */
@Module({})
export class UsersModule {
  static forRoot(options: UsersModuleOptions): DynamicModule {
    return {
      module: UsersModule,
      imports: [options.catalog, options.clubAccess, options.suppliers],
      controllers: [AdminUsersController],
      providers: [
        AdminUsersService,
        PhoneReveals,
        AdminSearch,
        GarageStore,
        GarageService,
        DocumentProofs,
        SessionStore,
      ],
    };
  }
}

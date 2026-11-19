import { Module, type DynamicModule } from "@nestjs/common";
import { SessionStore, SupplierMemberRemover, SupplierMembershipStore } from "../identity";
import { AccountDeletionController } from "./account-deletion.controller";
import { AccountDeletion } from "./account-deletion.service";

export interface AccountDeletionModuleOptions {
  /**
   * The orders module of the application, the very same instance: the
   * active orders are cancelled through its machine (`OrdersService`).
   */
  orders: DynamicModule;
}

/**
 * Deleting the account by the member (TASK-072, D-036, D-077; ARCHITECTURE
 * 4.96): `GET /account/deletion`, `POST /account/delete`. It owns no table:
 * every table it changes keeps its owner's rule — orders are cancelled
 * through the orders' machine, employees removed through
 * `SupplierMemberRemover`.
 */
@Module({})
export class AccountDeletionModule {
  static forRoot(options: AccountDeletionModuleOptions): DynamicModule {
    return {
      module: AccountDeletionModule,
      imports: [options.orders],
      controllers: [AccountDeletionController],
      providers: [AccountDeletion, SupplierMemberRemover, SupplierMembershipStore, SessionStore],
    };
  }
}

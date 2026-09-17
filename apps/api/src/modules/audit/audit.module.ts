import { Global, Module, type DynamicModule } from "@nestjs/common";
import { AccountDirectory, ActionJournal } from "../identity";
import { AuditLogController } from "./audit-log.controller";
import { AuditLog } from "./audit-log.service";
import { AuditLogStore } from "./audit-log.store";

export interface AuditModuleOptions {
  /** Serve the admin route that reads the journal (the API process only). */
  http: boolean;
}

/**
 * The action journal (ARCHITECTURE 4.13, 5.12): `AuditLog.record` in the
 * transaction of the action, and the admin route that reads it. Global —
 * any module records actions without importing this one; the operator
 * command and the worker take it without the HTTP surface.
 */
@Global()
@Module({})
export class AuditModule {
  static forRoot(options: AuditModuleOptions): DynamicModule {
    return {
      module: AuditModule,
      controllers: options.http ? [AuditLogController] : [],
      providers: [
        AccountDirectory,
        AuditLogStore,
        AuditLog,
        // The identity module records through its own port (ActionJournal);
        // this is what stands behind it.
        { provide: ActionJournal, useExisting: AuditLog },
      ],
      exports: [AuditLog, ActionJournal],
    };
  }
}

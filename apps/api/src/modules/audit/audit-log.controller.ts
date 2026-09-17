import { Controller, Inject, Query } from "@nestjs/common";
import {
  apiRoutes,
  auditLogQuerySchema,
  type AuditLogPage,
  type AuditLogQuery,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { SessionRoute } from "../identity";
import { AuditLog } from "./audit-log.service";

/**
 * The action journal in the admin panel (context `admin`; the screen is
 * TASK-034). A mobile session or a cabinet session is refused by the access
 * rule of the route — the journal is not theirs to read.
 */
@Controller()
export class AuditLogController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AuditLog) private readonly audit: AuditLog) {}

  @SessionRoute(apiRoutes.listAuditLog)
  list(
    @Query(new ZodValidationPipe(auditLogQuerySchema)) query: AuditLogQuery,
  ): Promise<AuditLogPage> {
    return this.audit.page(query);
  }
}

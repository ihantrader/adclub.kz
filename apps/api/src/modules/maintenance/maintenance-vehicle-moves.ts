import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { auditActions, auditEntities } from "@adclub/contracts";
import { eq } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { VehicleMoves, type VehicleActor, type VehicleMove } from "../vehicles";
import { scopeOf } from "./maintenance-scope";
import { maintenancePlan } from "./schema";

/**
 * A plan follows a moved model or generation (TASK-061.A; ARCHITECTURE 4.84
 * I946): the administrator moves a model because it was made under the
 * wrong make, and its plan is about the same cars. The base moves the
 * plan's levels and version (`maintenance_plan_follow_*`, in the
 * transaction of the move); this writes `maintenance_plan.changed` of each
 * plan with the area before and after. Whatever the status — an active, a
 * draft, an archived plan follow alike.
 *
 * «One active plan per area» can't be broken by a move: the area's key
 * holds the moved model (generation) itself, and every plan naming it moves
 * together, so no other plan has the new area; the unique index stays the
 * last line.
 */
@Injectable()
export class MaintenanceVehicleMoves implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(VehicleMoves) private readonly moves: VehicleMoves,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  onModuleInit(): void {
    this.moves.register(this);
  }

  async followed(tx: DbExecutor, move: VehicleMove, actor: VehicleActor): Promise<void> {
    const rows = await tx
      .select()
      .from(maintenancePlan)
      .where(
        move.level === "model"
          ? eq(maintenancePlan.modelId, move.id)
          : eq(maintenancePlan.generationId, move.id),
      );
    for (const row of rows) {
      const after = scopeOf(row);
      const before = { ...after, ...move.from };
      await this.audit.record(
        {
          action: auditActions.maintenancePlanChanged,
          actor,
          entityType: auditEntities.maintenancePlan,
          entityId: row.id,
          before: { scope: before },
          after: {
            scope: after,
            version: row.version,
            followed: move.level === "model" ? "vehicle_model" : "vehicle_generation",
          },
        },
        tx,
      );
    }
  }
}

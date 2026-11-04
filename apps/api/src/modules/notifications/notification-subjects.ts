import { Injectable } from "@nestjs/common";
import type { NotificationKind } from "@adclub/contracts";
import type { DbExecutor } from "../../database";

/**
 * «Is this event still current?» — asked about a push before its WhatsApp
 * copy is decided and again before the copy is sent (TASK-052; ARCHITECTURE
 * 4.80 I871). Only the module that owns the subject knows: an order that was
 * cancelled, a reserve whose time has passed, a subscription paid meanwhile
 * — none of them push anything that would supersede the earlier push. The
 * same shape as `MessageSubjects`: a module registers its own subject type
 * in `onModuleInit`; an unregistered type is current (nothing to ask).
 */
export type StillCurrent = (
  tx: DbExecutor,
  subjectId: string,
  kind: NotificationKind,
) => Promise<boolean>;

@Injectable()
export class NotificationSubjects {
  private readonly subjects = new Map<string, StillCurrent>();

  /** A second registration of a type replaces the first (a module may be created twice in one process). */
  register(type: string, stillCurrent: StillCurrent): void {
    this.subjects.set(type, stillCurrent);
  }

  async stillCurrent(
    tx: DbExecutor,
    type: string,
    subjectId: string | null,
    kind: NotificationKind,
  ): Promise<boolean> {
    const check = this.subjects.get(type);
    return !check || subjectId === null ? true : check(tx, subjectId, kind);
  }
}

import { Injectable } from "@nestjs/common";
import type { DbExecutor } from "../../database";
import type { VehicleActor } from "./vehicle-common";

/**
 * A model moved to another make, or a generation to another model (4.24
 * I221), as the modules naming it are told in the transaction of the move.
 * `from` and `to` are the levels above the moved one, before and after.
 */
export type VehicleMove =
  | { level: "model"; id: string; from: { makeId: string }; to: { makeId: string } }
  | {
      level: "generation";
      id: string;
      from: { makeId: string; modelId: string };
      to: { makeId: string; modelId: string };
    };

export interface VehicleMoveListener {
  /** The rows of the module already followed (a trigger of the base); write what it keeps of that. */
  followed(tx: DbExecutor, move: VehicleMove, actor: VehicleActor): Promise<void>;
}

/**
 * The registry modules that depend on the vehicle catalog register in
 * (TASK-061.A; ARCHITECTURE 4.84 I946): the catalog does not know them, the
 * base makes their rows follow a move, and each module writes its own
 * journal of it in the same transaction. Without a listener (a process
 * without the module) the rows still follow — only that entry is missing.
 */
@Injectable()
export class VehicleMoves {
  private readonly listeners: VehicleMoveListener[] = [];

  register(listener: VehicleMoveListener): void {
    this.listeners.push(listener);
  }

  async followed(tx: DbExecutor, move: VehicleMove, actor: VehicleActor): Promise<void> {
    for (const listener of this.listeners) {
      await listener.followed(tx, move, actor);
    }
  }
}

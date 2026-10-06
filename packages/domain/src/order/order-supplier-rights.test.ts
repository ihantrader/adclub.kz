import { describe, expect, it } from "vitest";
import type { SupplierState } from "../supplier/supplier-state";
import { orderActionActor, orderActions } from "./order-machine";
import {
  supplierOrderChannels,
  supplierOrderMoves,
  supplierOrderMoveVerdict,
  type SupplierOrderChannel,
  type SupplierOrderMove,
  type SupplierOrderMoveVerdict,
} from "./order-supplier-rights";

/**
 * The whole table «состояние поставщика × действие × канал» (TASK-033.A,
 * SCREENS 6.0), written out row by row — not computed the way the function
 * computes it.
 */
const table: Record<
  SupplierState,
  Record<SupplierOrderChannel, Record<SupplierOrderMove, SupplierOrderMoveVerdict>>
> = {
  active: {
    supplier_web: {
      accept: "allowed",
      decline: "allowed",
      mark_ready: "allowed",
      close: "allowed",
      close_late: "allowed",
    },
    whatsapp: {
      accept: "allowed",
      decline: "allowed",
      mark_ready: "not_in_channel",
      close: "not_in_channel",
      close_late: "not_in_channel",
    },
  },
  // A pause takes the offers off the showcase, not the orders out of the hands.
  paused: {
    supplier_web: {
      accept: "allowed",
      decline: "allowed",
      mark_ready: "allowed",
      close: "allowed",
      close_late: "allowed",
    },
    whatsapp: {
      accept: "allowed",
      decline: "allowed",
      mark_ready: "not_in_channel",
      close: "not_in_channel",
      close_late: "not_in_channel",
    },
  },
  // SCREENS 6.0: only looking at the orders and giving them out by the code.
  blocked: {
    supplier_web: {
      accept: "supplier_blocked",
      decline: "supplier_blocked",
      mark_ready: "supplier_blocked",
      close: "allowed",
      close_late: "allowed",
    },
    whatsapp: {
      accept: "supplier_blocked",
      decline: "supplier_blocked",
      mark_ready: "not_in_channel",
      close: "not_in_channel",
      close_late: "not_in_channel",
    },
  },
};

describe("supplierOrderMoveVerdict", () => {
  for (const state of ["active", "paused", "blocked"] as const) {
    for (const channel of supplierOrderChannels) {
      for (const action of supplierOrderMoves) {
        it(`${state} × ${action} × ${channel} → ${table[state][channel][action]}`, () => {
          expect(supplierOrderMoveVerdict(state, action, channel)).toBe(
            table[state][channel][action],
          );
        });
      }
    }
  }

  it("knows every move the state machine gives an employee, and only those", () => {
    const supplierActions = orderActions.filter(
      (action) => orderActionActor[action] === "supplier",
    );
    expect([...supplierOrderMoves].sort()).toEqual([...supplierActions].sort());
  });

  it("gives an employee no move that belongs to someone else", () => {
    for (const action of orderActions.filter((a) => orderActionActor[a] !== "supplier")) {
      for (const channel of supplierOrderChannels) {
        expect(supplierOrderMoveVerdict("active", action, channel)).toBe("not_in_channel");
      }
    }
  });
});

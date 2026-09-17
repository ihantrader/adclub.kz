import { describe, expect, it } from "vitest";
import { afterCommit, withAfterCommitScope } from "./after-commit";

/** A stand-in for the database handle: `transaction` commits or rolls back. */
function fakeDb() {
  return withAfterCommitScope({
    async transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      return work({ savepoint: true });
    },
  });
}

describe("afterCommit", () => {
  it("runs the effect only after the transaction finishes", async () => {
    const done: string[] = [];
    const db = fakeDb();

    await db.transaction(async () => {
      afterCommit(() => done.push("logged"));
      done.push("work");
      await Promise.resolve();
    });

    expect(done).toEqual(["work", "logged"]);
  });

  it("does not run the effect when the transaction rolls back", async () => {
    const done: string[] = [];
    const db = fakeDb();

    await expect(
      db.transaction(async () => {
        afterCommit(() => done.push("logged"));
        await Promise.resolve();
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(done).toEqual([]);
  });

  it("runs at once outside a transaction", () => {
    const done: string[] = [];

    afterCommit(() => done.push("logged"));

    expect(done).toEqual(["logged"]);
  });

  it("waits for the outermost transaction when one is nested in another", async () => {
    const done: string[] = [];
    const db = fakeDb();

    await db.transaction(async () => {
      await db.transaction(async () => {
        afterCommit(() => done.push("inner"));
        await Promise.resolve();
      });
      done.push("after inner");
    });

    expect(done).toEqual(["after inner", "inner"]);
  });

  it("never lets a failing effect fail the committed action", async () => {
    const db = fakeDb();

    await expect(
      db.transaction(async () => {
        afterCommit(() => {
          throw new Error("logging failed");
        });
        await Promise.resolve();
        return "committed";
      }),
    ).resolves.toBe("committed");
  });

  it("leaves everything but `transaction` on the handle alone", () => {
    const db = withAfterCommitScope({
      value: 42,
      transaction: async () => undefined,
    });

    expect(db.value).toBe(42);
  });
});

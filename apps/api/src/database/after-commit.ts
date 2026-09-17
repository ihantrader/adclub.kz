import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Work that must happen only once a transaction is really committed —
 * above all writing a line to the application log. Before TASK-009 a
 * sign-in wrote "Session created" while its transaction was still open, so
 * a rollback left a line about a session nobody has (TASK-005 note).
 *
 * The action journal doesn't need this: an entry belongs *inside* the
 * transaction of its action (`AuditLog.record`), which is exactly what
 * makes an action without an entry impossible.
 */

interface TransactionScope {
  effects: (() => void)[];
}

const scope = new AsyncLocalStorage<TransactionScope>();

/**
 * Runs `effect` after the transaction of the current call commits, or at
 * once outside a transaction. An effect that throws is swallowed: it is
 * bookkeeping, and the transaction is already committed.
 */
export function afterCommit(effect: () => void): void {
  const current = scope.getStore();
  if (!current) {
    run(effect);
    return;
  }
  current.effects.push(effect);
}

function run(effect: () => void): void {
  try {
    effect();
  } catch {
    // Never let logging (or anything else deferred) fail a committed action.
  }
}

interface Transactional {
  transaction: (...args: unknown[]) => Promise<unknown>;
}

/**
 * The database handle with `transaction` opening an after-commit scope, so
 * anything a service defers with `afterCommit` happens when — and only
 * when — that transaction commits. Every transaction of the application
 * goes through this handle, so nothing has to be remembered at call sites.
 */
export function withAfterCommitScope<Db extends object>(db: Db): Db {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== "transaction" || typeof value !== "function") {
        return value;
      }
      const original = value as Transactional["transaction"];
      return async (work: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => {
        // A transaction opened inside another one (a savepoint) keeps the
        // outer scope: its effects run when the outermost one commits.
        if (scope.getStore()) {
          return original.call(target, work, ...rest);
        }
        const current: TransactionScope = { effects: [] };
        const result = await scope.run(current, () => original.call(target, work, ...rest));
        for (const effect of current.effects) {
          run(effect);
        }
        return result;
      };
    },
  });
}

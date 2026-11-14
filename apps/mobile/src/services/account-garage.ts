import { createAccountGarage, type AccountGarage } from "../garage/account-garage";
import { accountGarageStore, garageStore, sessionStore } from "../state/stores";
import { apiClient } from "./api";

/**
 * The garage of the signed-in account (TASK-029.B, ARCHITECTURE 4.46): the
 * rules of `garage/account-garage.ts` on the app's API client and stores.
 * One for the app — the garage provider changes cars through it, the
 * session provider syncs it at start, on the way back from the background
 * and when the garage tab opens.
 */
const accountIdNow = () => {
  const session = sessionStore.get();
  return session.status === "signed_in" ? session.session.accountId : null;
};

let loadedAccount: string | null = null;
const loadedListeners = new Set<() => void>();

/**
 * The account whose garage has been read in this launch — synced, or the
 * server did not answer and the copy is what there is (TASK-069.A): a push's
 * request for a car waits for it before it may be dropped.
 */
export const accountGarageLoaded = {
  get: (): string | null => loadedAccount,
  subscribe(listener: () => void): () => void {
    loadedListeners.add(listener);
    return () => {
      loadedListeners.delete(listener);
    };
  },
};

const rules: AccountGarage = createAccountGarage({
  api: {
    list: async () => (await apiClient.listGarageCars()).cars,
    add: (body) => apiClient.addGarageCar(body),
    update: (carId, body) => apiClient.updateGarageCar({ carId }, body),
    remove: async (carId) => {
      await apiClient.removeGarageCar({ carId });
    },
    makePrimary: (carId) => apiClient.setPrimaryGarageCar({ carId }),
    transfer: (body) => apiClient.transferGarage(body),
    recordMileage: (carId, body) => apiClient.recordGarageCarMileage({ carId }, body),
  },
  copy: accountGarageStore,
  guest: garageStore,
  accountId: accountIdNow,
});

export const accountGarage: AccountGarage = {
  ...rules,
  async sync() {
    const accountId = accountIdNow();
    const result = await rules.sync();
    // «stale» — a change's own sync follows; «skipped» — nobody to read for.
    if (
      (result.kind === "synced" || result.kind === "failed") &&
      accountId !== null &&
      accountIdNow() === accountId &&
      loadedAccount !== accountId
    ) {
      loadedAccount = accountId;
      for (const listener of loadedListeners) listener();
    }
    return result;
  },
};

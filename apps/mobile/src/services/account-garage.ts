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
export const accountGarage: AccountGarage = createAccountGarage({
  api: {
    list: async () => (await apiClient.listGarageCars()).cars,
    add: (body) => apiClient.addGarageCar(body),
    update: (carId, body) => apiClient.updateGarageCar({ carId }, body),
    remove: async (carId) => {
      await apiClient.removeGarageCar({ carId });
    },
    makePrimary: (carId) => apiClient.setPrimaryGarageCar({ carId }),
    transfer: (body) => apiClient.transferGarage(body),
  },
  copy: accountGarageStore,
  guest: garageStore,
  accountId: () => {
    const session = sessionStore.get();
    return session.status === "signed_in" ? session.session.accountId : null;
  },
});

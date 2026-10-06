import type {
  SessionAccess,
  SupplierCard,
  SupplierCompanyResponse,
  SupplierMembershipListResponse,
} from "@adclub/contracts";
import { useSyncExternalStore } from "react";
import { apiClient, onContextChanged, session } from "../api";
import { rememberSupplier, storeLastKnown } from "../prefs";

type SupplierAccess = Extract<SessionAccess, { context: "supplier" }>;

/**
 * Who works in the cabinet now and for which company: `GET /auth/me` (the
 * company and the employee of the session) and `GET /supplier/company` (its
 * card — name, state, schedule). Every page reads the company from here;
 * a switch of company (here or in another tab) replaces both, and the
 * pages are keyed by the company, so nothing of the previous one stays on
 * screen (TASK-031 business rules).
 */
export type CabinetState =
  | { status: "idle" }
  | {
      status: "loading";
      /**
       * Loading another company of the same employee (a switch here or in
       * another tab): the frame stays, with the name of the company switched
       * to when it is known, and the page fades into its loading state — nothing
       * of the previous company is on screen, and no flash of an empty page.
       */
      switchingTo?: { supplierName: string; memberName: string };
    }
  | { status: "failed"; error: unknown }
  | {
      status: "ready";
      access: SupplierAccess;
      company: SupplierCompanyResponse;
      /** The companies the employee works for (S-AUTH-03; «Сменить компанию» if more than one). */
      companies: SupplierMembershipListResponse["suppliers"];
      /** Bumped on every switch of company: the key the pages remount on. */
      generation: number;
    };

let state: CabinetState = { status: "idle" };
let generation = 0;
const listeners = new Set<() => void>();

function set(next: CabinetState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

/** Loads the employee and the company of the session; `reset` drops what is on screen first. */
export async function loadCabinet(
  options: { reset?: boolean; switchingTo?: string } = {},
): Promise<void> {
  if (options.reset || state.status !== "ready") {
    set({ status: "loading", switchingTo: switchingFrom(state, options.switchingTo) });
  }
  try {
    const [me, company, memberships] = await Promise.all([
      apiClient.getCurrentAccount(),
      apiClient.getSupplierCompany(),
      apiClient.listMySuppliers(),
    ]);
    if (me.access.context !== "supplier") {
      set({ status: "failed", error: new Error("Not a supplier cabinet session") });
      return;
    }
    const switched = state.status !== "ready" || state.access.supplier.id !== me.access.supplier.id;
    if (switched) generation += 1;
    set({
      status: "ready",
      access: me.access,
      company,
      companies: memberships.suppliers,
      generation,
    });
    storeLastKnown({
      supplierName: company.supplier.name,
      memberName: me.access.member.displayName,
    });
  } catch (error) {
    // What is on screen stays; only a first load shows the error.
    if (state.status !== "ready") set({ status: "failed", error });
  }
}

/** The frame kept while another company of the same employee loads. */
function switchingFrom(
  current: CabinetState,
  supplierId: string | undefined,
): { supplierName: string; memberName: string } | undefined {
  if (current.status === "loading") return current.switchingTo;
  if (current.status !== "ready") return undefined;
  const target = current.companies.find((company) => company.id === supplierId);
  return { supplierName: target?.name ?? "", memberName: current.access.member.displayName };
}

/** The card after an edit (S-COMP-01) or a reload of the company. */
export function setCompanyCard(card: SupplierCard): void {
  if (state.status !== "ready" || state.company.company.id !== card.id) return;
  set({
    ...state,
    company: {
      supplier: { ...state.company.supplier, name: card.name, status: card.state },
      company: card,
    },
  });
}

/** Re-reads the company card (its state can change any time: a pause by the administrator). */
export async function refreshCompany(): Promise<void> {
  if (state.status !== "ready") return;
  try {
    const company = await apiClient.getSupplierCompany();
    if (state.status === "ready" && state.company.company.id === company.company.id) {
      set({ ...state, company });
    } else {
      await loadCabinet({ reset: true });
    }
  } catch {
    // The banner of the network says it; the page keeps what it has.
  }
}

/**
 * Switches the session to another company (`POST /auth/supplier-context`):
 * the pages of the previous one are dropped at once, the choice is
 * remembered for the next sign-in, and the other tabs follow.
 */
export async function switchCompany(supplierId: string): Promise<void> {
  await apiClient.switchSupplier({ supplierId });
  rememberSupplier(supplierId);
  session.contextChanged();
  await loadCabinet({ reset: true, switchingTo: supplierId });
}

/** Forgets the person when the session is over. */
export function clearCabinet(): void {
  set({ status: "idle" });
}

export function useCabinet(): CabinetState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

onContextChanged(() => void loadCabinet({ reset: true }));

import { useEffect, useState } from "react";
import { apiClient } from "../api";

/**
 * The administrators by id → their name or number partly hidden, for the
 * journals that name an administrator only by id (an order's journal, a
 * mark's lifting). Loaded once per page; an empty map until it comes.
 */
export function useAdminNames(): Map<string, string | null> {
  const [names, setNames] = useState<Map<string, string | null>>(new Map());
  useEffect(() => {
    let cancelled = false;
    apiClient.listAdministrators().then(
      (answer) => {
        if (cancelled) return;
        setNames(
          new Map(
            answer.administrators.map((admin) => [admin.id, admin.name ?? admin.phoneMasked]),
          ),
        );
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return names;
}

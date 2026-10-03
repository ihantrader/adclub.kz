import { useEffect } from "react";
import { useSession } from "../state/session-provider";

/**
 * The screens of the signed-in profile (`profile-my-data`, `profile-devices`)
 * belong to a session: when it ends under them — ended from another device,
 * a refused exchange, «Выйти» — they go away to the profile itself, which is
 * the guest view by then. Left open they would stay in the tab's stack and
 * come back with the old session's data when the Profile tab is touched
 * (found in the browser walk-through of TASK-029.A).
 */
export function useLeaveWhenSignedOut(navigation: { popToTop: () => void }): void {
  const { status } = useSession();
  useEffect(() => {
    if (status === "guest") {
      navigation.popToTop();
    }
  }, [status, navigation]);
}

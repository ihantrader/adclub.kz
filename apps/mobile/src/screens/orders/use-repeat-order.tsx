import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { useToast } from "../../design-system";
import { ROOT_NAVIGATOR, type RootParams } from "../../navigation/routes";
import { apiClient } from "../../services/api";
import { useT } from "../../state/language";
import { ClubAccessSheet } from "./ClubAccessSheet";

/**
 * «Повторить» / «Повторить заказ» (TASK-030 requirement 5): the app asks the
 * server what can be done right now (`GET /orders/{id}/repeat`) and does
 * exactly that — no second way to make an order, no guess of its own:
 *
 * - `offer` → the checkout of the same offer, with its price as it is
 *   today (and «Цена изменилась» when it is not the old one), filled in with
 *   the quantity and the way to get it of the finished order;
 * - `catalog` → the card of the item, saying why the same offer is not here;
 * - `unavailable` → a plain reason, or the stand-in for the subscription.
 */
export function useRepeatOrder() {
  const t = useT();
  const toast = useToast();
  const navigation = useNavigation();
  const [pending, setPending] = useState<string | null>(null);
  const [clubSheet, setClubSheet] = useState(false);

  const repeat = useCallback(
    async (orderId: string) => {
      const root =
        navigation.getParent<NativeStackNavigationProp<RootParams>>(ROOT_NAVIGATOR) ??
        (navigation as unknown as NativeStackNavigationProp<RootParams>);
      setPending(orderId);
      try {
        const answer = await apiClient.getOrderRepeat({ orderId });
        switch (answer.result) {
          case "offer":
            root.push("order-checkout", {
              itemId: answer.item.id,
              offerId: answer.offer.id,
              preset: {
                quantity: answer.previous.quantity,
                fulfillment: answer.previous.fulfillment,
              },
              previousPrice: answer.previous.unitPrice,
            });
            return;
          case "catalog":
            root.navigate("tabs", {
              screen: "catalog",
              params: {
                screen: "catalog-item",
                params: {
                  itemId: answer.item.id,
                  title: answer.item.name.text,
                  notice: answer.reason,
                },
                initial: false,
              },
            });
            return;
          default:
            if (answer.reason === "club_access_required") setClubSheet(true);
            else if (answer.reason === "item_unavailable") toast.show(t("repeat.itemGone"));
            else toast.show(t("repeat.notSupported"));
        }
      } catch {
        toast.show(t("repeat.failed"));
      } finally {
        setPending(null);
      }
    },
    [navigation, t, toast],
  );

  return {
    repeat,
    /** The order whose «Повторить» is being asked about. */
    pending,
    sheet: <ClubAccessSheet visible={clubSheet} onClose={() => setClubSheet(false)} />,
  };
}

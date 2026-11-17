import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import type { AssistantLimitSheet } from "../../assistant/assistant-rules";
import { ROOT_NAVIGATOR, type RootParams } from "../../navigation/routes";
import { AssistantLimitSheetView } from "../assistant/AssistantSheets";
import { VoiceSheet, type VoiceSheetProps } from "./VoiceSheet";

/**
 * The voice sheet with M-AI-02 behind it (TASK-060), for a field that has no
 * limit sheet of its own — the mileage, the reminder's question, a car to
 * add: a limit spent closes the voice sheet and opens M-AI-02 («Войти» —
 * the sign-in above whatever screen asked; «В каталог» of the day's limit —
 * back to the field, since the field is the way without voice).
 */
export function VoiceInput(props: Omit<VoiceSheetProps, "onLimit">) {
  const navigation = useNavigation();
  const [limit, setLimit] = useState<AssistantLimitSheet | null>(null);
  const signIn = () => {
    // The screens of a car and of the mileage live on the root stack itself.
    const root =
      navigation.getParent<NativeStackNavigationProp<RootParams>>(ROOT_NAVIGATOR) ??
      (navigation as unknown as NativeStackNavigationProp<RootParams>);
    const routes = root.getState().routes;
    if (routes[routes.length - 1]?.name === "auth-phone") return;
    root.push("auth-phone");
  };
  return (
    <>
      <VoiceSheet {...props} onLimit={setLimit} />
      <AssistantLimitSheetView
        sheet={limit}
        onClose={() => setLimit(null)}
        onSignIn={signIn}
        onCatalog={props.onType}
      />
    </>
  );
}

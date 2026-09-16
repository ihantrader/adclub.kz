import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { language } from "./src/config/environment";
import { HomeScreen } from "./src/screens/HomeScreen";
import { UpdateRequiredScreen } from "./src/screens/UpdateRequiredScreen";
import { updateGate } from "./src/services/api";
import { shouldShowUpdateScreen, useUpdateGateState } from "./src/update-gate";

export default function App() {
  const updateState = useUpdateGateState(updateGate);

  useEffect(() => {
    void updateGate.check();
  }, []);

  return (
    <>
      {shouldShowUpdateScreen(updateState) ? (
        <UpdateRequiredScreen
          lang={language}
          message={updateState.message}
          onCheckAgain={updateGate.check}
        />
      ) : (
        <HomeScreen lang={language} />
      )}
      <StatusBar style="auto" />
    </>
  );
}

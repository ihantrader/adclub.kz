import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { DevicesScreen } from "../screens/profile/DevicesScreen";
import { DocumentsScreen } from "../screens/profile/DocumentsScreen";
import { MyDataScreen } from "../screens/profile/MyDataScreen";
import { ProfileScreen } from "../screens/tabs/ProfileScreen";
import type { ProfileStackParams } from "./routes";
import { useStackScreenOptions } from "./use-stack-screen-options";

const Stack = createNativeStackNavigator<ProfileStackParams>();

/**
 * The profile tab (TASK-029): the profile itself (M-PRO-01, guest or
 * signed in), "Мои данные" (M-PRO-02), "Устройства" (M-PRO-03) and
 * «Документы и поддержка» (M-PRO-06, TASK-077) — a stack
 * of its own, like the garage and the catalog (ARCHITECTURE 4.37 I384).
 */
export function ProfileStack() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="profile-home" component={ProfileScreen} />
      <Stack.Screen name="profile-my-data" component={MyDataScreen} />
      <Stack.Screen name="profile-devices" component={DevicesScreen} />
      <Stack.Screen name="profile-documents" component={DocumentsScreen} />
    </Stack.Navigator>
  );
}

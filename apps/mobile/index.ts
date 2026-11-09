import { registerRootComponent } from "expo";

import App from "./App";
import { defineBackgroundAckTask } from "./src/push/background-ack-task";

// The background task that confirms a push while the app is closed (TASK-056,
// ARCHITECTURE 4.81) must be defined at the top level, before the root
// component: a push may start the JS without any screen (Android headless).
// Only in an own build — Expo Go and the browser skip it.
defineBackgroundAckTask();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

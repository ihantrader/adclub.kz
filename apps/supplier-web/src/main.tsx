import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app.css";
import { listenForInstall } from "./pwa/install";
import { registerServiceWorker } from "./pwa/service-worker";
import { AppProviders } from "./theme";

const root = createRoot(document.getElementById("root")!);

// The component showcase exists only in development builds: in production
// `import.meta.env.DEV` is false and the dynamic import is dropped.
if (import.meta.env.DEV && window.location.pathname === "/showcase") {
  void import("./dev/showcase").then(({ renderShowcase }) => renderShowcase(root));
} else {
  // The browser offers installing early, before the first screen is drawn.
  listenForInstall();
  registerServiceWorker();
  root.render(
    <StrictMode>
      <AppProviders>
        <App />
      </AppProviders>
    </StrictMode>,
  );
}

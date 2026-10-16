import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app.css";
import { JOIN_PATH, JoinPage } from "./join/JoinPage";
import { listenForInstall } from "./pwa/install";
import { registerServiceWorker } from "./pwa/service-worker";
import { AppProviders } from "./theme";

const root = createRoot(document.getElementById("root")!);
const path = window.location.pathname.replace(/\/+$/, "");

// The component showcase exists only in development builds: in production
// `import.meta.env.DEV` is false and the dynamic import is dropped.
if (import.meta.env.DEV && path === "/showcase") {
  void import("./dev/showcase").then(({ renderShowcase }) => renderShowcase(root));
} else if (path === JOIN_PATH) {
  // S-PUB-01 (TASK-077): a public page, no session — not even its exchange.
  root.render(
    <StrictMode>
      <AppProviders>
        <JoinPage />
      </AppProviders>
    </StrictMode>,
  );
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

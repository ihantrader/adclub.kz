import { Showcase } from "@adclub/ui-showcase";
import { StrictMode } from "react";
import type { Root } from "react-dom/client";
import { AppProviders } from "../theme";

/** Development-only component showcase: http://localhost:<port>/showcase (TASK-075). */
export function renderShowcase(root: Root): void {
  root.render(
    <StrictMode>
      <AppProviders>
        <Showcase app="supplier" />
      </AppProviders>
    </StrictMode>,
  );
}

import { Button } from "@adclub/ui";
import { languages, translate, type Lang } from "@adclub/i18n";
import { useState } from "react";

export function App() {
  const [lang, setLang] = useState<Lang>("ru");

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "24px", maxWidth: "480px" }}>
      <h1>adclub.kz — {translate(lang, "common.appWorking")}</h1>
      <p>Supplier cabinet scaffold (TASK-001).</p>

      <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
        {languages.map((candidate) => (
          <Button
            key={candidate}
            variant={candidate === lang ? "primary" : "neutral"}
            onClick={() => setLang(candidate)}
          >
            {candidate.toUpperCase()}
          </Button>
        ))}
      </div>
    </main>
  );
}

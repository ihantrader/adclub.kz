import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serviceWorkerSource, shellFiles } from "./service-worker-plugin";

const template = readFileSync(new URL("./service-worker.js", import.meta.url), "utf8");

describe("the cabinet's service worker", () => {
  it("keeps the files the shell needs offline, not maps, the page or itself", () => {
    expect(
      shellFiles([
        "index.html",
        "sw.js",
        "assets/index-3f9a.js",
        "assets/index-3f9a.js.map",
        "assets/index-77ab.css",
        "assets/onest-400-aa11.woff2",
        "icons/icon-192.png",
        "manifest.webmanifest",
        "favicon.svg",
        "favicon.svg",
      ]),
    ).toEqual([
      "/assets/index-3f9a.js",
      "/assets/index-77ab.css",
      "/assets/onest-400-aa11.woff2",
      "/favicon.svg",
      "/icons/icon-192.png",
      "/manifest.webmanifest",
    ]);
  });

  it("is a new worker for a new build and the same one for the same build", () => {
    const one = serviceWorkerSource(template, ["/assets/a-1.js"], "<html>1</html>");
    const same = serviceWorkerSource(template, ["/assets/a-1.js"], "<html>1</html>");
    const newer = serviceWorkerSource(template, ["/assets/a-2.js"], "<html>1</html>");
    const newPage = serviceWorkerSource(template, ["/assets/a-1.js"], "<html>2</html>");
    expect(one).toBe(same);
    expect(newer).not.toBe(one);
    expect(newPage).not.toBe(one);
    expect(one).toContain('const FILES = ["/assets/a-1.js"];');
    expect(one).not.toContain("__VERSION__");
    expect(one).not.toContain("__FILES__");
  });

  it("never touches requests to another origin, such as the API", () => {
    expect(template).toContain("if (url.origin !== self.location.origin) return;");
    expect(template).toContain('if (request.method !== "GET") return;');
  });
});

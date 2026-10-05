// The supplier cabinet over HTTPS in the local network (TASK-031,
// ARCHITECTURE 4.47): for checking it on a real iPhone or Android phone in
// the same Wi-Fi. The session cookie is `Secure` and a service worker needs
// a secure context, so plain http://<machine>:5175 is not enough on a phone,
// and neither is weakened (`Secure`/`SameSite` stay as they are).
//
//   pnpm dev:lan               build the cabinet, then serve it (see below)
//   pnpm dev:lan --no-build    serve the last build
//   pnpm dev:lan --host 192.168.1.5   when the machine has several networks
//
// What it does:
//   1. Makes, once, a local certificate authority in .dev-https/ (git-ignored;
//      limited by name constraints to private networks and localhost, so it
//      can't vouch for any public site even if its key leaked) and, whenever
//      the machine's address changes, a server certificate for that address.
//   2. Adds https://<address>:5443 to SUPPLIER_WEB_ORIGINS in .env (the API
//      accepts the cookie exchange only from known origins) — restart the
//      API after that.
//   3. Serves the production build of the cabinet at https://<address>:5443
//      (with its service worker), a TLS proxy to the API (http://127.0.0.1:3000)
//      at https://<address>:3443, and a helper page at http://<address>:5480
//      to download the certificate onto the phone.
//
// The API and the worker run as usual (`pnpm dev` or `pnpm --filter api dev`).
// Needs `openssl` (Git for Windows has one; it is found there if not on PATH).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { hostname, networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const certDir = join(root, ".dev-https");
const dist = join(root, "apps", "supplier-web", "dist");
const PORTS = { cabinet: 5443, api: 3443, helper: 5480 };
const API_TARGET = { host: "127.0.0.1", port: 3000 };
const DEFAULT_ORIGINS = ["http://localhost:5175", "http://127.0.0.1:5175"];

const args = process.argv.slice(2);
const hostArg = args.includes("--host") ? args[args.indexOf("--host") + 1] : undefined;

function privateAddress(address) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
}

function lanAddresses() {
  if (hostArg) return [hostArg];
  // Virtual adapters (WSL, Hyper-V, VirtualBox, VMware) are not the Wi-Fi a phone is on.
  const found = Object.entries(networkInterfaces())
    .filter(([name]) => !/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|docker/i.test(name))
    .flatMap(([, items]) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address)
    .filter(privateAddress);
  if (found.length === 0) {
    console.error("No private IPv4 address found: is the machine on Wi-Fi? Or pass --host <ip>.");
    process.exit(1);
  }
  return [...new Set(found)];
}

function findOpenssl() {
  const candidates = [
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  console.error(
    "openssl is not found. Install Git for Windows (it brings openssl) or add it to PATH.",
  );
  process.exit(1);
}

function openssl(binary, argsList) {
  // Quiet unless it fails: the error then carries what openssl said.
  execFileSync(binary, argsList, { stdio: ["ignore", "pipe", "pipe"] });
}

function ensureCertificates(addresses) {
  mkdirSync(certDir, { recursive: true });
  const binary = findOpenssl();
  const file = (name) => join(certDir, name);

  if (!existsSync(file("ca.crt")) || !existsSync(file("ca.key"))) {
    const caExtensions = [
      "basicConstraints=critical,CA:true,pathlen:0",
      "keyUsage=critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier=hash",
      // Only private networks and localhost: never a public site.
      "nameConstraints=critical,permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0,permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:127.0.0.0/255.0.0.0,permitted;DNS:localhost",
    ].join("\n");
    openssl(binary, [
      "req",
      "-x509",
      "-new",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "3650",
      "-keyout",
      file("ca.key"),
      "-out",
      file("ca.crt"),
      "-subj",
      `/O=Asia Drive Club dev/CN=Asia Drive Club dev CA (${hostname()})`,
      "-extensions",
      "v3_ca",
      "-config",
      writeOpensslConfig(file("ca-req.cnf"), caExtensions),
    ]);
    writeFileSync(file("ca.der"), derOf(binary, file("ca.crt")));
    console.log("Made a local certificate authority in .dev-https/");
  }

  const san = [...addresses.map((address) => `IP:${address}`), "IP:127.0.0.1", "DNS:localhost"];
  const sanText = san.join(",");
  const current = existsSync(file("server.san")) ? readFileSync(file("server.san"), "utf8") : "";
  const expiresSoon =
    existsSync(file("server.crt")) &&
    Date.now() - statSync(file("server.crt")).mtimeMs > 300 * 86_400_000;
  if (current !== sanText || !existsSync(file("server.crt")) || expiresSoon) {
    writeFileSync(
      file("server.ext"),
      [
        "basicConstraints=CA:false",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=${sanText}`,
      ].join("\n"),
    );
    openssl(binary, [
      "req",
      "-new",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-keyout",
      file("server.key"),
      "-out",
      file("server.csr"),
      "-subj",
      `/O=Asia Drive Club dev/CN=${addresses[0]}`,
    ]);
    // 397 days: Apple refuses longer-lived server certificates.
    openssl(binary, [
      "x509",
      "-req",
      "-sha256",
      "-days",
      "397",
      "-in",
      file("server.csr"),
      "-CA",
      file("ca.crt"),
      "-CAkey",
      file("ca.key"),
      "-CAcreateserial",
      "-out",
      file("server.crt"),
      "-extfile",
      file("server.ext"),
    ]);
    writeFileSync(file("server.san"), sanText);
    console.log(`Made a server certificate for ${sanText}`);
  }
  return {
    key: readFileSync(file("server.key")),
    cert: readFileSync(file("server.crt")),
    ca: readFileSync(file("ca.crt")),
    caDer: readFileSync(file("ca.der")),
  };
}

function writeOpensslConfig(path, extensions) {
  writeFileSync(path, ["[req]", "distinguished_name=dn", "[dn]", "[v3_ca]", extensions].join("\n"));
  return path;
}

function derOf(binary, pem) {
  return execFileSync(binary, ["x509", "-in", pem, "-outform", "DER"]);
}

/** Adds the cabinet's HTTPS origins to SUPPLIER_WEB_ORIGINS in .env; `true` — changed. */
function ensureOrigins(addresses) {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) {
    console.error("No .env in the repository root: copy .env.example to .env first (CLAUDE.md 0).");
    process.exit(1);
  }
  const text = readFileSync(envPath, "utf8");
  const line = /^SUPPLIER_WEB_ORIGINS=(.*)$/m.exec(text);
  const existing = line
    ? line[1]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : DEFAULT_ORIGINS;
  const wanted = addresses.map((address) => `https://${address}:${PORTS.cabinet}`);
  const missing = wanted.filter((origin) => !existing.includes(origin));
  if (missing.length === 0) return false;
  const next = `SUPPLIER_WEB_ORIGINS=${[...existing, ...missing].join(",")}`;
  writeFileSync(
    envPath,
    line ? text.replace(line[0], next) : `${text.replace(/\s*$/, "\n")}${next}\n`,
  );
  return true;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

/** The production build, as a host of the cabinet serves it: files, else the page (SPA). */
function serveCabinet(request, response) {
  const url = new URL(request.url ?? "/", "https://cabinet");
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
  let path = join(dist, relative);
  if (!path.startsWith(dist + sep) && path !== dist) {
    response.writeHead(400).end();
    return;
  }
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(dist, "index.html");
  const name = path
    .slice(dist.length + 1)
    .split(sep)
    .join("/");
  const headers = { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" };
  // The page and the worker are checked on every opening; hashed files never change.
  headers["Cache-Control"] =
    name === "index.html" || name === "sw.js"
      ? "no-cache"
      : name.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600";
  response.writeHead(200, headers);
  response.end(readFileSync(path));
}

/** TLS in front of the API: the request goes on unchanged, the answer comes back unchanged. */
function proxyApi(request, response) {
  const upstream = http.request(
    {
      ...API_TARGET,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, "x-forwarded-proto": "https" },
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain" });
    response.end("The API at http://127.0.0.1:3000 is not running");
  });
  request.pipe(upstream);
}

function helperPage(addresses) {
  const cabinet = `https://${addresses[0]}:${PORTS.cabinet}`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Кабинет поставщика — проверка на телефоне</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;line-height:1.5}
a.button{display:block;padding:14px 16px;margin:12px 0;border-radius:6px;background:#16171A;color:#D4B483;text-decoration:none;text-align:center}
li{margin:8px 0}code{background:#eee;padding:1px 4px;border-radius:3px}</style></head><body>
<h1>Кабинет поставщика на телефоне</h1>
<p>Один раз на каждый телефон — доверить сертификат этой машины разработки. Он подходит только для адресов локальной сети и <code>localhost</code>.</p>
<a class="button" href="/adclub-dev-ca.crt">1. Скачать сертификат</a>
<h2>iPhone</h2>
<ol><li>Откройте эту страницу в Safari и нажмите «Скачать сертификат» → «Разрешить».</li>
<li>Настройки → «Профиль загружен» → «Установить» (код телефона) → «Установить».</li>
<li>Настройки → Основные → Об этом устройстве → Доверие сертификатам → включите «Asia Drive Club dev CA».</li></ol>
<h2>Android</h2>
<ol><li>Нажмите «Скачать сертификат».</li>
<li>Настройки → Безопасность → Шифрование и учётные данные → Установить сертификат → Сертификат ЦС → выберите скачанный файл.</li></ol>
<a class="button" href="${cabinet}/">2. Открыть кабинет: ${cabinet}</a>
<p>После проверки сертификат можно удалить: iPhone — Настройки → Основные → VPN и управление устройством; Android — Учётные данные пользователя.</p>
</body></html>`;
}

const addresses = lanAddresses();
const tls = ensureCertificates(addresses);
const envChanged = ensureOrigins(addresses);

if (!args.includes("--no-build")) {
  const build = spawnSync("pnpm", ["--filter", "@adclub/supplier-web", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
if (!existsSync(join(dist, "index.html"))) {
  console.error("No build of the cabinet: run without --no-build.");
  process.exit(1);
}

const options = { key: tls.key, cert: tls.cert, ca: tls.ca };
https.createServer(options, serveCabinet).listen(PORTS.cabinet, "0.0.0.0");
https.createServer(options, proxyApi).listen(PORTS.api, "0.0.0.0");
http
  .createServer((request, response) => {
    if (request.url === "/adclub-dev-ca.crt") {
      response.writeHead(200, {
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition": 'attachment; filename="adclub-dev-ca.crt"',
      });
      response.end(tls.caDer);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(helperPage(addresses));
  })
  .listen(PORTS.helper, "0.0.0.0");

console.log("");
console.log("Supplier cabinet over HTTPS in the local network:");
for (const address of addresses) {
  console.log(
    `  on the phone, first:  http://${address}:${PORTS.helper}   (certificate and steps)`,
  );
  console.log(`  the cabinet:          https://${address}:${PORTS.cabinet}`);
  console.log(`  the API through TLS:  https://${address}:${PORTS.api} -> http://127.0.0.1:3000`);
}
if (envChanged) {
  console.log("");
  console.log("SUPPLIER_WEB_ORIGINS in .env now includes the cabinet's HTTPS origin:");
  console.log("restart the API (and the worker) so that it accepts the session cookie from it.");
}
console.log("");
console.log("Windows may ask to let Node.js through the firewall: allow it for private networks.");

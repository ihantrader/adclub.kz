import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Downloads the picture of a search result (TASK-068; ARCHITECTURE 4.95) —
 * an address that came from the internet, so every rule here is about not
 * letting it reach where it must not (SSRF):
 *
 * - only `http:` and `https:`, only the standard ports 80 and 443;
 * - **the address is checked after DNS**: the connection is made to an
 *   address the guarded lookup approved, the one `http.request` then uses —
 *   no second resolution between the check and the connection (a name that
 *   answers once with a public address and then with 127.0.0.1 doesn't
 *   slip through). A literal IP in the URL is checked the same way;
 * - private, loopback, link-local, reserved, multicast, carrier-grade NAT,
 *   documentation ranges and their IPv6 forms (mapped IPv4, ULA, NAT64)
 *   are refused;
 * - redirects are followed by hand, at most three, and each new address is
 *   checked again; a redirect to another scheme is refused;
 * - a time limit for the whole download, and a size limit that stops the
 *   reading (the declared length is not trusted).
 *
 * What the bytes are is decided afterwards by the photo checks of an upload
 * (`photo-image.ts`), as for any other file.
 */

export type FetchRefusal = "private_address" | "download_failed" | "too_large";

export class PhotoFetchRefused extends Error {
  constructor(
    readonly reason: FetchRefusal,
    detail: string,
  ) {
    super(`The picture was not downloaded: ${reason} (${detail})`);
    this.name = "PhotoFetchRefused";
  }
}

export interface PhotoFetcher {
  /** The bytes of the picture, at most `maxBytes`; `PhotoFetchRefused` otherwise. */
  fetch(url: string, maxBytes: number): Promise<Buffer>;
}

/** Ranges no picture of the internet is downloaded from. */
function blockedRanges(): BlockList {
  const list = new BlockList();
  const v4: [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  for (const [network, prefix] of v4) list.addSubnet(network, prefix, "ipv4");
  const v6: [string, number][] = [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ];
  for (const [network, prefix] of v6) list.addSubnet(network, prefix, "ipv6");
  return list;
}

const BLOCKED = blockedRanges();

/** The IPv4 address inside an IPv6 one that carries it (mapped, NAT64), or `null`. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = Number.parseInt(hex[1]!, 16);
    const low = Number.parseInt(hex[2]!, 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return null;
}

/** `true` — not an address of the public internet; nothing is downloaded from it. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const inner = embeddedIpv4(address);
    if (inner && BLOCKED.check(inner, "ipv4")) return true;
    return BLOCKED.check(address, "ipv6");
  }
  return BLOCKED.check(address, "ipv4");
}

export interface HttpPhotoFetcherOptions {
  /** The resolver; the system's by default (tests give their own). */
  resolve?: (host: string) => Promise<LookupAddress[]>;
  /** What counts as a forbidden address; tests allow their local server. */
  isBlocked?: (address: string) => boolean;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Ports a picture may come from. */
  ports?: readonly number[];
}

function systemResolve(host: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

/** The real downloader: `node:http(s)` with the guarded lookup. */
export class HttpPhotoFetcher implements PhotoFetcher {
  private readonly resolve: (host: string) => Promise<LookupAddress[]>;
  private readonly isBlocked: (address: string) => boolean;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly ports: readonly number[];

  constructor(options: HttpPhotoFetcherOptions = {}) {
    this.resolve = options.resolve ?? systemResolve;
    this.isBlocked = options.isBlocked ?? isBlockedAddress;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.ports = options.ports ?? [80, 443];
  }

  async fetch(url: string, maxBytes: number): Promise<Buffer> {
    const deadline = Date.now() + this.timeoutMs;
    let current = url;
    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      const answer = await this.once(current, maxBytes, deadline);
      if (answer.kind === "bytes") return answer.bytes;
      current = answer.location;
    }
    throw new PhotoFetchRefused("download_failed", "too many redirects");
  }

  /** The URL as one we may go to; the reason otherwise. */
  private target(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PhotoFetchRefused("download_failed", "not an address");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new PhotoFetchRefused("download_failed", "not http(s)");
    }
    if (parsed.username || parsed.password) {
      throw new PhotoFetchRefused("download_failed", "credentials in the address");
    }
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (!this.ports.includes(port)) {
      throw new PhotoFetchRefused("download_failed", "port");
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0 && this.isBlocked(host)) {
      throw new PhotoFetchRefused("private_address", "literal address");
    }
    return parsed;
  }

  /**
   * The lookup `http.request` connects by: it resolves once, refuses the
   * whole name if any of its addresses is forbidden, and hands the
   * connection an approved address — the check and the connection use the
   * same answer.
   */
  private guardedLookup(): LookupFunction {
    return (hostname, options, callback) => {
      this.resolve(hostname).then(
        (addresses) => {
          const usable = addresses.filter((entry) => entry.family === 4 || entry.family === 6);
          if (usable.length === 0) {
            callback(new PhotoFetchRefused("download_failed", "no address"), "", 4);
            return;
          }
          if (usable.some((entry) => this.isBlocked(entry.address))) {
            callback(new PhotoFetchRefused("private_address", "resolved address"), "", 4);
            return;
          }
          if ((options as { all?: boolean }).all) {
            (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(
              null,
              usable,
            );
            return;
          }
          callback(null, usable[0]!.address, usable[0]!.family);
        },
        (error: unknown) =>
          callback(
            new PhotoFetchRefused(
              "download_failed",
              error instanceof Error ? error.message : "lookup failed",
            ),
            "",
            4,
          ),
      );
    };
  }

  private once(
    url: string,
    maxBytes: number,
    deadline: number,
  ): Promise<{ kind: "bytes"; bytes: Buffer } | { kind: "redirect"; location: string }> {
    const target = this.target(url);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.reject(new PhotoFetchRefused("download_failed", "timeout"));
    }
    const client = target.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const request = client.request(
        target,
        {
          method: "GET",
          lookup: this.guardedLookup(),
          headers: {
            Accept: "image/jpeg, image/png, image/webp, image/*;q=0.5",
            "User-Agent": "adclub-photo-check/1.0",
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            let next: string;
            try {
              next = new URL(response.headers.location, target).toString();
            } catch {
              finish(() => reject(new PhotoFetchRefused("download_failed", "bad redirect")));
              return;
            }
            finish(() => resolve({ kind: "redirect", location: next }));
            return;
          }
          if (status < 200 || status >= 300) {
            response.resume();
            finish(() =>
              reject(new PhotoFetchRefused("download_failed", `status ${String(status)}`)),
            );
            return;
          }
          const declared = Number(response.headers["content-length"] ?? Number.NaN);
          if (Number.isFinite(declared) && declared > maxBytes) {
            response.destroy();
            finish(() => reject(new PhotoFetchRefused("too_large", "declared length")));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > maxBytes) {
              response.destroy();
              finish(() => reject(new PhotoFetchRefused("too_large", "body")));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            finish(() => resolve({ kind: "bytes", bytes: Buffer.concat(chunks) })),
          );
          response.on("error", (error) =>
            finish(() => reject(new PhotoFetchRefused("download_failed", error.message))),
          );
        },
      );
      const timer = setTimeout(() => {
        request.destroy();
        finish(() => reject(new PhotoFetchRefused("download_failed", "timeout")));
      }, remaining);
      request.on("error", (error) =>
        finish(() =>
          reject(
            error instanceof PhotoFetchRefused
              ? error
              : new PhotoFetchRefused("download_failed", error.message),
          ),
        ),
      );
      request.end();
    });
  }
}

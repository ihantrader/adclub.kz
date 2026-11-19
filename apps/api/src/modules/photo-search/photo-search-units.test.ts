import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { differenceHash } from "./perceptual-hash";
import { HttpPhotoFetcher, isBlockedAddress, PhotoFetchRefused } from "./photo-fetcher";
import {
  brandKeys,
  hammingDistance,
  rankCandidates,
  SAME_PICTURE_MAX_DISTANCE,
  siteOf,
  trustedSourceOf,
  type TrustedDomains,
} from "./photo-ranking";
import { parseSerpApiAnswer, SerpApiImageSearch } from "./serpapi-image-search";
import { ImageSearchUnavailable } from "./image-search-provider";
import {
  FixturePhotoFetcher,
  loadPhotoSearchFixtures,
  PHOTO_SEARCH_FIXTURES,
  TestImageSearch,
} from "./test-image-search";

const TRUSTED: TrustedDomains = {
  geely: { manufacturer: ["geely.com"], official_catalog: [] },
  trw: { manufacturer: ["zf.com"], official_catalog: ["aftermarket.zf.com"] },
};

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PhotoFetchRefused) return error.reason;
    throw error;
  }
  return "downloaded";
}

describe("blocked addresses (SSRF)", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.7",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "198.51.100.10",
    "::1",
    "::",
    "fe80::1",
    "fd00::5",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:7",
    "2001:db8::1",
    // IPv4-compatible (::/96) and IPv4-translated (::ffff:0:0:0/96).
    "::7f00:1",
    "::a00:7",
    "::8.8.8.8",
    "::ffff:0:a00:7",
    "::ffff:0:808:808",
    // The same ranges written with dots, in full and with a zone (TASK-068.B).
    "::10.0.0.7",
    "::ffff:0:10.0.0.7",
    "::ffff:0:8.8.8.8",
    "0:0:0:0:0:0:a00:7",
    "0000:0000:0000:0000:0000:0000:0808:0808",
    "0:0:0:0:ffff:0:a00:7",
    "0000:0000:0000:0000:ffff:0000:0808:0808",
    "0:0:0:0:ffff:0:10.0.0.7",
    "0:0:0:0:0:ffff:a00:7",
    "0000:0000:0000:0000:0000:ffff:7f00:0001",
    "0:0:0:0:0:ffff:10.0.0.7",
    "0064:ff9b:0000:0000:0000:0000:0a00:0007",
    "0:0:0:0:0:0:0:1",
    "fe80:0000:0000:0000:0000:0000:0000:0001",
    "fe80::1%eth0",
    "::a00:7%eth0",
    "::ffff:0:10.0.0.7%1",
    "::ffff:10.0.0.7%eth0",
    "not-an-address",
  ])("refuses %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "93.184.216.34",
    "185.22.64.10",
    "8.8.8.8",
    "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8",
    "0:0:0:0:0:ffff:808:808",
    "0000:0000:0000:0000:0000:ffff:8.8.8.8",
    "2a00:1450:4001:080b:0000:0000:0000:200e",
  ])("lets %s through", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("HttpPhotoFetcher", () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  it("refuses a name that resolves into a private network, before connecting", async () => {
    let connected = false;
    const port = await serve((_request, response) => {
      connected = true;
      response.end("x");
    });
    const fetcher = new HttpPhotoFetcher({
      resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
      ports: [port],
    });
    expect(await refusal(fetcher.fetch(`http://shop.example:${String(port)}/a.jpg`, 1000))).toBe(
      "private_address",
    );
    expect(connected).toBe(false);
  });

  it("refuses a literal private address and a name with any private address among its answers", async () => {
    const fetcher = new HttpPhotoFetcher({
      resolve: () =>
        Promise.resolve([
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ]),
    });
    expect(await refusal(fetcher.fetch("http://127.0.0.1/a.jpg", 1000))).toBe("private_address");
    expect(await refusal(fetcher.fetch("http://[::1]/a.jpg", 1000))).toBe("private_address");
    expect(await refusal(fetcher.fetch("https://mixed.example/a.jpg", 1000))).toBe(
      "private_address",
    );
  });

  it("refuses other schemes, other ports and credentials in the address", async () => {
    const fetcher = new HttpPhotoFetcher({ resolve: () => Promise.resolve([]) });
    expect(await refusal(fetcher.fetch("file:///etc/passwd", 1000))).toBe("download_failed");
    expect(await refusal(fetcher.fetch("ftp://shop.example/a.jpg", 1000))).toBe("download_failed");
    expect(await refusal(fetcher.fetch("http://shop.example:6379/a.jpg", 1000))).toBe(
      "download_failed",
    );
    expect(await refusal(fetcher.fetch("http://user:pass@shop.example/a.jpg", 1000))).toBe(
      "download_failed",
    );
  });

  it("downloads from an allowed address, follows a redirect and checks the next address again", async () => {
    const port = await serve((request, response) => {
      if (request.url === "/picture.jpg") {
        response.end(Buffer.from("PICTURE"));
      } else if (request.url === "/moved") {
        response.writeHead(302, { Location: "/picture.jpg" });
        response.end();
      } else if (request.url === "/inside") {
        response.writeHead(302, { Location: `http://internal.example:${String(port)}/secret` });
        response.end();
      } else if (request.url === "/big") {
        response.end(Buffer.alloc(5000));
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    // The local server stands for a public one; `internal.example` is the private name.
    const fetcher = new HttpPhotoFetcher({
      resolve: (host) =>
        Promise.resolve([
          { address: host === "internal.example" ? "10.1.2.3" : "127.0.0.1", family: 4 },
        ]),
      isBlocked: (address) => address !== "127.0.0.1" && isBlockedAddress(address),
      ports: [port],
    });
    const url = (path: string) => `http://public.example:${String(port)}${path}`;
    expect((await fetcher.fetch(url("/moved"), 1000)).toString()).toBe("PICTURE");
    expect(await refusal(fetcher.fetch(url("/inside"), 1000))).toBe("private_address");
    expect(await refusal(fetcher.fetch(url("/big"), 1000))).toBe("too_large");
    expect(await refusal(fetcher.fetch(url("/missing"), 1000))).toBe("download_failed");
  });

  it("gives up after its time limit", async () => {
    const port = await serve(() => {
      // Never answers.
    });
    const fetcher = new HttpPhotoFetcher({
      resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
      isBlocked: () => false,
      ports: [port],
      timeoutMs: 200,
    });
    expect(await refusal(fetcher.fetch(`http://slow.example:${String(port)}/a.jpg`, 1000))).toBe(
      "download_failed",
    );
  });
});

describe("ranking", () => {
  it("knows the brand's sites and the site of a host", () => {
    expect(brandKeys(["Geely", "GEELY Auto", "Джили"])).toEqual(
      expect.arrayContaining(["geely", "geelyauto", "джили"]),
    );
    expect(trustedSourceOf("www.geely.com", ["geely"], TRUSTED)).toBe("manufacturer");
    expect(trustedSourceOf("notgeely.com", ["geely"], TRUSTED)).toBeNull();
    expect(trustedSourceOf("aftermarket.zf.com", ["trw"], TRUSTED)).toBe("official_catalog");
    expect(trustedSourceOf("www.zf.com", ["trw"], TRUSTED)).toBe("manufacturer");
    // Another brand's site is not this item's source.
    expect(trustedSourceOf("www.geely.com", ["trw"], TRUSTED)).toBeNull();
    expect(siteOf("img.shop.kz")).toBe("shop.kz");
    expect(siteOf("cdn.parts.com.kz")).toBe("parts.com.kz");
    expect(hammingDistance("ffff000000000000", "fffe000000000001")).toBe(2);
  });

  it("puts the manufacturer first, then the same picture on two sites, and drops the rest", () => {
    const same = "f0f0f0f0f0f0f0f0";
    const other = "0123456789abcdef";
    const lonely = "ffffffff00000000";
    const { chosen, skipped } = rankCandidates(
      [
        { index: 0, host: "avtoshop.kz", hash: same, pixels: 640 * 480 },
        { index: 1, host: "www.geely.com", hash: other, pixels: 800 * 600 },
        { index: 2, host: "lonely.kz", hash: lonely, pixels: 640 * 480 },
        { index: 3, host: "zapchasti.com", hash: same.replace(/0$/, "1"), pixels: 480 * 360 },
        { index: 4, host: "img.lonely.kz", hash: lonely.replace(/0$/, "3"), pixels: 10 },
        { index: 5, host: "www.geely.com", hash: other, pixels: 800 * 600 },
      ],
      (host) => trustedSourceOf(host, ["geely"], TRUSTED),
      5,
    );
    expect(chosen.map((entry) => [entry.index, entry.sourceType])).toEqual([
      [1, "manufacturer"],
      [0, "multi_store"],
    ]);
    expect(chosen[1]!.sites).toEqual(["avtoshop.kz", "zapchasti.com"]);
    expect(skipped.get(2)).toBe("other_domain");
    // Two hosts of one site are not independent.
    expect(skipped.get(4)).toBe("other_domain");
    expect(skipped.get(3)).toBe("duplicate");
    expect(skipped.get(5)).toBe("duplicate");
  });

  it("keeps the limit", () => {
    const { chosen, skipped } = rankCandidates(
      [
        { index: 0, host: "www.geely.com", hash: "0000000000000000", pixels: 1 },
        { index: 1, host: "www.geely.com", hash: "ffffffffffffffff", pixels: 1 },
      ],
      (host) => trustedSourceOf(host, ["geely"], TRUSTED),
      1,
    );
    expect(chosen.map((entry) => entry.index)).toEqual([0]);
    expect(skipped.get(1)).toBe("over_limit");
  });

  it("sees a resized and recompressed picture as the same one, a different picture as another", async () => {
    const file = (name: string) => readFileSync(join(PHOTO_SEARCH_FIXTURES, name));
    const big = await differenceHash(file("shop-pads.jpg"));
    const small = await differenceHash(file("shop-pads-small.jpg"));
    const other = await differenceHash(file("geely-front-pads.jpg"));
    expect(hammingDistance(big, small)).toBeLessThanOrEqual(SAME_PICTURE_MAX_DISTANCE);
    expect(hammingDistance(big, other)).toBeGreaterThan(SAME_PICTURE_MAX_DISTANCE);
  });
});

describe("SerpAPI", () => {
  it("reads pictures and their pages, skipping what isn't http(s)", () => {
    const results = parseSerpApiAnswer(
      {
        search_metadata: { status: "Success" },
        images_results: [
          {
            position: 1,
            title: "Колодки Geely",
            link: "https://www.geely.com/parts/x",
            original: "https://www.geely.com/media/x.jpg",
            source: "geely.com",
          },
          { position: 2, link: "javascript:alert(1)", original: "https://a.kz/x.jpg" },
          { position: 3, link: "https://b.kz/p", original: "data:image/png;base64,AAAA" },
          { position: 4, link: "https://c.kz/p" },
          "garbage",
          { position: 5, link: "https://d.kz/p", original: "http://d.kz/x.png", title: "" },
        ],
      },
      10,
    );
    expect(results).toEqual([
      {
        imageUrl: "https://www.geely.com/media/x.jpg",
        pageUrl: "https://www.geely.com/parts/x",
        title: "Колодки Geely",
      },
      { imageUrl: "http://d.kz/x.png", pageUrl: "https://d.kz/p", title: null },
    ]);
    expect(
      parseSerpApiAnswer({ error: "Google hasn't returned any results for this query." }, 5),
    ).toEqual([]);
    expect(() => parseSerpApiAnswer({ error: "Invalid API key." }, 5)).toThrow(
      ImageSearchUnavailable,
    );
  });

  it("asks Google Images with the key and maps the provider's refusals", async () => {
    const asked: URL[] = [];
    let status = 200;
    const fakeFetch = ((input: URL) => {
      asked.push(new URL(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            images_results: [
              { link: "https://shop.kz/p", original: "https://shop.kz/i.jpg", title: "T" },
            ],
          }),
          { status, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;
    const search = new SerpApiImageSearch({ apiKey: "test-key-0123456789", fetch: fakeFetch });
    expect(await search.search("Geely 04465-0K090", 20)).toHaveLength(1);
    expect(asked[0]!.searchParams.get("engine")).toBe("google_images");
    expect(asked[0]!.searchParams.get("q")).toBe("Geely 04465-0K090");
    expect(asked[0]!.searchParams.get("api_key")).toBe("test-key-0123456789");
    status = 401;
    await expect(search.search("x", 5)).rejects.toMatchObject({ kind: "rejected" });
    status = 429;
    await expect(search.search("x", 5)).rejects.toMatchObject({ kind: "unavailable" });
    const failing = new SerpApiImageSearch({
      apiKey: "test-key-0123456789",
      fetch: (() =>
        Promise.reject(
          new Error("https://serpapi.com/?api_key=test-key-0123456789"),
        )) as unknown as typeof fetch,
    });
    const error = (await failing.search("x", 5).catch((thrown: unknown) => thrown)) as Error;
    expect(error).toBeInstanceOf(ImageSearchUnavailable);
    // The key never travels in the error.
    expect(error.message).not.toContain("test-key");
  });
});

describe("the test provider", () => {
  it("answers by the article and resolves its made-up names like the real downloader", async () => {
    const fixtures = loadPhotoSearchFixtures();
    const search = new TestImageSearch(fixtures);
    expect(await search.search("Geely 04465-0K090 Колодки тормозные передние", 20)).toHaveLength(9);
    expect(await search.search("TRW GDB3534 Колодки", 20)).toHaveLength(2);
    expect(await search.search("Что-то другое", 20)).toEqual([]);
    search.mode = "unavailable";
    await expect(search.search("x", 5)).rejects.toBeInstanceOf(ImageSearchUnavailable);
    const fetcher = new FixturePhotoFetcher(fixtures);
    expect(
      await refusal(fetcher.fetch("http://intranet.avtoshop-almaty.kz/admin/pads.jpg", 10_000_000)),
    ).toBe("private_address");
    expect(
      await refusal(fetcher.fetch("http://metadata.shop.kz/latest/meta-data/", 10_000_000)),
    ).toBe("private_address");
    expect(
      (await fetcher.fetch("https://www.geely.com/media/parts/04465-0k090.jpg", 10_000_000))
        .byteLength,
    ).toBeGreaterThan(1000);
  });
});

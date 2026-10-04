import { describe, expect, it } from "vitest";
import { callUrl, navigatorLinks, openNavigator, weeklyHoursLines } from "./pickup-place";

// Plain Node checks of «Поставщик и место» after acceptance (M-ORD-03, D-026).

const day = (n: number, intervals: Array<[string, string]>) => ({
  day: n,
  intervals: intervals.map(([from, to]) => ({ from, to })),
});

describe("the hours of the point", () => {
  it("join days in a row with the same hours", () => {
    const week = [
      ...[1, 2, 3, 4, 5].map((n) =>
        day(n, [
          ["09:00", "13:00"],
          ["14:00", "18:00"],
        ]),
      ),
      day(6, [["10:00", "16:00"]]),
      day(7, []),
    ];
    expect(weeklyHoursLines(week)).toEqual([
      { fromDay: 1, toDay: 5, hours: "09:00–13:00, 14:00–18:00" },
      { fromDay: 6, toDay: 6, hours: "10:00–16:00" },
      { fromDay: 7, toDay: 7, hours: null },
    ]);
  });

  it("say round the clock, and nothing when the server gave no hours", () => {
    const week = [1, 2, 3, 4, 5, 6, 7].map((n) => day(n, [["00:00", "24:00"]]));
    expect(weeklyHoursLines(week)).toEqual([{ fromDay: 1, toDay: 7, hours: "allDay" }]);
    expect(weeklyHoursLines(null)).toEqual([]);
  });
});

describe("the links that leave the app", () => {
  const place = { address: "ул. Райымбека, 200", cityName: "Алматы" };
  const query = encodeURIComponent("Алматы, ул. Райымбека, 200");

  it("offer the navigators by the address the server gave — Apple Maps only on iOS", () => {
    expect(navigatorLinks(place, "ios").map((link) => link.id)).toEqual([
      "yandexMaps",
      "yandexNavi",
      "twoGis",
      "googleMaps",
      "appleMaps",
    ]);
    expect(navigatorLinks(place, "android").map((link) => link.id)).toEqual([
      "yandexMaps",
      "yandexNavi",
      "twoGis",
      "googleMaps",
    ]);
  });

  it("search for the address in each of them, the app first and the same service on the web", () => {
    const ios = Object.fromEntries(navigatorLinks(place, "ios").map((link) => [link.id, link]));
    expect(ios.yandexMaps).toEqual({
      id: "yandexMaps",
      app: `yandexmaps://maps.yandex.ru/?text=${query}`,
      web: `https://yandex.kz/maps/?text=${query}`,
    });
    expect(ios.yandexNavi?.app).toBe(`yandexnavi://map_search?text=${query}`);
    expect(ios.twoGis).toMatchObject({
      app: `dgis://2gis.ru/search/${query}`,
      web: `https://2gis.kz/search/${query}`,
    });
    expect(ios.googleMaps?.app).toBe(`comgooglemaps://?q=${query}`);
    expect(ios.appleMaps).toMatchObject({
      app: `maps://?q=${query}`,
      web: `https://maps.apple.com/?q=${query}`,
    });
    const android = navigatorLinks(place, "android").find((link) => link.id === "googleMaps");
    expect(android?.app).toBe(android?.web);
    // No entry leads nowhere: each has a web address of its own service.
    for (const link of navigatorLinks(place, "ios")) {
      expect(link.web, link.id).toMatch(/^https:\/\//);
      expect(link.web, link.id).toContain(query);
    }
  });

  it("offer nothing without an address", () => {
    expect(navigatorLinks({ address: null, cityName: "Алматы" }, "ios")).toEqual([]);
    expect(navigatorLinks({ address: "  ", cityName: "Алматы" }, "android")).toEqual([]);
  });

  it("open the web of the service when the app is not installed, and say when nothing opened", async () => {
    const [link] = navigatorLinks(place, "android");
    const opened: string[] = [];
    const noApps = async (url: string) => {
      if (!url.startsWith("https://")) throw new Error("No app handles this link");
      opened.push(url);
    };
    expect(await openNavigator(link!, noApps)).toBe(true);
    expect(opened).toEqual([link!.web]);

    const everything = async (url: string) => void opened.push(url);
    opened.length = 0;
    expect(await openNavigator(link!, everything)).toBe(true);
    expect(opened).toEqual([link!.app]);

    const nothing = async () => {
      throw new Error("no browser either");
    };
    expect(await openNavigator(link!, nothing)).toBe(false);
  });

  it("call the phone the server gave, and nothing without one", () => {
    expect(callUrl("+7 705 555 01 01")).toBe("tel:+77055550101");
    expect(callUrl(null)).toBeNull();
    expect(callUrl("—")).toBeNull();
  });
});

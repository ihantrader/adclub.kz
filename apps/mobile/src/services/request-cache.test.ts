import { describe, expect, it } from "vitest";
import { createRequestCache } from "./request-cache";

describe("the short memory of answers", () => {
  function clock(start = 1_000) {
    let time = start;
    return { now: () => time, advance: (ms: number) => (time += ms) };
  }

  it("gives back what was written, per key", () => {
    const cache = createRequestCache(60_000);
    cache.write("generations:model-1:ru", { generations: [1, 2] });
    expect(cache.read("generations:model-1:ru")?.value).toEqual({ generations: [1, 2] });
    expect(cache.read("generations:model-2:ru")).toBeUndefined();
  });

  it("keeps the same key in another language apart", () => {
    const cache = createRequestCache(60_000);
    cache.write("modifications:gen-1:ru", "ru");
    cache.write("modifications:gen-1:kk", "kk");
    expect(cache.read("modifications:gen-1:kk")?.value).toBe("kk");
    expect(cache.read("modifications:gen-1:ru")?.value).toBe("ru");
  });

  it("says when the answer was written, so a screen that starts with it is as old as it is", () => {
    const time = clock(5_000);
    const cache = createRequestCache(60_000, time.now);
    cache.write("a", 1);
    time.advance(40_000);
    expect(cache.read("a")).toEqual({ value: 1, at: 5_000 });
  });

  it("forgets an answer once it is older than the time it was kept for", () => {
    const time = clock();
    const cache = createRequestCache(60_000, time.now);
    cache.write("a", 1);
    time.advance(59_999);
    expect(cache.read("a")?.value).toBe(1);
    time.advance(1);
    expect(cache.read("a")).toBeUndefined();
  });

  it("starts the time again when the answer is written again", () => {
    const time = clock();
    const cache = createRequestCache(60_000, time.now);
    cache.write("a", 1);
    time.advance(50_000);
    cache.write("a", 2);
    time.advance(50_000);
    expect(cache.read("a")?.value).toBe(2);
  });

  it("can be emptied", () => {
    const cache = createRequestCache(60_000);
    cache.write("a", 1);
    cache.clear();
    expect(cache.read("a")).toBeUndefined();
  });
});

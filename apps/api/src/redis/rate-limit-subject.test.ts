import { describe, expect, it } from "vitest";
import { rateLimitSubject } from "./rate-limit-subject";

describe("rateLimitSubject", () => {
  it("keeps an IPv4 address as is", () => {
    expect(rateLimitSubject("203.0.113.7")).toBe("203.0.113.7");
  });

  it("treats an IPv4-mapped IPv6 address as its IPv4", () => {
    expect(rateLimitSubject("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitSubject("::FFFF:127.0.0.1")).toBe("127.0.0.1");
  });

  it("groups IPv6 addresses by their /64 network", () => {
    const a = rateLimitSubject("2001:db8:abcd:12:1111:2222:3333:4444");
    const b = rateLimitSubject("2001:0db8:abcd:0012::1");
    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(b).toBe(a);
    expect(rateLimitSubject("2001:db8:abcd:13::1")).not.toBe(a);
  });

  it("expands a compressed IPv6 prefix", () => {
    expect(rateLimitSubject("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitSubject("::1")).toBe("0:0:0:0::/64");
  });

  it.each([undefined, "", "not-an-ip"])("puts an unknown address %j into one bucket", (ip) => {
    expect(rateLimitSubject(ip)).toBe("unknown");
  });
});

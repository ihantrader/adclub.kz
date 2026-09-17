import { isIPv4, isIPv6 } from "node:net";

/**
 * The key a client address is rate limited by. IPv4 — the address itself
 * (an IPv4-mapped IPv6 address counts as its IPv4). IPv6 — its /64
 * network: one subscriber usually gets a whole /64, so per-address limits
 * would be trivial to walk around.
 */
export function rateLimitSubject(ip: string | undefined): string {
  if (!ip) {
    return "unknown";
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] && isIPv4(mapped[1])) {
    return mapped[1];
  }
  if (isIPv4(ip)) {
    return ip;
  }
  if (!isIPv6(ip)) {
    return "unknown";
  }
  const [head = "", tail = ""] = ip.split("%")[0]!.toLowerCase().split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [
        ...headGroups,
        ...Array<string>(8 - headGroups.length - tailGroups.length).fill("0"),
        ...tailGroups,
      ]
    : headGroups;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

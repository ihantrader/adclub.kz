import { rateLimitSubject } from "../../../redis";

/**
 * What the list of sessions shows of an address: the IPv4 /24 network
 * (`203.0.113.*`) or the IPv6 /32 prefix (`2001:db8::*`) — enough to
 * tell a familiar network from a strange one, never the full address.
 */
export function ipHint(ip: string | null | undefined): string | null {
  const subject = rateLimitSubject(ip ?? undefined);
  if (subject === "unknown") {
    return null;
  }
  if (subject.endsWith("::/64")) {
    const [first, second] = subject.split(":");
    return `${first}:${second}::*`;
  }
  const octets = subject.split(".");
  return octets.length === 4 ? `${octets.slice(0, 3).join(".")}.*` : null;
}

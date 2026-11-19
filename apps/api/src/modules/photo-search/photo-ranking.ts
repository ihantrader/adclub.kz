/**
 * How results of the image search become candidates (TASK-068, D-076;
 * PRODUCT 7.6; ARCHITECTURE 9.7, 4.95). Pure: no network, no database —
 * every rule is a unit test.
 *
 * 1. A picture on the **manufacturer's site** or an **official catalogue**
 *    of the item's brand (`photo_search_trusted_domains`, subdomains count)
 *    comes first — `manufacturer`, then `official_catalog`.
 * 2. Otherwise **the same picture on several independent sites** —
 *    `multi_store`: «the same» by the perceptual hash (a picture resized or
 *    compressed again stays the same), «independent» — different sites
 *    (registrable domains: `shop.kz` and `img.shop.kz` are one site).
 * 3. Everything else is dropped (`other_domain`). Copies of a chosen
 *    picture are `duplicate`; more good ones than the limit — `over_limit`.
 */

export type FoundSourceType = "manufacturer" | "official_catalog" | "multi_store";

/** `photo_search_trusted_domains`: brand key → the two lists of domains. */
export type TrustedDomains = Record<string, { manufacturer: string[]; official_catalog: string[] }>;

/** Two pictures whose hashes differ in at most this many of 64 bits are one picture. */
export const SAME_PICTURE_MAX_DISTANCE = 8;

/** The keys a brand is looked up by: the name and its spellings, lower case, letters and digits. */
export function brandKeys(names: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const name of names) {
    const whole = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (whole) keys.add(whole);
    const first = name
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .find(Boolean);
    if (first) keys.add(first);
  }
  return [...keys];
}

/** The host of an address, lower case; `null` — not an address. */
export function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host || null;
  } catch {
    return null;
  }
}

export function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The trusted kind of a host for this brand; the more specific (official catalogue) first. */
export function trustedSourceOf(
  host: string,
  keys: readonly string[],
  trusted: TrustedDomains,
): "manufacturer" | "official_catalog" | null {
  const lists = keys.flatMap((key) => (trusted[key] ? [trusted[key]] : []));
  if (lists.some((list) => list.official_catalog.some((domain) => domainMatches(host, domain)))) {
    return "official_catalog";
  }
  if (lists.some((list) => list.manufacturer.some((domain) => domainMatches(host, domain)))) {
    return "manufacturer";
  }
  return null;
}

/** Second-level labels under which a country registers names (`shop.com.kz`). */
const PUBLIC_SECOND_LEVEL = new Set(["com", "co", "net", "org", "gov", "edu", "ac", "biz", "info"]);

/** The site a host belongs to: its registrable domain, by a simple rule. */
export function siteOf(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const top = labels.at(-1)!;
  const second = labels.at(-2)!;
  const take = top.length === 2 && PUBLIC_SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** Bits that differ between two 64-bit hashes written as 16 hex digits. */
export function hammingDistance(a: string, b: string): number {
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (value > 0n) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

/** A downloaded picture that passed the checks of an upload. */
export interface RankInput {
  /** Its place among the provider's results (earlier — better). */
  index: number;
  host: string;
  /** The perceptual hash, 16 hex digits. */
  hash: string;
  /** Width × height of the stored original. */
  pixels: number;
}

export interface RankedCandidate {
  index: number;
  sourceType: FoundSourceType;
  /** How sure the ranking is, 0…1 (`item_photo.ai_score`). */
  score: number;
  /** The members of its group: the sites the same picture was found on, by result index. */
  members: number[];
  sites: string[];
}

export type RankSkip = "other_domain" | "duplicate" | "over_limit";

const ORDER: Record<FoundSourceType, number> = {
  manufacturer: 0,
  official_catalog: 1,
  multi_store: 2,
};

/**
 * The candidates of one search, best first, at most `limit`; why each other
 * input was dropped.
 */
export function rankCandidates(
  inputs: readonly RankInput[],
  trustedOf: (host: string) => "manufacturer" | "official_catalog" | null,
  limit: number,
): { chosen: RankedCandidate[]; skipped: Map<number, RankSkip> } {
  const sorted = [...inputs].sort((a, b) => a.index - b.index);
  // Groups of one picture (union by the perceptual hash).
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (hammingDistance(sorted[i]!.hash, sorted[j]!.hash) <= SAME_PICTURE_MAX_DISTANCE) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const groups = new Map<number, RankInput[]>();
  sorted.forEach((input, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), input]);
  });

  const skipped = new Map<number, RankSkip>();
  const candidates: RankedCandidate[] = [];
  for (const members of groups.values()) {
    const sites = [...new Set(members.map((member) => siteOf(member.host)))];
    const trusted = members
      .map((member) => ({ member, kind: trustedOf(member.host) }))
      .filter((entry) => entry.kind !== null)
      .sort((a, b) => ORDER[a.kind!] - ORDER[b.kind!] || a.member.index - b.member.index);
    let chosen: RankInput | null = null;
    let sourceType: FoundSourceType | null = null;
    if (trusted.length > 0) {
      chosen = trusted[0]!.member;
      sourceType = trusted[0]!.kind!;
    } else if (sites.length >= 2) {
      chosen = [...members].sort((a, b) => b.pixels - a.pixels || a.index - b.index)[0]!;
      sourceType = "multi_store";
    }
    if (!chosen || !sourceType) {
      for (const member of members) skipped.set(member.index, "other_domain");
      continue;
    }
    for (const member of members) {
      if (member !== chosen) skipped.set(member.index, "duplicate");
    }
    candidates.push({
      index: chosen.index,
      sourceType,
      score:
        sourceType === "manufacturer"
          ? 0.9
          : sourceType === "official_catalog"
            ? 0.8
            : Math.min(0.75, 0.5 + 0.05 * (sites.length - 2)),
      members: members.map((member) => member.index),
      sites,
    });
  }
  candidates.sort(
    (a, b) =>
      ORDER[a.sourceType] - ORDER[b.sourceType] ||
      b.sites.length * Number(a.sourceType === "multi_store") -
        a.sites.length * Number(b.sourceType === "multi_store") ||
      a.index - b.index,
  );
  const chosen = candidates.slice(0, Math.max(0, limit));
  for (const extra of candidates.slice(chosen.length)) skipped.set(extra.index, "over_limit");
  return { chosen, skipped };
}

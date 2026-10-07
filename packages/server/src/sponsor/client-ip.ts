import { isIP } from "node:net";

/**
 * The rate-limit key for a request, from the value of the platform's trusted
 * client-IP header (never a cookie or anything else the caller can choose).
 *
 * An IPv4 address is its own bucket. An IPv6 address is bucketed by its /64,
 * because one subscriber is normally handed a whole /64 and could otherwise
 * rotate through addresses to reset the limit. IPv4-mapped IPv6 counts as
 * the IPv4 address. Anything that is not exactly one IP address returns null,
 * and the caller refuses the request.
 *
 * Covers: spelling variants of one address. Does not cover: a caller with
 * many real IPv4 addresses or many /64s; the daily budget bounds that.
 */
export function clientBucket(headerValue: string | null): string | null {
  if (headerValue === null) return null;
  const ip = headerValue.trim();
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family !== 6) return null;
  const groups = ipv6Groups(ip);
  if (groups === null) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
  }
  return groups.slice(0, 4).map((g) => g.toString(16)).join(":") + "::/64";
}

function ipv6Groups(ip: string): number[] | null {
  let host: string;
  try {
    // The URL parser gives the one canonical spelling and folds an embedded
    // dotted quad into hex, so only plain hex groups are left to expand.
    host = new URL("http://[" + ip + "]/").hostname.slice(1, -1);
  } catch {
    return null;
  }
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

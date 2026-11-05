import { BlockList, isIP } from "node:net";

/* ============================================================
   App access lists

   Each app keeps two allowlists: browser origins and client IPs. Entries are
   validated and normalised on write, so whatever later compares a request
   against them can do a plain equality / CIDR check without re-parsing.

   An empty list means "no restriction".
   ============================================================ */

export const MAX_ACCESS_ENTRIES = 50;

/**
 * "https://App.example.com:443/" → "https://app.example.com".
 * Only scheme, host and port: an Origin header never carries a path.
 * @returns {{ value?: string, error?: string }}
 */
export function normalizeOrigin(raw) {
  const input = String(raw).trim();
  if (!input) return { error: "Origin cannot be empty." };

  let url;
  try {
    url = new URL(input);
  } catch {
    return { error: `"${input}" is not a valid origin. Include the scheme, e.g. https://example.com.` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `"${input}" must start with http:// or https://.` };
  }

  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return { error: `"${input}" must be an origin only (scheme, host and optional port), with no path.` };
  }

  // URL lower-cases the host and drops a default port.
  return { value: url.origin };
}

/**
 * A single address or a CIDR range, IPv4 or IPv6: "203.0.113.7", "10.0.0.0/8",
 * "2001:db8::/32". IPv6 is lower-cased so equal addresses compare equal.
 * @returns {{ value?: string, error?: string }}
 */
export function normalizeIp(raw) {
  const input = String(raw).trim();
  if (!input) return { error: "IP address cannot be empty." };

  const [address, prefix, extra] = input.split("/");
  const version = isIP(address);

  if (!version || extra !== undefined) {
    return { error: `"${input}" is not a valid IP address or CIDR range.` };
  }

  const normalizedAddress = version === 6 ? address.toLowerCase() : address;
  if (prefix === undefined) return { value: normalizedAddress };

  const maxPrefix = version === 4 ? 32 : 128;
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > maxPrefix) {
    return { error: `"${input}" has an invalid prefix length (0-${maxPrefix}).` };
  }

  return { value: `${normalizedAddress}/${Number(prefix)}` };
}

/**
 * Validate a whole list from a request body. Duplicates (after
 * normalisation) are dropped, keeping first-seen order.
 * @returns {{ list?: string[], error?: string }}
 */
export function parseAccessList(values, normalize, label) {
  if (!Array.isArray(values)) return { error: `${label} must be an array.` };

  if (values.length > MAX_ACCESS_ENTRIES) {
    return { error: `${label} can hold at most ${MAX_ACCESS_ENTRIES} entries.` };
  }

  const list = [];
  for (const entry of values) {
    if (typeof entry !== "string") return { error: `${label} must contain only strings.` };

    const { value, error } = normalize(entry);
    if (error) return { error };
    if (!list.includes(value)) list.push(value);
  }

  return { list };
}

/* ============================================================
   Enforcement
   ============================================================ */

/** True when `ip` is one of `entries` (addresses or CIDR ranges). */
export function ipMatches(ip, entries) {
  const version = isIP(ip ?? "");
  if (!version) return false;

  // Built per call: lists hold at most MAX_ACCESS_ENTRIES, so this is cheap.
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split("/");
    const type = isIP(address) === 6 ? "ipv6" : "ipv4";

    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }

  // BlockList matches an IPv4-mapped IPv6 address (::ffff:1.2.3.4) against
  // IPv4 rules, which is how Node reports IPv4 clients on a dual-stack socket.
  return list.check(ip, version === 6 ? "ipv6" : "ipv4");
}

/**
 * Decide whether a request may reach an app.
 *
 * - allowedIps: the client IP must match an entry.
 * - allowedOrigins: the request's Origin header must match an entry. A request
 *   with no Origin header (curl, scripts, servers) is rejected too, unless it
 *   came from one of the app's allowedIps — that is how the owner's own
 *   backend keeps working once origins are locked down.
 *
 * Origin is set by browsers and cannot be changed by page scripts, so this
 * stops other websites from using a key copied out of a frontend bundle. A
 * non-browser client can still send a forged Origin; only allowedIps stops
 * that.
 *
 * An empty list imposes no restriction.
 * @returns {{ allowed: true } | { allowed: false, code: string, message: string }}
 */
export function checkAppAccess(app, { origin, ip }) {
  const allowedIps = app?.allowedIps ?? [];
  const allowedOrigins = app?.allowedOrigins ?? [];

  if (allowedIps.length > 0 && !ipMatches(ip, allowedIps)) {
    return {
      allowed: false,
      code: "IP_NOT_ALLOWED",
      message: "Requests from this IP address are not allowed for this app.",
    };
  }

  if (allowedOrigins.length > 0) {
    if (origin === undefined) {
      // Reaching here with an IP list set means the IP already matched.
      if (allowedIps.length > 0) return { allowed: true };

      return {
        allowed: false,
        code: "ORIGIN_NOT_ALLOWED",
        message:
          "This app only accepts requests from its allowed origins. Add your server's IP to the app's allowed IPs to call it without an Origin header.",
      };
    }

    const { value } = normalizeOrigin(origin);
    if (!value || !allowedOrigins.includes(value)) {
      return {
        allowed: false,
        code: "ORIGIN_NOT_ALLOWED",
        message: "Requests from this origin are not allowed for this app.",
      };
    }
  }

  return { allowed: true };
}

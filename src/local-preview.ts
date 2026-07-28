// A local preview is a Worker configured for a machine on hand rather than for
// the internet: loopback, or a private address on the local network. Production
// always configures `https://quickducks.com`, a public name, so every affordance
// gated on this predicate is unreachable in production by construction rather
// than by convention. That guarantee rests on the deployed configuration keeping
// that origin, which `release-safety.test.mjs` asserts alongside the other
// release invariants.
//
// Keep this the single definition, and resolve the host through `URL` rather than
// matching the string. `http://quickducks.com@localhost/` and `http://127.1` are
// both loopback; `http://localhost.example` and `https://10.0.0.1.nip.io` are
// public names that merely look local. Only parsing tells them apart.
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

// `URL` normalises IPv4, so an octet here is always a plain decimal number.
const privateIpv4 = (hostname: string): boolean => {
  const octets = hostname.split(".");
  if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet))) return false;
  const [first, second] = octets.map(Number);
  if (octets.some((octet) => Number(octet) > 255)) return false;
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  // Link-local, which is what a directly cabled or ad-hoc network hands out.
  return first === 169 && second === 254;
};

// `URL` lower-cases and compresses IPv6, and keeps the brackets in `hostname`.
const privateIpv6 = (hostname: string): boolean => {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const address = hostname.slice(1, -1);
  // Unique local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd][0-9a-f]{0,2}:/.test(address) || /^fe[89ab][0-9a-f]?:/.test(address);
};

const isPrivateHostname = (hostname: string): boolean =>
  loopbackHostnames.has(hostname)
  // Multicast DNS, which is how a Mac advertises itself to the local network.
  || hostname.endsWith(".local")
  || privateIpv4(hostname)
  || privateIpv6(hostname);

export const isLocalPreviewOrigin = (appOrigin: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(appOrigin);
  } catch {
    return false;
  }
  if (loopbackHostnames.has(parsed.hostname)) {
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  }
  // Off loopback, only TLS qualifies. Browsers treat loopback as a secure context
  // and nothing else, so plain http on the local network cannot store the
  // `__Host-` session cookies, and the CSP would rewrite every subresource to
  // https anyway. Requiring TLS here makes that fail at the guard, loudly, rather
  // than as a half-working site.
  return parsed.protocol === "https:" && isPrivateHostname(parsed.hostname);
};

// The value the local-preview registration form posts in place of a real
// Turnstile response. `createRegistration` still requires a non-empty token in a
// local preview, so the browser and the API keep the same request shape they use
// in production; only the remote verification call is waived.
export const localPreviewTurnstileToken = "local-preview";

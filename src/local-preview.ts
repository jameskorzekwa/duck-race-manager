// A local preview is a Worker configured for a machine on hand rather than for
// the internet: loopback, or a private IPv4 address on the local network.
// Production always configures `https://quickducks.com`, a public name, so every
// affordance gated on this predicate is unreachable in production by construction
// rather than by convention. `release-safety.test.mjs` runs this predicate against
// the deployed configuration and asserts it says no.
//
// Nothing wider is accepted, deliberately. `.local` names and private IPv6 both
// look like reasonable additions, but `scripts/local-network.mjs` only ever picks
// a private IPv4 address this machine actually holds, so neither could arise from
// the shipped commands — and each one would be more surface on the single check
// the whole harness rests on.
//
// Keep this the single definition, and resolve the host through `URL` rather than
// matching the string. `http://quickducks.com@localhost/` and `http://127.1` are
// both loopback; `http://localhost.example` and `https://10.0.0.1.nip.io` are
// public names that merely look local. Only parsing tells them apart.
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

// `URL` normalises IPv4, so an octet here is always a plain decimal number, and
// shorthand like `10.1` has already become `10.0.0.1`.
const isPrivateIpv4 = (hostname: string): boolean => {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return false;
  const [first, second] = octets.map(Number);
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  // Link-local, which is what a directly cabled or ad-hoc network hands out.
  return first === 169 && second === 254;
};

export const isLoopbackOrigin = (origin: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:")
    && loopbackHostnames.has(parsed.hostname);
};

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
  return parsed.protocol === "https:" && isPrivateIpv4(parsed.hostname);
};

// The value the local-preview registration form posts in place of a real
// Turnstile response. `createRegistration` still requires a non-empty token in a
// local preview, so the browser and the API keep the same request shape they use
// in production; only the remote verification call is waived.
export const localPreviewTurnstileToken = "local-preview";

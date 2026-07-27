// A local preview is a Worker whose configured `APP_ORIGIN` is an http origin on
// a loopback host. Production always configures `https://quickducks.com`, so every
// affordance gated on this predicate is unreachable in production by construction
// rather than by convention. `release-safety.test.mjs` asserts the deployed
// configuration keeps an https origin, which is what makes that guarantee hold.
//
// Keep this the single definition. Duplicating the host list is how one copy
// drifts into accepting something the others do not.
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const isLocalPreviewOrigin = (appOrigin: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(appOrigin);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && loopbackHostnames.has(parsed.hostname);
};

// The value the local-preview registration form posts in place of a real
// Turnstile response. `createRegistration` still requires a non-empty token in a
// local preview, so the browser and the API keep the same request shape they use
// in production; only the remote verification call is waived.
export const localPreviewTurnstileToken = "local-preview";

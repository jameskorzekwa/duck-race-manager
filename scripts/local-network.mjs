// The decisions `dev-network.mjs` makes, separated from the side effects so they
// can be tested: which address to serve on, and what to hand wrangler.
import { networkInterfaces } from "node:os";

export const isPrivateIpv4 = (address) =>
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(address);

// Only addresses this machine actually holds, and only private ones. A public
// address would mean serving a development site to the internet.
export const privateAddresses = (interfaces = networkInterfaces()) =>
  Object.entries(interfaces)
    .flatMap(([name, addresses]) => (addresses ?? []).map((address) => ({ ...address, name })))
    .filter((address) => address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address));

export const chooseAddress = (requested, available) => {
  if (requested !== undefined) {
    const match = available.find((address) => address.address === requested);
    if (match === undefined) {
      throw new Error(
        `${requested} is not a private address on this machine.${
          available.length === 0 ? "" : ` Available: ${available.map((address) => address.address).join(", ")}`
        }`,
      );
    }
    return match;
  }
  if (available.length === 0) {
    throw new Error(
      "This machine has no private network address, so other devices have nothing to connect to.\n"
        + "Join a Wi-Fi or wired network and try again, or use `npm run dev:local` on this machine only.",
    );
  }
  // Wi-Fi and wired interfaces sort before virtual ones (Docker, VPNs), which are
  // reachable from this machine but usually not from a phone.
  return available.find((address) => /^en\d/.test(address.name)) ?? available[0];
};

// Binds the one private address that was chosen, never 0.0.0.0. Binding every
// interface would also bind any public one the machine holds, and the Worker's
// own guard cannot help there: it reads the request's Host, which the caller
// controls, and the private address is published in the certificate anyway.
export const wranglerArguments = ({ host, port, origin, keyPath, certificatePath }) => [
  "--no-install",
  "wrangler",
  "dev",
  "--config",
  "wrangler.local.jsonc",
  "--ip",
  host,
  "--port",
  String(port),
  "--local-protocol",
  "https",
  "--https-key-path",
  keyPath,
  "--https-cert-path",
  certificatePath,
  "--var",
  `APP_ORIGIN:${origin}`,
  // The stand-in for the Cognito hosted UI is served by this same Worker, so its
  // domain has to follow the origin too.
  "--var",
  `COGNITO_DOMAIN:${origin}`,
];

export const shouldReuseCertificate = (previous, { host, mkcert, filesPresent, now = Date.now() }) => {
  if (previous === null || !filesPresent) return false;
  if (previous.host !== host || previous.mkcert !== mkcert) return false;
  // An absent or unparseable expiry means regenerate. `NaN < x` is false, so
  // comparing directly would quietly reuse a certificate forever instead.
  const expiry = Date.parse(previous.expiresAt ?? "");
  return Number.isFinite(expiry) && expiry - now >= 7 * 86_400_000;
};

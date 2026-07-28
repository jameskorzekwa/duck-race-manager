// Serves the local site to other devices on the same network, over HTTPS.
//
// `npm run dev:local` binds loopback and is the right default. This is for the
// cases loopback cannot cover: a phone, a tablet, the Android Chrome NFC station,
// or someone else in the room holding a real device on race day.
//
// It has to be HTTPS. The staff session uses `__Host-` cookies, which browsers
// only store on a secure origin; the CSP sets `upgrade-insecure-requests`, which
// rewrites every subresource on a non-secure origin; and Web NFC refuses to run
// outside a secure context. Browsers treat loopback as secure automatically and
// nothing else, so off the loopback interface a certificate is not optional.
//
// The certificate is self-signed and lives in .wrangler/, which is gitignored and
// disposable. Devices show a warning once, which you accept. `mkcert` is used
// instead when it is installed, because a certificate from a CA the device trusts
// has no warning at all — and Chrome withholds some powerful features, Web NFC
// among them, from an origin whose certificate it does not trust.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { argv, env, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = new URL("../", import.meta.url);
const certificateDirectory = new URL(".wrangler/local-network/", repositoryRoot);
const certificatePath = new URL("cert.pem", certificateDirectory);
const keyPath = new URL("key.pem", certificateDirectory);
const metadataPath = new URL("session.json", certificateDirectory);
const markerPath = new URL(".wrangler/local-network.json", repositoryRoot);

const parseArguments = () => {
  const options = { port: 8787 };
  for (const argument of argv.slice(2)) {
    const match = argument.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (match === null) throw new Error(`Unrecognized argument: ${argument}`);
    const [, name, value = ""] = match;
    if (name === "host") options.host = value;
    else if (name === "port") options.port = Number(value);
    else if (name === "help") options.help = true;
    else throw new Error(`Unrecognized option: --${name}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("--port must be a valid port number.");
  }
  return options;
};

const usage = () => `Serve the local site to other devices on your network, over HTTPS.

  npm run dev:network [-- --host=<address>] [-- --port=<port>]

Picks a private IPv4 address of this machine automatically. Pass --host when the
machine has several and you want a specific one. Default port is 8787.
`;

// Only addresses this machine actually holds, and only private ones. A public
// address would mean serving a development site to the internet.
const privateAddresses = () =>
  Object.entries(networkInterfaces())
    .flatMap(([name, addresses]) => (addresses ?? []).map((address) => ({ ...address, name })))
    .filter((address) =>
      address.family === "IPv4"
      && !address.internal
      && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(address.address)
    );

const chooseHost = (requested) => {
  const available = privateAddresses();
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
  const preferred = available.find((address) => /^en\d/.test(address.name)) ?? available[0];
  if (available.length > 1) {
    stdout.write(
      `This machine has several private addresses: ${
        available.map((address) => `${address.address} (${address.name})`).join(", ")
      }\nUsing ${preferred.address}. Pass --host=<address> to choose another.\n\n`,
    );
  }
  return preferred;
};

const commandExists = (command) => spawnSync("command", ["-v", command], { shell: true }).status === 0;

const readMetadata = () => {
  try {
    return JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    return null;
  }
};

// Regenerated whenever the address changes — DHCP hands out a different one often
// enough that a stale certificate would otherwise be the first thing to go wrong.
const ensureCertificate = (host) => {
  const previous = readMetadata();
  const useMkcert = commandExists("mkcert");
  const expiresSoon = previous !== null && Date.parse(previous.expiresAt) - Date.now() < 7 * 86_400_000;
  if (previous?.host === host && previous?.mkcert === useMkcert && !expiresSoon) return previous;

  mkdirSync(fileURLToPath(certificateDirectory), { recursive: true });
  const days = 90;
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

  if (useMkcert) {
    stdout.write("Issuing a certificate with mkcert…\n");
    const result = spawnSync("mkcert", [
      "-cert-file",
      fileURLToPath(certificatePath),
      "-key-file",
      fileURLToPath(keyPath),
      host,
      "localhost",
      "127.0.0.1",
      "::1",
    ], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("mkcert could not issue a certificate.");
  } else {
    stdout.write("Issuing a self-signed certificate…\n");
    // Written as a config file rather than -addext, because the openssl that
    // ships with macOS is LibreSSL and does not always accept that flag.
    const configPath = new URL("openssl.cnf", certificateDirectory);
    writeFileSync(
      configPath,
      `[req]\ndistinguished_name = name\nx509_extensions = extensions\nprompt = no\n\n`
        + `[name]\nCN = QuickDucks local network\n\n`
        + `[extensions]\nsubjectAltName = IP:${host}, IP:127.0.0.1, IP:::1, DNS:localhost\n`
        + `basicConstraints = critical, CA:FALSE\nkeyUsage = critical, digitalSignature, keyEncipherment\n`
        + `extendedKeyUsage = serverAuth\n`,
    );
    const result = spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      fileURLToPath(keyPath),
      "-out",
      fileURLToPath(certificatePath),
      "-days",
      String(days),
      "-config",
      fileURLToPath(configPath),
    ], { stdio: ["ignore", "ignore", "pipe"] });
    rmSync(configPath, { force: true });
    if (result.status !== 0) {
      throw new Error(`openssl could not issue a certificate.\n${result.stderr?.toString() ?? ""}`);
    }
  }

  const metadata = { host, mkcert: useMkcert, expiresAt };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: fileURLToPath(repositoryRoot), stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

const options = parseArguments();
if (options.help) {
  stdout.write(usage());
  exit(0);
}

let host;
let certificate;
try {
  host = chooseHost(options.host).address;
  certificate = ensureCertificate(host);
} catch (error) {
  stderr.write(`\n${error.message}\n\n`);
  exit(1);
}

const origin = `https://${host}:${options.port}`;

const migrated = run("npx", ["--no-install", "wrangler", "d1", "migrations", "apply", "quickducks-local", "--local", "--config", "wrangler.local.jsonc"]);
if (migrated !== 0) exit(migrated);

// The seeding script reads this so `npm run seed:local` targets the origin that
// is actually serving, and trusts the certificate it is served with. Public
// registration checks the request Origin against APP_ORIGIN, so seeding through
// the wrong one would be rejected.
writeFileSync(
  markerPath,
  `${JSON.stringify({ origin, certificatePath: fileURLToPath(certificatePath) }, null, 2)}\n`,
);

stdout.write(`
Serving the local site to your network.

  On this machine     ${origin}
  On other devices    ${origin}

Open that address on the device. ${
  certificate.mkcert
    ? "The certificate is from your mkcert CA — install that CA on the device once\n  (mkcert -CAROOT) and there is no warning."
    : "The certificate is self-signed, so the browser warns once:\n  tap Advanced, then Proceed. Run `brew install mkcert` for a warning-free\n  certificate, which Android Chrome also requires before it will allow Web NFC."
}

  Seed it with        npm run seed:local -- --state=round-one
  Sign in at          ${origin}/staff

  Stop it with        Ctrl-C

Anyone on this network can open this site and sign in as any staff account,
including the administrator. Sign-in is deliberately passwordless, so there is
nothing to guess. The database is throwaway and holds no real participant data
or credentials — but run this on your own network, not a cafe or a conference.

`);

const wrangler = spawn("npx", [
  "--no-install",
  "wrangler",
  "dev",
  "--config",
  "wrangler.local.jsonc",
  "--ip",
  "0.0.0.0",
  "--port",
  String(options.port),
  "--local-protocol",
  "https",
  "--https-key-path",
  fileURLToPath(keyPath),
  "--https-cert-path",
  fileURLToPath(certificatePath),
  "--var",
  `APP_ORIGIN:${origin}`,
  // The stand-in for the Cognito hosted UI is served by this same Worker, so its
  // domain has to follow the origin too.
  "--var",
  `COGNITO_DOMAIN:${origin}`,
], { cwd: fileURLToPath(repositoryRoot), stdio: "inherit", env });

const stop = () => {
  rmSync(markerPath, { force: true });
  wrangler.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
wrangler.on("exit", (code) => {
  rmSync(markerPath, { force: true });
  exit(code ?? 0);
});

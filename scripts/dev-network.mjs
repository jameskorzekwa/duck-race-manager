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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv, env, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { chooseAddress, privateAddresses, shouldReuseCertificate, wranglerArguments } from "./local-network.mjs";

const repositoryRoot = new URL("../", import.meta.url);
const certificateDirectory = new URL(".wrangler/local-network/", repositoryRoot);
const certificatePath = fileURLToPath(new URL("cert.pem", certificateDirectory));
const keyPath = fileURLToPath(new URL("key.pem", certificateDirectory));
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

  npm run dev:network -- [--host=<address>] [--port=<port>]

Picks a private IPv4 address of this machine automatically. Pass --host when the
machine has several and you want a specific one. Default port is 8787.
`;

const commandExists = (command) => spawnSync("command", ["-v", command], { shell: true }).status === 0;

const readMetadata = () => {
  try {
    return JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    return null;
  }
};

const mkcertRoot = () => {
  const result = spawnSync("mkcert", ["-CAROOT"], { encoding: "utf8" });
  const root = result.stdout?.trim();
  if (result.status !== 0 || !root) throw new Error("mkcert could not report its CA directory.");
  return join(root, "rootCA.pem");
};

// Regenerated whenever the address changes — DHCP hands out a different one often
// enough that a stale certificate would otherwise be the first thing to go wrong.
const ensureCertificate = (host) => {
  const useMkcert = commandExists("mkcert");
  const filesPresent = existsSync(certificatePath) && existsSync(keyPath);
  const previous = readMetadata();
  if (shouldReuseCertificate(previous, { host, mkcert: useMkcert, filesPresent })) return previous;

  mkdirSync(fileURLToPath(certificateDirectory), { recursive: true });
  const days = 90;
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

  if (useMkcert) {
    stdout.write("Issuing a certificate with mkcert…\n");
    const result = spawnSync(
      "mkcert",
      ["-cert-file", certificatePath, "-key-file", keyPath, host, "localhost", "127.0.0.1", "::1"],
      { stdio: "inherit" },
    );
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
    const result = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
        "-days",
        String(days),
        "-config",
        fileURLToPath(configPath),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    rmSync(configPath, { force: true });
    if (result.status !== 0) {
      throw new Error(`openssl could not issue a certificate.\n${result.stderr?.toString() ?? ""}`);
    }
  }

  // What a client has to trust, which is not the same file in both cases: a
  // self-signed certificate is its own anchor, but an mkcert certificate is
  // issued by the mkcert root and verifying it needs that root instead.
  const metadata = {
    host,
    mkcert: useMkcert,
    expiresAt,
    trustAnchorPath: useMkcert ? mkcertRoot() : certificatePath,
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
};

const options = (() => {
  try {
    return parseArguments();
  } catch (error) {
    stderr.write(`\n${error.message}\n\n${usage()}`);
    exit(1);
  }
})();

if (options.help) {
  stdout.write(usage());
  exit(0);
}

let host;
let certificate;
try {
  host = chooseAddress(options.host, privateAddresses()).address;
  certificate = ensureCertificate(host);
} catch (error) {
  stderr.write(`\n${error.message}\n\n`);
  exit(1);
}

const origin = `https://${host}:${options.port}`;

const migrated = spawnSync(
  "npx",
  ["--no-install", "wrangler", "d1", "migrations", "apply", "quickducks-local", "--local", "--config", "wrangler.local.jsonc"],
  { cwd: fileURLToPath(repositoryRoot), stdio: "inherit" },
);
if (migrated.status !== 0) exit(migrated.status ?? 1);

// The seeding script reads this so `npm run seed:local` targets the origin that
// is actually serving, and trusts the certificate it is served with. Public
// registration checks the request Origin against APP_ORIGIN, so seeding through
// the wrong one would be rejected.
const clearMarker = () => rmSync(markerPath, { force: true });
writeFileSync(
  markerPath,
  `${JSON.stringify({ origin, trustAnchorPath: certificate.trustAnchorPath, pid: process.pid }, null, 2)}\n`,
);

stdout.write(`
Serving the local site to your network.

  On this machine     ${origin}
  On other devices    ${origin}

Open that address on the device. ${
  certificate.mkcert
    ? "The certificate is from your mkcert CA — install that CA on the\n  device once (mkcert -CAROOT) and there is no warning."
    : "The certificate is self-signed, so the browser warns\n  once: tap Advanced, then Proceed. Run `brew install mkcert` for a warning-free\n  certificate, which Android Chrome also requires before it will allow Web NFC."
}

  Seed it with        npm run seed:local -- --state=round-one
  Sign in at          ${origin}/staff
  Stop it with        Ctrl-C

Anyone on this network can open this site and sign in as any staff account,
including the administrator. Sign-in is deliberately passwordless, so there is
nothing to guess. The database is throwaway and holds no real participant data
or credentials — but run this on your own network, not a cafe or a conference.

`);

const wrangler = spawn(
  "npx",
  wranglerArguments({ host, port: options.port, origin, keyPath, certificatePath }),
  { cwd: fileURLToPath(repositoryRoot), stdio: "inherit", env },
);

// The marker must not outlive the server. Every exit path clears it: a signal, a
// crash, wrangler failing to spawn at all, or the process simply ending.
const stop = () => {
  clearMarker();
  wrangler.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
process.on("exit", clearMarker);
wrangler.on("error", (error) => {
  stderr.write(`\nCould not start wrangler: ${error.message}\n\n`);
  exit(1);
});
wrangler.on("exit", (code) => exit(code ?? 0));

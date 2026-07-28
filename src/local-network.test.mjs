import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseAddress,
  isPrivateIpv4,
  privateAddresses,
  shouldReuseCertificate,
  wranglerArguments,
} from "../scripts/local-network.mjs";

const address = (value, name, extra = {}) => ({
  address: value,
  name,
  family: "IPv4",
  internal: false,
  ...extra,
});

test("only private IPv4 addresses of this machine are offered", () => {
  for (const value of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.20", "169.254.1.1"]) {
    assert.equal(isPrivateIpv4(value), true, value);
  }
  for (const value of ["172.15.0.1", "172.32.0.1", "11.0.0.1", "192.169.0.1", "8.8.8.8", "203.0.113.4"]) {
    assert.equal(isPrivateIpv4(value), false, value);
  }

  const found = privateAddresses({
    lo0: [address("127.0.0.1", "lo0", { internal: true })],
    en0: [address("192.168.1.20", "en0"), { address: "fe80::1", family: "IPv6", internal: false }],
    // A public address on this machine must never be offered: serving a
    // development site on it would put it on the internet.
    en5: [address("203.0.113.4", "en5")],
    docker0: [address("172.17.0.1", "docker0")],
  });

  assert.deepEqual(found.map((item) => item.address), ["192.168.1.20", "172.17.0.1"]);
});

test("a physical interface is preferred, and an explicit host must be one this machine holds", () => {
  const available = [address("172.17.0.1", "docker0"), address("192.168.1.20", "en0")];

  assert.equal(chooseAddress(undefined, available).address, "192.168.1.20");
  assert.equal(chooseAddress("172.17.0.1", available).address, "172.17.0.1");
  assert.throws(() => chooseAddress("203.0.113.4", available), /not a private address on this machine/);
  assert.throws(() => chooseAddress(undefined, []), /no private network address/);
});

// The Worker's own guard cannot cover this: it reads the request's Host, which
// the caller chooses. Binding one address is what keeps a public interface out.
test("wrangler binds the chosen private address, never every interface", () => {
  const args = wranglerArguments({
    host: "192.168.1.20",
    port: 8787,
    origin: "https://192.168.1.20:8787",
    keyPath: "/tmp/key.pem",
    certificatePath: "/tmp/cert.pem",
  });

  assert.equal(args[args.indexOf("--ip") + 1], "192.168.1.20");
  assert.equal(args.includes("0.0.0.0"), false);
  assert.equal(args[args.indexOf("--local-protocol") + 1], "https");
  assert.equal(args[args.indexOf("--config") + 1], "wrangler.local.jsonc");
  // The stand-in hosted UI is served by this Worker, so both must follow the
  // origin or sign-in redirects leave the site.
  assert.deepEqual(
    args.filter((argument) => argument.startsWith("APP_ORIGIN:") || argument.startsWith("COGNITO_DOMAIN:")),
    ["APP_ORIGIN:https://192.168.1.20:8787", "COGNITO_DOMAIN:https://192.168.1.20:8787"],
  );
});

test("a certificate is reused only when it still matches the situation", () => {
  const now = Date.parse("2026-07-01T00:00:00Z");
  const valid = { host: "192.168.1.20", mkcert: false, expiresAt: "2026-10-01T00:00:00Z" };
  const situation = { host: "192.168.1.20", mkcert: false, filesPresent: true, now };

  assert.equal(shouldReuseCertificate(valid, situation), true);
  assert.equal(shouldReuseCertificate(null, situation), false);
  // DHCP handed out a different address.
  assert.equal(shouldReuseCertificate(valid, { ...situation, host: "192.168.1.21" }), false);
  // mkcert was installed since, so the certificate should now come from its CA.
  assert.equal(shouldReuseCertificate(valid, { ...situation, mkcert: true }), false);
  // The metadata survived but the certificate itself was deleted.
  assert.equal(shouldReuseCertificate(valid, { ...situation, filesPresent: false }), false);
  assert.equal(
    shouldReuseCertificate({ ...valid, expiresAt: "2026-07-03T00:00:00Z" }, situation),
    false,
    "expiring within the week",
  );
  // An unreadable expiry must mean regenerate. `NaN < x` is false, so a direct
  // comparison would quietly reuse the certificate forever.
  for (const expiresAt of [undefined, "", "whenever"]) {
    assert.equal(shouldReuseCertificate({ ...valid, expiresAt }, situation), false, String(expiresAt));
  }
});

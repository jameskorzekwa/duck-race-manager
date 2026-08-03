import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const requiredWorkerSecrets = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "NOTIFICATION_HMAC_SECRET",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_SITE_KEY",
];

export const optionalSmsWorkerSecrets = ["SMS_OPT_OUT_LIST_NAME", "SMS_ORIGINATION_IDENTITY"];

export const checkWorkerSecrets = (payload) => {
  if (!Array.isArray(payload)) throw new Error("Wrangler secret list did not return an array.");
  const names = new Set(payload.map((secret) => secret?.name).filter((name) => typeof name === "string"));
  const missing = requiredWorkerSecrets.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing required production Worker secret names: ${missing.join(", ")}.`);
  }
  const configuredSmsSecrets = optionalSmsWorkerSecrets.filter((name) => names.has(name));
  if (configuredSmsSecrets.length !== 0 && configuredSmsSecrets.length !== optionalSmsWorkerSecrets.length) {
    throw new Error("Optional SMS Worker secrets must be configured together or both omitted.");
  }
};

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  checkWorkerSecrets(JSON.parse(readFileSync(0, "utf8")));
  process.stdout.write("Required production Worker secret names are present; optional SMS secrets are consistent.\n");
}

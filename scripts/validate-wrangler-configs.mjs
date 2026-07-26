import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";

const configs = globSync("**/wrangler*.{json,jsonc,toml}", {
  exclude: [".wrangler/**", "node_modules/**"],
}).filter((config) => !/(^|\/)wrangler\.example\.(json|jsonc|toml)$/.test(config)).sort();

if (configs.length === 0) throw new Error("No Wrangler configuration was found.");

for (const config of configs) {
  process.stdout.write(`Validating ${config}\n`);
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["--no-install", "wrangler", "deploy", "--dry-run", "--config", config], {
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

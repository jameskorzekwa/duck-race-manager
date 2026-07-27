// Deletes the simulated local D1 database so the next run applies every
// migration to an empty schema.
//
// `npm run seed:local -- --state=empty` clears race *data* through the
// application. This is the blunter tool, for when the *schema* is what is stale:
// a new migration landed, or a local database drifted while a migration was
// being written. It only ever removes Wrangler's own local state directory.
import { rm, stat } from "node:fs/promises";
import { exit, stdout } from "node:process";

const stateDirectory = new URL("../.wrangler/state/v3/d1/", import.meta.url);

const exists = await stat(stateDirectory).then(() => true).catch(() => false);
if (!exists) {
  stdout.write("No local D1 state to remove.\n");
  exit(0);
}

await rm(stateDirectory, { recursive: true, force: true });
stdout.write(
  "Removed the local D1 state.\nRun `npm run dev:local` to recreate it, then `npm run seed:local` to fill it.\n",
);

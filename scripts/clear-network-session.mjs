// Removes the marker `npm run dev:network` leaves behind while it is serving.
//
// `npm run dev:local` runs this first so the seeding script targets whichever
// server started most recently. Without it, seeding after a network session would
// keep aiming at an origin nothing is listening on.
import { rmSync } from "node:fs";

rmSync(new URL("../.wrangler/local-network.json", import.meta.url), { force: true });

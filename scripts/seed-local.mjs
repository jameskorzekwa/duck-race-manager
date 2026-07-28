// Seeds the local database by driving the running local Worker over HTTP.
//
// Nothing here writes SQL. Every row is produced by the same handlers, guards,
// and idempotency rules that run in production, so a seeded database is a state
// the application could actually have reached. That is the point: a fixture built
// with direct inserts can express states the real workflow forbids, and then
// local testing proves nothing.
//
// Usage:
//   node scripts/seed-local.mjs --state=round-one
//   npm run seed:local -- --state=completed --participants=12
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { argv, env, execPath, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { localPreviewTurnstileToken } from "../src/local-preview.ts";

// `npm run dev:network` writes this while it is serving. Following it means the
// same seed command works in both modes: public registration checks the request
// Origin against APP_ORIGIN, so seeding a network session through
// `http://localhost:8787` would be rejected as cross-origin.
const networkSession = () => {
  const markerPath = new URL("../.wrangler/local-network.json", import.meta.url);
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
};

const states = ["empty", "draft", "registration", "closed", "round-one", "final", "completed"];

class SeedError extends Error {
  constructor(message, { cause, afterMutation = false } = {}) {
    super(message, { cause });
    this.afterMutation = afterMutation;
  }
}

const stateDescriptions = {
  empty: "No event at all — the public site shows the Preparing phase.",
  draft: "A DRAFT event that only staff can see.",
  registration: "Registration open, participants registered, some paired with ducks.",
  closed: "Registration closed, every participant paired, heats filled and waiting.",
  "round-one": "Round one under way: heat 1 finalized, heat 2 running, heat 3 called.",
  final: "Round one complete, finalists promoted, the final called and ready to run.",
  completed: "Finished race with a full podium and public results.",
};

const parseArguments = () => {
  const options = {
    url: networkSession()?.origin ?? "http://localhost:8787",
    state: "registration",
    participants: 9,
    heatSize: 3,
  };
  for (const argument of argv.slice(2)) {
    const match = argument.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (match === null) throw new SeedError(`Unrecognized argument: ${argument}\n\n${usage()}`);
    const [, name, value = ""] = match;
    if (name === "url") options.url = value.replace(/\/$/, "");
    else if (name === "state") options.state = value;
    else if (name === "participants") options.participants = Number(value);
    else if (name === "heat-size") options.heatSize = Number(value);
    else if (name === "help") options.help = true;
    else throw new SeedError(`Unrecognized option: --${name}\n\n${usage()}`);
  }
  if (options.help) return options;
  if (!states.includes(options.state)) {
    throw new SeedError(`--state must be one of: ${states.join(", ")}`);
  }
  if (!Number.isInteger(options.heatSize) || options.heatSize < 3) {
    throw new SeedError("--heat-size must be an integer of at least 3. A heat holds at least three ducks.");
  }
  if (!Number.isInteger(options.participants) || options.participants < 1) {
    throw new SeedError("--participants must be a positive integer.");
  }
  if (!/^https?:\/\/[^/]+$/.test(options.url)) {
    throw new SeedError(`--url must be an absolute http origin, for example http://localhost:8787 (got "${options.url}")`);
  }
  return options;
};

const usage = () => `Seed the local QuickDucks database with a testable race state.

  node scripts/seed-local.mjs [--state=<state>] [--participants=N] [--heat-size=N] [--url=<origin>]

States:
${states.map((state) => `  ${state.padEnd(13)} ${stateDescriptions[state]}`).join("\n")}

Defaults: --state=registration --participants=9 --heat-size=3 --url=http://localhost:8787
Every run first deletes the existing event, because QuickDucks holds one event at a time.
`;

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const firstNames = [
  "Daisy", "Donald", "Della", "Dewey", "Huey", "Louie", "Scrooge", "Webby", "Gyro",
  "Fenton", "Goldie", "Ludwig", "Magica", "Gladstone", "Duckworth", "Beakley", "Doofus", "Lena",
];
const lastNames = [
  "Duck", "Mallard", "Drake", "Bird", "Bird", "Bird", "McDuck", "Vanderquack", "Gearloose",
  "Crackshell", "O'Gilt", "Von Drake", "De Spell", "Gander", "Butler", "Beakley", "Drake", "Sabrewing",
];

const participantName = (index) => ({
  firstName: firstNames[index % firstNames.length],
  lastName: lastNames[index % lastNames.length],
});

const createClient = (baseUrl) => {
  let token;
  // Set once the first write has been issued, so a failure can say whether the
  // local database was left part-way through a race rather than untouched.
  const progress = { mutated: false };
  const request = async (path, { method = "GET", body, expect, label, anonymous = false, cookie } = {}) => {
    const headers = new Headers();
    if (!anonymous && token !== undefined) headers.set("authorization", `Bearer ${token}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    // Public mutations require the exact application origin; staff bearer calls
    // do not, but sending it everywhere keeps the seeded traffic shaped like a
    // browser's.
    headers.set("origin", baseUrl);
    if (cookie !== undefined) headers.set("cookie", cookie);

    if (method !== "GET") progress.mutated = true;
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
    } catch (cause) {
      throw new SeedError(
        `Could not reach ${baseUrl}. Start the local site first with: npm run dev:local`,
        { cause, afterMutation: progress.mutated },
      );
    }

    const text = await response.text();
    let parsed;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (expect !== undefined && !expect.includes(response.status)) {
      throw new SeedError(
        `${label ?? `${method} ${path}`} failed: expected ${expect.join(" or ")}, got ${response.status}\n${
          typeof parsed === "string" ? parsed.slice(0, 400) : JSON.stringify(parsed, null, 2)?.slice(0, 800)
        }`,
        { afterMutation: progress.mutated },
      );
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };

  return {
    request,
    setToken(value) {
      token = value;
    },
    get(path, options) {
      return request(path, { ...options, expect: options?.expect ?? [200] });
    },
    post(path, body, options) {
      return request(path, { ...options, method: "POST", body, expect: options?.expect ?? [200, 201] });
    },
    patch(path, body, options) {
      return request(path, { ...options, method: "PATCH", body, expect: options?.expect ?? [200] });
    },
  };
};

const step = (message) => stdout.write(`  ${message}\n`);

const seed = async (options) => {
  const client = createClient(options.url);

  // The local entry point owns these accounts. They are the only rows the seeder
  // cannot create through the public or staff API, because provisioning a staff
  // identity is the one operation that normally belongs to Cognito.
  const bootstrap = await client.post("/__local/staff", undefined, { anonymous: true, label: "bootstrap staff" });
  const accounts = bootstrap.body.accounts;
  const admin = accounts.find((account) => account.isSystemAdmin);
  if (admin === undefined) throw new SeedError("The local bootstrap returned no administrator account.");
  client.setToken(admin.token);
  step(`Signed in as ${admin.displayName} <${admin.email}>`);

  // One event exists at a time, so a repeatable seed always starts from empty.
  const existing = await client.get("/api/v1/staff/events", { label: "list events" });
  for (const event of existing.body.events) {
    await client.post(`/api/v1/staff/events/${event.id}/force-delete`, {
      commandId: crypto.randomUUID(),
      revision: event.revision,
      confirmName: event.name,
    }, { label: `delete existing event ${event.name}` });
    step(`Deleted the previous event "${event.name}"`);
  }
  if (options.state === "empty") return { state: options.state, accounts };

  const heatCount = Math.ceil(options.participants / options.heatSize);
  const eventDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const created = await client.post("/api/v1/staff/events", {
    commandId: crypto.randomUUID(),
    name: "Harbor Duck Derby",
    eventDate,
    roundOneHeatCapacity: options.heatSize,
  }, { label: "create event" });
  const eventId = created.body.event.id;
  step(`Created "${created.body.event.name}" (${eventId}) on ${eventDate}`);

  const configured = await client.patch(`/api/v1/staff/events/${eventId}/configuration`, {
    commandId: crypto.randomUUID(),
    revision: created.body.event.revision,
    timezone: "America/Los_Angeles",
    emailRequired: false,
    heatAssignmentMode: "IMMEDIATE_FIXED",
    roundOneHeatCapacity: options.heatSize,
    // The final has to hold one winner from every round-one heat.
    finalHeatCapacity: Math.max(3, heatCount),
    publicNamePolicy: "FIRST_NAME_LAST_INITIAL",
  }, { label: "configure event" });
  step(`Configured ${options.heatSize} ducks per heat, ${heatCount} round-one heats expected`);
  if (options.state === "draft") return { state: options.state, eventId, accounts, event: configured.body.event };

  await client.post(`/api/v1/staff/events/${eventId}/open-registration`, {
    commandId: crypto.randomUUID(),
  }, { label: "open registration" });
  step("Opened registration");

  // Registering through the public endpoint keeps one browser collection cookie
  // across every participant, exactly as a family registering several people on
  // one phone would, which is what makes the My Ducks page interesting locally.
  const participants = [];
  let browserCookie;
  for (let index = 0; index < options.participants; index += 1) {
    const { firstName, lastName } = participantName(index);
    const privateToken = randomToken();
    const response = await client.post("/api/v1/registrations", {
      eventId,
      commandId: crypto.randomUUID(),
      privateToken,
      firstName,
      lastName,
      // One participant deliberately has no contact details, so the staff views
      // are exercised with a sparse record too.
      ...(index === 2 ? {} : {
        email: `${firstName.toLowerCase()}${index}@example.test`,
        phone: `+1555010${String(index).padStart(4, "0")}`,
        emailNotificationsEnabled: index % 2 === 0,
      }),
      turnstileToken: localPreviewTurnstileToken,
    }, { anonymous: true, cookie: browserCookie, label: `register ${firstName}` });
    const issued = response.headers.getSetCookie()
      .find((cookie) => cookie.startsWith("__Host-quickducks_browser="))
      ?.split(";")[0];
    if (issued !== undefined) browserCookie = issued;
    participants.push({
      firstName,
      lastName,
      privateToken,
      registrationId: response.body.registrationId,
      lookupCode: response.body.lookupCode,
    });
  }
  step(`Registered ${participants.length} participants through the public form`);

  // How many participants hold a duck. Registration is the one state that is more
  // realistic part-way through: real events always have a queue of people waiting
  // to be paired.
  const pairCount = options.state === "registration"
    ? Math.max(1, Math.floor(participants.length * 2 / 3))
    : participants.length;

  for (const [index, participant] of participants.entries()) {
    if (index >= pairCount) break;
    const tagToken = randomToken();
    const intake = await client.post("/api/v1/staff/inventory/ducks", {
      commandId: crypto.randomUUID(),
      eventId,
      visibleNumber: 101 + index,
      tagToken,
      physicallyPresent: true,
      condition: "GOOD",
      location: index % 2 === 0 ? "Intake table A" : "Intake table B",
    }, { label: `intake duck ${101 + index}` });
    participant.tagToken = tagToken;
    participant.visibleNumber = intake.body.duck.visibleNumber;

    await client.post(`/api/v1/staff/ducks/${tagToken}/assignments`, {
      commandId: crypto.randomUUID(),
      eventId,
      lookupCode: participant.lookupCode,
    }, { label: `pair duck ${participant.visibleNumber}` });
  }
  step(`Took in and paired ${pairCount} ducks`);

  if (options.state === "registration") {
    return { state: options.state, eventId, accounts, participants, browserCookie };
  }

  await client.post(`/api/v1/staff/events/${eventId}/close-registration`, {
    commandId: crypto.randomUUID(),
  }, { label: "close registration" });
  step("Closed registration");
  if (options.state === "closed") {
    return { state: options.state, eventId, accounts, participants, browserCookie };
  }

  const readiness = await client.get(`/api/v1/staff/events/${eventId}/readiness`, { label: "readiness" });
  const roundOneReadiness = readiness.body?.readiness?.["start-round-one"];
  if (roundOneReadiness?.allowed !== true) {
    throw new SeedError(
      `Round one is not ready to start: ${JSON.stringify(roundOneReadiness?.blockers ?? readiness.body)}`,
      { afterMutation: true },
    );
  }
  await client.post(`/api/v1/staff/events/${eventId}/start-round-one`, {
    commandId: crypto.randomUUID(),
  }, { label: "start round one" });
  step("Started round one — every roster locked automatically");

  const heatState = async () => (await client.get(`/api/v1/staff/events/${eventId}/heats`, { label: "list heats" })).body.heats;
  const detail = async (heatId) => (await client.get(`/api/v1/staff/events/${eventId}/heats/${heatId}`, { label: "heat detail" })).body;
  const transition = async (heat, operation) => {
    const response = await client.post(`/api/v1/staff/events/${eventId}/heats/${heat.id}/${operation}`, {
      commandId: crypto.randomUUID(),
      revision: heat.revision,
    }, { label: `${operation} heat ${heat.number}` });
    heat.revision = response.body.heat.revision;
    heat.status = response.body.heat.status;
  };
  const finalize = async (heat, results) => {
    const response = await client.post(`/api/v1/staff/events/${eventId}/heats/${heat.id}/results/finalize`, {
      commandId: crypto.randomUUID(),
      revision: heat.revision,
      results,
    }, { label: `finalize heat ${heat.number}` });
    heat.revision = response.body.heat.revision;
    heat.status = response.body.heat.status;
  };

  const roundOneHeats = (await heatState()).filter((heat) => heat.round === "ROUND_ONE");
  for (const heat of roundOneHeats) {
    const heatDetail = await detail(heat.id);
    heat.revision = heatDetail.heat.revision;
    heat.roster = heatDetail.roster;
  }

  // A mid-round snapshot is the most useful racing state to test against: one
  // heat published, one on the water, one still waiting to be called.
  const runThrough = options.state === "round-one" ? 1 : roundOneHeats.length;
  for (const [index, heat] of roundOneHeats.entries()) {
    await transition(heat, "ready");
    await transition(heat, "call");
    if (index >= runThrough) continue;
    await transition(heat, "start");
    await transition(heat, "finish");
    await finalize(heat, [{ raceEntryId: heat.roster[0].raceEntryId, place: 1 }]);
  }
  if (options.state === "round-one") {
    const running = roundOneHeats[1];
    if (running !== undefined) {
      await transition(running, "start");
      step(`Finalized heat 1, left heat ${running.number} running on the water`);
    } else {
      step("Finalized heat 1");
    }
    return { state: options.state, eventId, accounts, participants, browserCookie };
  }
  step(`Ran and published all ${roundOneHeats.length} round-one heats`);

  await client.post(`/api/v1/staff/events/${eventId}/start-final`, {
    commandId: crypto.randomUUID(),
  }, { label: "start final" });
  const finalHeat = (await heatState()).find((heat) => heat.round === "FINAL");
  if (finalHeat === undefined) throw new SeedError("The final heat was not created by start-final.");
  const finalDetail = await detail(finalHeat.id);
  finalHeat.revision = finalDetail.heat.revision;
  finalHeat.roster = finalDetail.roster;
  await transition(finalHeat, "ready");
  await transition(finalHeat, "call");
  step(`Promoted ${finalHeat.roster.length} finalists and called the final`);
  if (options.state === "final") {
    return { state: options.state, eventId, accounts, participants, browserCookie };
  }

  await transition(finalHeat, "start");
  await transition(finalHeat, "finish");
  await finalize(
    finalHeat,
    finalHeat.roster
      .slice(0, Math.min(3, finalHeat.roster.length))
      .map((entry, index) => ({ raceEntryId: entry.raceEntryId, place: index + 1 })),
  );
  await client.post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  }, { label: "complete event" });
  step("Recorded the podium and completed the event");

  return { state: options.state, eventId, accounts, participants, browserCookie };
};

const report = (options, result) => {
  const lines = [
    "",
    `Local site seeded: ${result.state}`,
    `  ${stateDescriptions[result.state]}`,
    "",
    `  Public site      ${options.url}/`,
    `  Staff console    ${options.url}/staff`,
  ];
  const paired = (result.participants ?? []).filter((participant) => participant.tagToken !== undefined);
  if (paired.length > 0) {
    lines.push(
      `  Duck tag scan    ${options.url}/t/${paired[0].tagToken}`,
      `  Duck by number   ${options.url}/duck/${paired[0].visibleNumber}`,
    );
  }
  if ((result.participants ?? []).length > 0) {
    lines.push(`  Private status   ${options.url}/r/${result.participants[0].privateToken}`);
    lines.push(
      "",
      "  Lookup codes for staff search and pairing:",
      ...result.participants.slice(0, 5).map((participant) =>
        `    ${participant.lookupCode}  ${participant.firstName} ${participant.lastName}${
          participant.visibleNumber === undefined ? "  (unpaired)" : `  duck ${participant.visibleNumber}`
        }`
      ),
      ...(result.participants.length > 5 ? [`    … and ${result.participants.length - 5} more`] : []),
    );
  }
  lines.push(
    "",
    "  Sign in at /staff and pick any account — no password, no email code:",
    ...result.accounts.map((account) =>
      `    ${account.email.padEnd(30)} ${account.isSystemAdmin ? "Administrator" : account.roles.join(", ")}`
    ),
    "",
  );
  stdout.write(lines.join("\n"));
};

try {
  const options = parseArguments();
  if (options.help) {
    stdout.write(usage());
    exit(0);
  }

  // The network session serves a certificate this machine has no reason to trust
  // yet. `NODE_EXTRA_CA_CERTS` is only read at startup, so trusting it means
  // starting again with it set rather than reaching for a global switch that
  // would disable verification for everything.
  const session = networkSession();
  if (
    options.url.startsWith("https://")
    && session !== null
    && env.NODE_EXTRA_CA_CERTS === undefined
    && existsSync(session.certificatePath)
  ) {
    const restarted = spawnSync(execPath, [fileURLToPath(import.meta.url), ...argv.slice(2)], {
      stdio: "inherit",
      env: { ...env, NODE_EXTRA_CA_CERTS: session.certificatePath },
    });
    exit(restarted.status ?? 1);
  }

  stdout.write(`Seeding ${options.url} to "${options.state}"…\n`);
  report(options, await seed(options));
} catch (error) {
  if (error instanceof SeedError) {
    // A failure part-way through leaves a real, self-consistent event behind.
    // Say so, or the next person reads it as the previous run's leftovers.
    const partial = error.afterMutation
      ? "\nThe local database is now partially seeded. Re-run the command, or clear it with:\n  npm run seed:local -- --state=empty\n"
      : "";
    stderr.write(`\nSeeding failed.\n${error.message}\n${partial}\n`);
    exit(1);
  }
  throw error;
}

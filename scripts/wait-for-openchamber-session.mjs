import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_IDLE_GRACE_MS = 30_000;
const DEFAULT_DISCOVERY_MS = 180_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;

const delay = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

function finalLine(message) {
  return String(message?.text ?? "").trim().split(/\r?\n/).at(-1)?.trim() ?? "";
}

// Models are instructed to end with the marker, but a reviewer that appends one
// trailing sentence after a genuine verdict must not be scored as an
// infrastructure failure. Accept the marker anywhere in the final message as
// its own line, but only when it is unambiguous: exactly one marker line.
export function uniqueMarkerLine(message, markerPrefix) {
  const markers = String(message?.text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(markerPrefix));
  return markers.length === 1 ? markers[0] : null;
}

function runOpenChamber(args) {
  try {
    const output = execFileSync("openchamber", args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: DEFAULT_COMMAND_TIMEOUT_MS,
    });
    return JSON.parse(output);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`OpenChamber command failed: ${detail}`);
  }
}

// A run that outlives its polling budget must not leave the model running:
// an orphan session burns paid tokens and blocks every later run's recovery
// gate. Abort is best-effort through the local OpenChamber proxy using the
// desktop client token; the timeout failure is reported either way.
export async function abortSessions({ directory, sessionIds, fetchImpl = fetch }) {
  try {
    const dataDir = process.env.OPENCHAMBER_DATA_DIR?.trim()
      || path.join(process.env.HOME ?? "", ".config", "openchamber");
    const settings = JSON.parse(readFileSync(path.join(dataDir, "settings.json"), "utf8"));
    const port = Number(settings?.desktopLocalPort);
    const token = String(settings?.desktopLocalClientToken ?? "").trim();
    if (!Number.isInteger(port) || port <= 0 || token.length === 0) return false;
    const encoded = encodeURIComponent(directory);
    for (const sessionId of sessionIds) {
      await fetchImpl(`http://127.0.0.1:${port}/api/session/${sessionId}/abort?directory=${encoded}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

function listSessions(run, directory) {
  const status = run([
    "session", "list",
    "--dir", directory,
    "--with-status",
    "--all",
    "--limit", "1000",
    "--json",
  ]);
  return Array.isArray(status?.sessions) ? status.sessions : [];
}

// The OpenChamber CLI aborts non-blocking control calls after a fixed short
// HTTP timeout, so `session create` can report failure while the server keeps
// the dispatched session running. The per-run model directory is unique, so the
// parent session in that directory is the authoritative dispatch record.
export function resolveParentSession(sessions) {
  const parents = sessions.filter((session) => !session?.parentID);
  if (parents.length > 1) {
    throw new Error(`The model directory holds ${parents.length} parent sessions; refusing to guess.`);
  }
  return parents[0] ?? null;
}

export async function waitForOpenChamberSession({
  directory,
  timeoutSeconds,
  markerPrefix,
  run = runOpenChamber,
  sleep = delay,
  now = Date.now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  idleGraceMs = DEFAULT_IDLE_GRACE_MS,
  discoveryMs = DEFAULT_DISCOVERY_MS,
  abort = abortSessions,
  onSessionResolved,
}) {
  const modelDirectory = String(directory ?? "").trim();
  if (!modelDirectory) throw new Error("A model directory is required.");
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new Error("Polling timeout must be a positive integer number of seconds.");
  }
  if (typeof markerPrefix !== "string" || markerPrefix.length === 0) {
    throw new Error("A terminal marker prefix is required.");
  }

  const started = now();
  const deadline = started + timeoutSeconds * 1_000;
  let sessionId = null;
  let idleSince = null;
  let consecutiveFailures = 0;

  while (now() < deadline) {
    try {
      const sessions = listSessions(run, modelDirectory);
      const parent = resolveParentSession(sessions);

      if (!parent) {
        if (now() - started >= discoveryMs) {
          throw new Error(`OpenChamber never reported a dispatched session in ${modelDirectory}.`);
        }
      } else {
        if (parent.id !== sessionId) {
          sessionId = parent.id;
          onSessionResolved?.(sessionId);
        }
        const active = sessions.filter((session) => session?.status?.type !== "idle");
        if (active.length > 0) {
          idleSince = null;
        } else {
          idleSince ??= now();
          const response = run([
            "session", "messages",
            "--session", sessionId,
            "--dir", modelDirectory,
            "--last-assistant",
            "--json",
          ]);
          const message = Array.isArray(response?.messages) ? response.messages.at(-1) : null;
          if (message?.completedAt != null && uniqueMarkerLine(message, markerPrefix) !== null) {
            return { sessionId, directory: modelDirectory, sessionStatus: parent.status, lastAssistantMessage: message };
          }
          if (now() - idleSince >= idleGraceMs) {
            const suffix = finalLine(message);
            throw new Error(`Session ${sessionId} became idle without exactly one ${markerPrefix} marker${suffix ? `; final line: ${suffix}` : "."}`);
          }
        }
      }
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw error;
    }

    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollIntervalMs, remaining));
  }

  // Deadline passed with the session still active. Stop the model so the
  // partially completed workspace settles, can be saved as the next attempt's
  // seed, and cannot orphan-block later runs.
  try {
    const busy = listSessions(run, modelDirectory)
      .filter((session) => session?.status?.type !== "idle")
      .map((session) => session.id);
    if (busy.length > 0) {
      await abort({ directory: modelDirectory, sessionIds: busy });
      const settleDeadline = now() + 120_000;
      while (now() < settleDeadline) {
        const remainingBusy = listSessions(run, modelDirectory)
          .some((session) => session?.status?.type !== "idle");
        if (!remainingBusy) break;
        await sleep(Math.min(pollIntervalMs, settleDeadline - now()));
      }
    }
  } catch {}
  throw new Error(`Session ${sessionId ?? "dispatch"} did not complete within ${timeoutSeconds} seconds.`);
}

// Cleanup and recovery must fail closed on a busy session, but a straggler
// subagent finishing moments after the parent is normal. Wait for idle within a
// bounded window instead of discarding a completed attempt on one sample.
export async function waitForIdleSessions({
  directory,
  timeoutSeconds,
  requireSession = false,
  run = runOpenChamber,
  sleep = delay,
  now = Date.now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const modelDirectory = String(directory ?? "").trim();
  if (!modelDirectory) throw new Error("A model directory is required.");
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new Error("Idle timeout must be a positive integer number of seconds.");
  }

  const deadline = now() + timeoutSeconds * 1_000;
  let busy = [];
  while (true) {
    const sessions = listSessions(run, modelDirectory);
    if (sessions.length === 0) {
      if (requireSession) {
        throw new Error(`A dispatched model session is missing from OpenChamber status for ${modelDirectory}.`);
      }
      return [];
    }
    busy = sessions.filter((session) => session?.status?.type !== "idle");
    if (busy.length === 0) return sessions;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  throw new Error(`Model sessions remain active after ${timeoutSeconds} seconds: ${busy.map((session) => session.id).join(", ")}`);
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Invalid polling arguments.");
    values[key.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  if (args.mode === "idle") {
    if (!args.dir || !args.timeout) {
      throw new Error("Usage: wait-for-openchamber-session.mjs --mode idle --dir <path> --timeout <seconds> [--state <path>]");
    }
    let requireSession = false;
    if (args.state && existsSync(args.state)) {
      const state = JSON.parse(readFileSync(args.state, "utf8"));
      requireSession = path.resolve(String(state.directory ?? "")) === path.resolve(args.dir)
        && state.phase === "dispatching";
    }
    await waitForIdleSessions({
      directory: args.dir,
      timeoutSeconds: Number(args.timeout),
      requireSession,
    });
  } else {
    if (!args.dir || !args.result || !args.timeout || !args["marker-prefix"]) {
      throw new Error("Usage: wait-for-openchamber-session.mjs --dir <path> --result <path> --timeout <seconds> --marker-prefix <prefix> [--state <path>]");
    }
    const result = await waitForOpenChamberSession({
      directory: args.dir,
      timeoutSeconds: Number(args.timeout),
      markerPrefix: args["marker-prefix"],
      onSessionResolved: (sessionId) => {
        if (!args.state || !existsSync(args.state)) return;
        const state = JSON.parse(readFileSync(args.state, "utf8"));
        writeFileSync(args.state, JSON.stringify({ ...state, sessionId }));
      },
    });
    writeFileSync(args.result, JSON.stringify(result, null, 2));
  }
}

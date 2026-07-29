import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_IDLE_GRACE_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

const delay = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

function finalLine(message) {
  return String(message?.text ?? "").trim().split(/\r?\n/).at(-1)?.trim() ?? "";
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

export async function waitForOpenChamberSession({
  dispatch,
  timeoutSeconds,
  markerPrefix,
  run = runOpenChamber,
  sleep = delay,
  now = Date.now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  idleGraceMs = DEFAULT_IDLE_GRACE_MS,
}) {
  const sessionId = String(dispatch?.sessionId ?? "").trim();
  const directory = String(dispatch?.directory ?? "").trim();
  if (!sessionId || !directory || dispatch?.promptDispatched !== true) {
    throw new Error("OpenChamber did not confirm a dispatched session.");
  }
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new Error("Polling timeout must be a positive integer number of seconds.");
  }
  if (typeof markerPrefix !== "string" || markerPrefix.length === 0) {
    throw new Error("A terminal marker prefix is required.");
  }

  const deadline = now() + timeoutSeconds * 1_000;
  let idleSince = null;
  let missingSince = null;
  let consecutiveFailures = 0;

  while (now() < deadline) {
    try {
      const status = run([
        "session", "list",
        "--dir", directory,
        "--with-status",
        "--all",
        "--limit", "1000",
        "--json",
      ]);
      const sessions = Array.isArray(status?.sessions) ? status.sessions : [];
      const parent = sessions.find((session) => session?.id === sessionId);
      if (!parent) {
        missingSince ??= now();
        if (now() - missingSince >= idleGraceMs) {
          throw new Error(`OpenChamber did not report dispatched session ${sessionId}.`);
        }
        idleSince = null;
      } else {
        missingSince = null;
        const active = sessions.filter((session) => session?.status?.type !== "idle");
        if (active.length > 0) {
          idleSince = null;
        } else {
          idleSince ??= now();
          const response = run([
            "session", "messages",
            "--session", sessionId,
            "--dir", directory,
            "--last-assistant",
            "--json",
          ]);
          const message = Array.isArray(response?.messages) ? response.messages.at(-1) : null;
          if (message?.completedAt != null && finalLine(message).startsWith(markerPrefix)) {
            return { ...dispatch, sessionStatus: parent.status, lastAssistantMessage: message };
          }
          if (now() - idleSince >= idleGraceMs) {
            const suffix = finalLine(message);
            throw new Error(`Session ${sessionId} became idle without a completed ${markerPrefix} marker${suffix ? `; final line: ${suffix}` : "."}`);
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

  throw new Error(`Session ${sessionId} did not complete within ${timeoutSeconds} seconds.`);
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
  if (!args.dispatch || !args.result || !args.timeout || !args["marker-prefix"]) {
    throw new Error("Usage: wait-for-openchamber-session.mjs --dispatch <path> --result <path> --timeout <seconds> --marker-prefix <prefix>");
  }
  const dispatch = JSON.parse(readFileSync(args.dispatch, "utf8"));
  const result = await waitForOpenChamberSession({
    dispatch,
    timeoutSeconds: Number(args.timeout),
    markerPrefix: args["marker-prefix"],
  });
  writeFileSync(args.result, JSON.stringify(result, null, 2));
}

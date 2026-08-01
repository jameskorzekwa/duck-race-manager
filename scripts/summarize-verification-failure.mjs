import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactE2eOutput } from "./e2e-redaction.mjs";

const DEFAULT_MAX_CHARACTERS = 15000;
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_MAX_LINE_CHARACTERS = 400;
// Anchors are ordered by usefulness: the node:test failure block, then a
// Playwright numbered failure entry, then Playwright's run summary.
const FAILURE_ANCHORS = [
  /^\s*(?:\u2716 failing tests:|failing tests:|Failed tests:)/i,
  /^\s*\d+\)\s+\S/,
  /^\s*\d+ failed\b/,
];

// The local Worker logs one line per request and dwarfs the browser failure it
// surrounds, which is how a Playwright excerpt became unusable noise.
const NOISE = /\[WebServer\]/;
const GATE_START = /^===== verification start: (.+) =====$/;
const GATE_END = /^===== verification (passed|failed): (.+) \(exit \d+\) =====$/;
const FAILURE_IDENTITY = [
  /^\s*\u2716 (?!failing tests:).+/i,
  /^\s*\d+\)\s+\S+.*\u203a/,
  /^\s*(?:error TS\d+:|npm error\b|Error:).*/i,
];

// Hosted verification output is untrusted candidate-derived text. Neutralize
// pipeline markers so it can never forge durable state in an issue comment.
function neutralizeMarkers(text) {
  return text.replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");
}

export function summarizeVerificationFailure(log, {
  maxCharacters = DEFAULT_MAX_CHARACTERS,
  tailLines = DEFAULT_TAIL_LINES,
  maxLineCharacters = DEFAULT_MAX_LINE_CHARACTERS,
} = {}) {
  // A single assertion can dump an entire rendered page. Clip each line so one
  // value cannot crowd out the failing test name and the expected pattern.
  const clip = (line) => (line.length > maxLineCharacters
    ? `${line.slice(0, maxLineCharacters)} [line truncated]`
    : line);
  const lines = String(log ?? "").split(/\r?\n/)
    .filter((line) => !NOISE.test(line))
    .map((line) => clip(neutralizeMarkers(redactE2eOutput(line))));
  const identities = [...new Set(lines.filter((line) => FAILURE_IDENTITY.some((pattern) => pattern.test(line))))];
  const sections = [];
  let current;
  for (const line of lines) {
    const start = line.match(GATE_START);
    if (start) {
      current = { name: start[1], lines: [] };
      continue;
    }
    const end = line.match(GATE_END);
    if (end && current?.name === end[2]) {
      if (end[1] === "failed") sections.push(current);
      current = undefined;
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (sections.length > 0) {
    const index = identities.length > 0
      ? `Failure index (all failed gates):\n${identities.map((line) => `- ${line.trim()}`).join("\n")}\n\n`
      : "";
    const perSection = Math.max(500, Math.floor((maxCharacters - index.length) / sections.length));
    const details = sections.map(({ name, lines: sectionLines }) => {
      const start = FAILURE_ANCHORS.reduce(
        (found, anchor) => (found >= 0 ? found : sectionLines.findIndex((line) => anchor.test(line))),
        -1,
      );
      const selected = start >= 0 ? sectionLines.slice(start) : sectionLines.slice(-tailLines);
      const text = selected.join("\n").trim();
      return `===== ${name} =====\n${text.length > perSection ? `${text.slice(0, perSection)}\n[section truncated]` : text}`;
    }).join("\n\n");
    return `${index}${details}`.slice(0, maxCharacters).trim();
  }
  const start = FAILURE_ANCHORS.reduce(
    (found, anchor) => (found >= 0 ? found : lines.findIndex((line) => anchor.test(line))),
    -1,
  );
  const selected = start >= 0 ? lines.slice(start) : lines.slice(-tailLines);
  const text = selected.join("\n").trim();
  if (text.length <= maxCharacters) return text;
  // Keep the head: the failure identity and expectation lead the section.
  return `${text.slice(0, maxCharacters)}\n[truncated to the first ${maxCharacters} characters]`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [logPath, outputPath] = process.argv.slice(2);
  if (!logPath || !outputPath) {
    throw new Error("Usage: summarize-verification-failure.mjs <log-path> <output-path>");
  }
  let log = "";
  try {
    log = readFileSync(logPath, "utf8");
  } catch {}
  const summary = summarizeVerificationFailure(log);
  writeFileSync(outputPath, summary || "The deterministic release gate failed without captured output.");
}

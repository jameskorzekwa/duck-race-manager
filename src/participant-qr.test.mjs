import assert from "node:assert/strict";
import test from "node:test";

import {
  PARTICIPANT_QR_PREFIX,
  isLookupCode,
  normalizeLookupCode,
  parseParticipantQrPayload,
  participantQrPayload,
  renderParticipantQrSvg,
} from "./participant-qr.ts";

test("lookup codes normalize the way staff actually type and scan them", () => {
  assert.equal(normalizeLookupCode("  daasy234  "), "DAASY234");
  assert.equal(normalizeLookupCode("daas-y234"), "DAASY234");
  assert.equal(normalizeLookupCode("DAAS Y234"), "DAASY234");
  assert.ok(isLookupCode("DAASY234"));
  // The registration alphabet omits I, O, 0, and 1 so codes cannot be misread.
  assert.ok(!isLookupCode("DAISY234"));
  assert.ok(!isLookupCode("DAAS0234"));
  assert.ok(!isLookupCode("DAASY23"));
  assert.ok(!isLookupCode("DAASY2345"));
});

test("the QR payload carries only the lookup code behind a namespaced prefix", () => {
  assert.equal(participantQrPayload("daasy234"), "QD1:DAASY234");
  assert.equal(PARTICIPANT_QR_PREFIX, "QD1:");
  // Nothing else about the participant may be encoded.
  const payload = participantQrPayload("DAASY234");
  assert.equal(payload.length, PARTICIPANT_QR_PREFIX.length + 8);
  assert.throws(() => participantQrPayload("DAISY234"));
  assert.throws(() => participantQrPayload(""));
});

test("scanned payloads round-trip and unrelated QR codes are rejected", () => {
  assert.equal(parseParticipantQrPayload(participantQrPayload("DAASY234")), "DAASY234");
  assert.equal(parseParticipantQrPayload("  qd1:daasy234 "), "DAASY234");
  // A staff scanner must ignore anything that is not a participant payload
  // rather than sending it to the pairing command.
  assert.equal(parseParticipantQrPayload("https://quickducks.com/t/abcdefghijklmnopqrstuv"), null);
  assert.equal(parseParticipantQrPayload("DAASY234"), null);
  assert.equal(parseParticipantQrPayload("QD1:DAISY234"), null);
  assert.equal(parseParticipantQrPayload("QD1:"), null);
  assert.equal(parseParticipantQrPayload("WIFI:S:duck;T:WPA;P:hunter2;;"), null);
  assert.equal(parseParticipantQrPayload(""), null);
  assert.equal(parseParticipantQrPayload(null), null);
  assert.equal(parseParticipantQrPayload(42), null);
});

test("the rendered QR is a deterministic, self-contained, quiet-zoned SVG", () => {
  const svg = renderParticipantQrSvg("DAASY234");

  assert.equal(svg, renderParticipantQrSvg("daasy234"));
  assert.notEqual(svg, renderParticipantQrSvg("DAASY235"));
  // Version 1 (21 modules) plus the specified four-module quiet zone per side.
  assert.match(svg, /viewBox="0 0 29 29"/);
  assert.match(svg, /<rect width="29" height="29" fill="#ffffff"\/>/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="[^"]+"/);
  // No external references, script, or style may ride along in the markup.
  assert.doesNotMatch(svg, /<script|<style|href=|xlink|url\(|<image/i);
});

test("the QR markup contains only module geometry, never participant text", () => {
  const svg = renderParticipantQrSvg("DAASY234");
  const path = svg.match(/ d="([^"]*)"/)[1];

  assert.ok(path.length > 0);
  // Every path command is numeric geometry, so no caller value reaches markup.
  assert.match(path, /^[Mmhvz0-9 .-]+$/);
  assert.doesNotMatch(svg, /DAASY234/);
  assert.doesNotMatch(svg, /QD1:/);

  // Dark modules must stay inside the symbol, never in the quiet zone.
  for (const [, x, y] of path.matchAll(/M(\d+) (\d+)h/g)) {
    assert.ok(Number(x) >= 4 && Number(x) < 25, `module x ${x} is inside the quiet zone`);
    assert.ok(Number(y) >= 4 && Number(y) < 25, `module y ${y} is inside the quiet zone`);
  }
});

test("the rendered SVG matches the encoder's own module matrix", async () => {
  // Guards the hand-written run-length renderer against the encoder directly:
  // every dark module the encoder produces must be covered exactly once.
  const { encode } = await import("uqr");
  const { data, size } = encode("QD1:DAASY234", { ecc: "M", border: 4 });
  const covered = new Set();
  const path = renderParticipantQrSvg("DAASY234").match(/ d="([^"]*)"/)[1];

  for (const [, x, y, run] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let offset = 0; offset < Number(run); offset += 1) covered.add(`${Number(x) + offset},${y}`);
  }

  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (data[y][x] !== true) {
        assert.ok(!covered.has(`${x},${y}`), `light module ${x},${y} must not be painted`);
        continue;
      }
      dark += 1;
      assert.ok(covered.has(`${x},${y}`), `dark module ${x},${y} must be painted`);
    }
  }

  assert.equal(covered.size, dark);
  assert.ok(dark > 0);
});

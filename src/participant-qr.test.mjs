import assert from "node:assert/strict";
import test from "node:test";

import {
  PARTICIPANT_QR_PREFIX,
  isLookupCode,
  normalizeLookupCode,
  optionalParticipantQrGeometry,
  parseParticipantQrPayload,
  participantQrGeometry,
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

test("the SVG renderer and the shared geometry encode the same symbol", () => {
  // My Ducks draws from the geometry while the private status page draws from
  // the markup. They must stay one encoder, or a card could show a QR that
  // scans differently from the one beside the printed code.
  const geometry = participantQrGeometry("DAASY234");
  const markup = renderParticipantQrSvg("DAASY234");

  assert.ok(geometry.size > 0);
  assert.match(markup, new RegExp(`viewBox="0 0 ${geometry.size} ${geometry.size}"`));
  assert.ok(markup.includes(` d="${geometry.path}"`));
});

test("geometry paths carry only drawing commands, never caller input", () => {
  // The browser sets this straight onto an SVG path attribute, so the alphabet
  // it can contain is part of the contract rather than an implementation
  // detail. The client re-checks the same alphabet before drawing.
  for (const code of ["DAASY234", "ZZZZ2345", "BCDEFGHJ"]) {
    assert.match(participantQrGeometry(code).path, /^[Mhvz0-9 -]+$/);
  }
});

test("optional geometry degrades to null instead of throwing", () => {
  // One unencodable stored code must cost that card its QR, not fail the whole
  // My Ducks response for every other registration on the device.
  assert.equal(optionalParticipantQrGeometry(null), null);
  assert.equal(optionalParticipantQrGeometry(""), null);
  assert.equal(optionalParticipantQrGeometry("SHORT"), null);
  assert.equal(optionalParticipantQrGeometry("DAISY123"), null, "I and 1 are outside the alphabet");
  assert.deepEqual(
    optionalParticipantQrGeometry("DAASY234"),
    participantQrGeometry("DAASY234"),
  );
});

test("the geometry encodes the lookup code and nothing else", async () => {
  // The same privacy property the markup renderer is held to, checked against
  // the encoder's own matrix for the exact payload: a photographed card QR
  // reveals the code printed next to it and carries nothing extra. Comparing
  // sizes alone would pass for any code, since every valid one is version 1.
  const { encode } = await import("uqr");
  const expected = encode("QD1:DAASY234", { ecc: "M", border: 4 });
  const geometry = participantQrGeometry("DAASY234");
  assert.equal(geometry.size, expected.size);

  const painted = new Set();
  for (const [, x, y, run] of geometry.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let offset = 0; offset < Number(run); offset += 1) painted.add(`${Number(x) + offset},${y}`);
  }

  let dark = 0;
  for (let y = 0; y < expected.size; y += 1) {
    for (let x = 0; x < expected.size; x += 1) {
      const shouldPaint = expected.data[y][x] === true;
      if (shouldPaint) dark += 1;
      assert.equal(painted.has(`${x},${y}`), shouldPaint, `module ${x},${y}`);
    }
  }
  assert.ok(dark > 0);
  assert.equal(painted.size, dark);
});

test("the browser's path guard accepts everything this encoder emits", async () => {
  // The client re-checks the path alphabet before drawing, and that copy lives
  // in a served script rather than importing this module. Nothing but this
  // test stops the two from drifting: a widened encoder would keep the private
  // status page working while silently dropping every QR on My Ducks, which is
  // a half-broken release no other test would catch. Extract the guard the
  // browser actually runs and hold it against real output.
  const { participantScript } = await import("./client-scripts.ts");
  const source = participantScript.match(/participantQrPathPattern = (\/.+\/);/);
  assert.ok(source, "the served script must still define participantQrPathPattern");
  const [, body, flags] = source[1].match(/^\/(.*)\/([a-z]*)$/);
  const guard = new RegExp(body, flags);

  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let index = 0; index < alphabet.length; index += 1) {
    const code = Array.from({ length: 8 }, (_, position) => alphabet[(index + position * 7) % alphabet.length]).join("");
    const { size, path } = participantQrGeometry(code);
    assert.match(path, guard, `the browser would refuse to draw ${code}`);
    assert.equal(size, 29, `${code} must stay a version 1 symbol`);
  }
});

test("repeated encodes of one code reuse a frozen result", () => {
  // My Ducks re-derives every owned registration on each refresh, so the same
  // codes are encoded over and over for the length of a race. Callers share the
  // instance, so it must not be mutable.
  const first = participantQrGeometry("DAASY234");
  const second = participantQrGeometry("DAASY234");
  assert.equal(first, second, "the same code must not be re-encoded");
  assert.ok(Object.isFrozen(first));

  const other = participantQrGeometry("DUNALD45");
  assert.notEqual(other, first);
  assert.notEqual(other.path, first.path, "different codes must encode differently");

  // Normalization happens before the cache, so these must not be separate keys.
  assert.equal(participantQrGeometry(" daasy234 "), first);
});

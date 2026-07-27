import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

import { generateQrDecoderModule } from "../scripts/build-qr-decoder.mjs";
import { qrDecoderSource, qrDecoderVersion } from "./qr-decoder-source.ts";

const require = createRequire(import.meta.url);

test("the checked-in decoder matches the pinned upstream package exactly", async () => {
  // Regenerating must be a no-op. This is what stops the vendored browser
  // source from drifting from the audited dependency, silently or otherwise.
  const regenerated = await generateQrDecoderModule();
  const committed = readFileSync(new URL("./qr-decoder-source.ts", import.meta.url), "utf8");

  assert.equal(committed, regenerated, "run: node scripts/build-qr-decoder.mjs");
});

test("the decoder is pinned to an exact audited version", () => {
  const declared = require("../package.json").devDependencies.jsqr;
  const installed = require("jsqr/package.json").version;

  // An exact pin, so the served browser source cannot change without a review.
  assert.match(declared, /^\d+\.\d+\.\d+$/);
  assert.equal(declared, installed);
  assert.equal(qrDecoderVersion, installed);
  // It generates a client asset only and must never become a Worker runtime
  // dependency.
  assert.equal(require("../package.json").dependencies.jsqr, undefined);
});

test("the decoder is self-contained browser source with no network or eval reach", () => {
  assert.ok(qrDecoderSource.length > 50000, "decoder must be complete");
  assert.match(qrDecoderSource, /jsQR/);
  // A pure decoder: it must not fetch, load, or evaluate anything at runtime.
  assert.doesNotMatch(qrDecoderSource, /\bfetch\s*\(|XMLHttpRequest|importScripts|\beval\s*\(/);
  assert.doesNotMatch(qrDecoderSource, /\/\/[a-z0-9-]+\.[a-z]{2,}/i);
  // Minified in place from the package, not rebundled with other code.
  assert.doesNotMatch(qrDecoderSource, /sourceMappingURL/);
});

test("the decoder actually decodes a QuickDucks participant QR code", async () => {
  // End-to-end proof that the served source and the generated QR agree: run the
  // real browser decoder over the real rendered symbol.
  const { renderParticipantQrSvg, participantQrPayload } = await import("./participant-qr.ts");
  // The UMD wrapper attaches itself to the global it is given, exactly as it
  // will when the browser loads /assets/qr-decoder.js.
  const scope = {};
  new Function("self", qrDecoderSource)(scope);
  assert.equal(typeof scope.jsQR, "function", "decoder must expose the jsQR global");

  const scale = 8;
  const svg = renderParticipantQrSvg("DAASY234");
  const modules = Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
  const width = modules * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const [, x, y, run] of svg.match(/ d="([^"]*)"/)[1].matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let column = Number(x); column < Number(x) + Number(run); column += 1) {
      for (let row = 0; row < scale; row += 1) {
        for (let cell = 0; cell < scale; cell += 1) {
          const index = (((Number(y) * scale + row) * width) + (column * scale + cell)) * 4;
          pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
        }
      }
    }
  }

  const decoded = scope.jsQR(pixels, width, width, { inversionAttempts: "dontInvert" });
  assert.equal(decoded?.data, participantQrPayload("DAASY234"));
});

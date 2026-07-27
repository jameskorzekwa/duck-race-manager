// Regenerates `src/qr-decoder-source.ts` from the pinned `jsqr` package.
//
// The decoder is browser source that the Worker only serves, so it is embedded
// as a string rather than imported as code. Generating a plain TypeScript
// module keeps Node tests and the deployed Worker byte-identical, which a
// bundler-specific text-import rule would not.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { version } = require("jsqr/package.json");
const entry = require.resolve("jsqr/dist/jsQR.js");

export const generateQrDecoderModule = async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: readFileSync(entry, "utf8"),
      loader: "js",
      sourcefile: "jsQR.js",
    },
    // Minify in place only. Setting an output format makes esbuild wrap the
    // file in a CommonJS shim, which the UMD header then prefers over its
    // global branch, leaving `jsQR` undefined in the browser.
    bundle: false,
    minify: true,
    target: ["es2020"],
    legalComments: "none",
    write: false,
  });
  const source = outputFiles[0].text.trim();
  if (!source.includes("jsQR")) throw new Error("Generated decoder does not expose jsQR.");

  // Prove the minified result still installs the browser global before it can
  // be committed, rather than discovering it on a phone at the duck table.
  const scope = {};
  new Function("self", source)(scope);
  if (typeof scope.jsQR !== "function") throw new Error("Generated decoder does not expose a jsQR global.");
  return `// GENERATED FILE - DO NOT EDIT.
// Regenerate with: node scripts/build-qr-decoder.mjs
//
// Minified browser source of jsQR ${version} (Apache-2.0), served to the staff
// pairing page at /assets/qr-decoder.js for browsers without a native
// BarcodeDetector. It is never executed inside the Worker.
export const qrDecoderVersion = ${JSON.stringify(version)};

export const qrDecoderSource = ${JSON.stringify(source)};
`;
};

const target = new URL("../src/qr-decoder-source.ts", import.meta.url);

if (import.meta.filename === process.argv[1]) {
  const module = await generateQrDecoderModule();
  writeFileSync(target, module);
  process.stdout.write(`Wrote ${target.pathname} (${module.length} bytes) from jsqr ${version}\n`);
}

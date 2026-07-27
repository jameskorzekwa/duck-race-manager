import { encode } from "uqr";

// Participant pairing QR payload.
//
// The QR encodes the participant's existing eight-character lookup code and
// nothing else. It carries no name, contact detail, private status token, or
// event identifier, so photographing the QR reveals exactly what photographing
// the printed code beside it already would. Staff pairing still runs the full
// authenticated, role-checked, event-scoped server command; the QR only fills
// in the code a staff member would otherwise type.
//
// The `QD1:` prefix namespaces the value so the staff scanner ignores unrelated
// QR codes instead of trying to pair from them. Prefix and code both stay
// inside the QR alphanumeric character set, which keeps the symbol at version 1
// (21x21 modules) and therefore readable from a phone screen at small sizes.
export const PARTICIPANT_QR_PREFIX = "QD1:";

// The registration alphabet deliberately omits I, O, 0, and 1.
const LOOKUP_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

/** Normalizes typed or scanned input to the stored lookup-code form. */
export const normalizeLookupCode = (value: string): string =>
  value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Reports whether a normalized value is a well-formed lookup code. */
export const isLookupCode = (value: string): boolean => LOOKUP_CODE_PATTERN.test(value);

/** Builds the exact text encoded into a participant QR code. */
export const participantQrPayload = (lookupCode: string): string => {
  const normalized = normalizeLookupCode(lookupCode);
  if (!isLookupCode(normalized)) throw new Error("A valid participant lookup code is required.");
  return `${PARTICIPANT_QR_PREFIX}${normalized}`;
};

/**
 * Reads a scanned QR value back into a lookup code.
 *
 * Returns `null` for anything that is not a QuickDucks participant payload so
 * the scanner can keep looking instead of sending an unrelated value to the
 * pairing command.
 */
export const parseParticipantQrPayload = (value: string): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.toUpperCase().startsWith(PARTICIPANT_QR_PREFIX)) return null;
  const code = normalizeLookupCode(trimmed.slice(PARTICIPANT_QR_PREFIX.length));
  return isLookupCode(code) ? code : null;
};

// Four modules is the quiet zone the QR specification requires around the
// symbol. Keeping it inside the generated SVG means the surrounding page
// styling cannot accidentally crowd the code and break scanning.
const QUIET_ZONE_MODULES = 4;

/**
 * Renders a participant lookup code as a self-contained monochrome SVG.
 *
 * Every value written into the markup is either a fixed string owned by this
 * module or a number derived from the encoder's boolean matrix, so no caller
 * input reaches the document as markup.
 */
export const renderParticipantQrSvg = (lookupCode: string): string => {
  const { data, size } = encode(participantQrPayload(lookupCode), {
    ecc: "M",
    border: QUIET_ZONE_MODULES,
  });

  // Merge each horizontal run of dark modules into one path segment. The result
  // is a fraction of the size of one rect per module and renders identically.
  const segments: string[] = [];
  for (let y = 0; y < size; y += 1) {
    let runStart = -1;
    for (let x = 0; x <= size; x += 1) {
      const dark = x < size && data[y][x] === true;
      if (dark && runStart === -1) runStart = x;
      if (!dark && runStart !== -1) {
        segments.push(`M${runStart} ${y}h${x - runStart}v1h-${x - runStart}z`);
        runStart = -1;
      }
    }
  }

  return `<svg class="participant-qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" `
    + `shape-rendering="crispEdges" role="img" aria-label="QR code containing this participant&#39;s staff lookup code">`
    + `<rect width="${size}" height="${size}" fill="#ffffff"/>`
    + `<path fill="#111827" d="${segments.join("")}"/>`
    + `</svg>`;
};

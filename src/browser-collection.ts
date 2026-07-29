import { hashToken, randomToken } from "./registration.ts";
import type { Env } from "./types.ts";

const cookieName = "__Host-quickducks_browser";
const maxAgeSeconds = 365 * 24 * 60 * 60;

export interface BrowserCollection {
  id: string;
  cookieToken: string;
  expiresAt: string;
  isNew: boolean;
}

const ownershipProofPattern = /^[A-Za-z0-9_-]{43}$/;
const ownershipProofEncoder = new TextEncoder();

const ownershipKey = (collection: BrowserCollection) => crypto.subtle.importKey(
  "raw",
  ownershipProofEncoder.encode(collection.cookieToken),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"],
);

const ownershipMessage = (
  collection: BrowserCollection,
  purpose: string,
  registrationId: string,
  material = "",
): Uint8Array => ownershipProofEncoder.encode(
  `quickducks-browser-ownership-v1\u0000${purpose}\u0000${collection.id}\u0000${registrationId}\u0000${material}`,
);

const base64Url = (value: ArrayBuffer): string => {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

// A proof is scoped to one collection and one participant. It is derived from
// the HttpOnly collection token, so old collection links need no backfill and a
// proof copied to another device is useless without the matching cookie.
export const participantOwnershipProof = async (
  collection: BrowserCollection,
  registrationId: string,
): Promise<string> => base64Url(await crypto.subtle.sign(
  "HMAC",
  await ownershipKey(collection),
  ownershipMessage(collection, "participant-contact", registrationId),
));

export const isParticipantOwnershipProof = (value: string): boolean => ownershipProofPattern.test(value);

export const verifyParticipantOwnershipProof = async (
  collection: BrowserCollection,
  registrationId: string,
  proof: string,
): Promise<boolean> => {
  if (!isParticipantOwnershipProof(proof)) return false;
  try {
    const encoded = proof.replaceAll("-", "+").replaceAll("_", "/") + "=";
    const signature = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    return await crypto.subtle.verify(
      "HMAC",
      await ownershipKey(collection),
      signature,
      ownershipMessage(collection, "participant-contact", registrationId),
    );
  } catch {
    return false;
  }
};

// The command log retains only this keyed digest. Contact values and consent
// choices cannot be recovered or dictionary-tested without the device secret.
export const participantContactFingerprint = async (
  collection: BrowserCollection,
  registrationId: string,
  material: string,
): Promise<string> => base64Url(await crypto.subtle.sign(
  "HMAC",
  await ownershipKey(collection),
  ownershipMessage(collection, "participant-contact-command", registrationId, material),
));

const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get("cookie");
  if (header === null) return null;

  for (const item of header.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return null;
};

export const browserCollectionCookie = (token: string): string =>
  `${cookieName}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;

export const clearBrowserCollectionCookie = (): string =>
  `${cookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

export const getBrowserCollection = async (
  request: Request,
  env: Env,
): Promise<BrowserCollection | null> => {
  const cookieToken = readCookie(request, cookieName);
  if (cookieToken === null || !/^[A-Za-z0-9_-]{43}$/.test(cookieToken)) return null;

  const tokenHash = await hashToken(cookieToken);
  const now = new Date().toISOString();
  const collection = await env.DB.prepare(
    `SELECT id, expires_at
       FROM browser_registration_collections
      WHERE token_hash = ? AND expires_at > ?`,
  ).bind(tokenHash, now).first<{ id: string; expires_at: string }>();
  if (collection === null) return null;

  return {
    id: collection.id,
    cookieToken,
    expiresAt: collection.expires_at,
    isNew: false,
  };
};

export const prepareBrowserCollection = async (
  request: Request,
  env: Env,
): Promise<BrowserCollection> => {
  const existing = await getBrowserCollection(request, env);
  const expiresAt = new Date(Date.now() + maxAgeSeconds * 1000).toISOString();
  if (existing !== null) return { ...existing, expiresAt };

  return {
    id: crypto.randomUUID(),
    cookieToken: randomToken(),
    expiresAt,
    isNew: true,
  };
};

export const refreshBrowserCollection = async (
  env: Env,
  collection: BrowserCollection,
): Promise<BrowserCollection> => {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + maxAgeSeconds * 1000).toISOString();
  await env.DB.prepare(
    `UPDATE browser_registration_collections
        SET last_seen_at = ?, expires_at = ?
      WHERE id = ?`,
  ).bind(now, expiresAt, collection.id).run();
  return { ...collection, expiresAt };
};

const collectionOwnerStatement = async (
  env: Env,
  collection: BrowserCollection,
  now: string,
): Promise<D1PreparedStatement> => collection.isNew
  ? env.DB.prepare(
    `INSERT INTO browser_registration_collections
        (id, token_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    collection.id,
    await hashToken(collection.cookieToken),
    now,
    now,
    collection.expiresAt,
  )
  : env.DB.prepare(
    `UPDATE browser_registration_collections
          SET last_seen_at = ?, expires_at = ?
        WHERE id = ?`,
  ).bind(now, collection.expiresAt, collection.id);

// Links created by registering in this browser. Registering always wins over a
// pre-existing followed link, because this browser genuinely holds the
// registration's lookup code and private token.
export const collectionStatements = async (
  env: Env,
  collection: BrowserCollection,
  registrationId: string,
  now: string,
): Promise<D1PreparedStatement[]> => [
  await collectionOwnerStatement(env, collection, now),
  env.DB.prepare(
    `INSERT INTO browser_collection_registrations
      (collection_id, registration_id, added_at, added_via)
     VALUES (?, ?, ?, 'REGISTRATION')
     ON CONFLICT (collection_id, registration_id)
     DO UPDATE SET added_via = 'REGISTRATION'`,
  ).bind(collection.id, registrationId, now),
];

// Links created from the public name search. These are idempotent and must
// never upgrade an existing link, so a followed entry can never gain the staff
// lookup code that the public search deliberately withholds.
export const followStatements = async (
  env: Env,
  collection: BrowserCollection,
  registrationId: string,
  now: string,
): Promise<D1PreparedStatement[]> => [
  await collectionOwnerStatement(env, collection, now),
  env.DB.prepare(
    `INSERT OR IGNORE INTO browser_collection_registrations
      (collection_id, registration_id, added_at, added_via)
     VALUES (?, ?, ?, 'FOLLOWED')`,
  ).bind(collection.id, registrationId, now),
];

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

export const collectionStatements = async (
  env: Env,
  collection: BrowserCollection,
  registrationId: string,
  now: string,
): Promise<D1PreparedStatement[]> => {
  const statements: D1PreparedStatement[] = [];
  if (collection.isNew) {
    statements.push(env.DB.prepare(
      `INSERT INTO browser_registration_collections
        (id, token_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      collection.id,
      await hashToken(collection.cookieToken),
      now,
      now,
      collection.expiresAt,
    ));
  } else {
    statements.push(env.DB.prepare(
      `UPDATE browser_registration_collections
          SET last_seen_at = ?, expires_at = ?
        WHERE id = ?`,
    ).bind(now, collection.expiresAt, collection.id));
  }

  statements.push(env.DB.prepare(
    `INSERT OR IGNORE INTO browser_collection_registrations
      (collection_id, registration_id, added_at)
     VALUES (?, ?, ?)`,
  ).bind(collection.id, registrationId, now));
  return statements;
};

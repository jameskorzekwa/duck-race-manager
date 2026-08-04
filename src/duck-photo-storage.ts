import type { Env } from "./types.ts";

// R2 deletion is deliberately downstream of the D1 tombstone transaction. A
// missing object is a successful idempotent cleanup; transient failures leave
// the opaque key in D1 for the scheduled retry.
export const drainDuckPhotoCleanup = async (env: Env, limit = 25): Promise<void> => {
  if (!env.DUCK_PHOTOS) return;
  let queued: D1Result<{ object_key: string }>;
  try {
    queued = await env.DB.prepare(
      `SELECT object_key FROM duck_photo_cleanup
        WHERE queued_at <= ?
        ORDER BY queued_at, object_key LIMIT ?`,
    ).bind(new Date().toISOString(), limit).all<{ object_key: string }>();
  } catch {
    return;
  }
  for (const row of queued.results) {
    try {
      await env.DUCK_PHOTOS.delete(row.object_key);
      await env.DB.batch([env.DB.prepare(
        "DELETE FROM duck_photo_cleanup WHERE object_key = ?",
      ).bind(row.object_key)]);
    } catch {
      try {
        await env.DB.batch([env.DB.prepare(
          `UPDATE duck_photo_cleanup
              SET attempt_count = attempt_count + 1, last_attempt_at = ?
            WHERE object_key = ?`,
        ).bind(new Date().toISOString(), row.object_key)]);
      } catch {
        // The durable row is still present; the next scheduled drain retries it.
      }
    }
  }
};

export const queueDuckPhotoCleanup = async (env: Env, objectKey: string): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO duck_photo_cleanup (object_key, queued_at) VALUES (?, ?)`,
    ).bind(objectKey, now),
    // A candidate upload is staged with a short lease. Once association fails,
    // move that existing row into the immediately eligible cleanup queue.
    env.DB.prepare(
      `UPDATE duck_photo_cleanup SET queued_at = ?
        WHERE object_key = ? AND queued_at > ?`,
    ).bind(now, objectKey, now),
  ]);
  await drainDuckPhotoCleanup(env);
};

// Candidate bytes are written before their guarded D1 association. Record the
// opaque key first with a lease longer than a Worker request, so a lost request
// still becomes collectible without a scheduled drain racing an active upload.
export const stageDuckPhotoCleanup = async (
  env: Env,
  objectKey: string,
  leaseMs = 10 * 60 * 1000,
): Promise<void> => {
  const eligibleAt = new Date(Date.now() + leaseMs).toISOString();
  await env.DB.batch([env.DB.prepare(
    `INSERT OR IGNORE INTO duck_photo_cleanup (object_key, queued_at) VALUES (?, ?)`,
  ).bind(objectKey, eligibleAt)]);
};

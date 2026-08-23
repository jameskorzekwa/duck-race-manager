import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { drainDuckPhotoCleanup } from "./duck-photo-storage.ts";

const migrationsUrl = new URL("../db/migrations/", import.meta.url);
const migrationNames = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

const migratedDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  return database;
};

const sqliteD1 = (database) => ({
  prepare(sql) {
    return {
      sql,
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      async all() {
        return { results: database.prepare(this.sql).all(...this.args) };
      },
    };
  },
  async batch(items) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const results = items.map((item) => {
        const result = database.prepare(item.sql).run(...item.args);
        return { success: true, meta: { changes: Number(result.changes) } };
      });
      database.exec("COMMIT");
      return results;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
});

class TestR2Bucket {
  objects = new Set();
  failures = new Set();
  deletes = [];

  async delete(key) {
    this.deletes.push(key);
    if (this.failures.has(key)) throw new Error("simulated R2 delete failure");
    this.objects.delete(key);
  }
}

const makeEnv = (database, bucket) => ({ DB: sqliteD1(database), DUCK_PHOTOS: bucket });

test("a failing cleanup key does not starve a later healthy key", async (context) => {
  const database = migratedDatabase();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO duck_photo_cleanup (object_key, queued_at) VALUES
      ('a-poison', '2026-01-01T00:00:00.000Z'),
      ('b-healthy', '2026-01-01T00:00:01.000Z')
  `);
  const bucket = new TestR2Bucket();
  bucket.failures.add("a-poison");
  bucket.objects.add("b-healthy");
  const env = makeEnv(database, bucket);

  await drainDuckPhotoCleanup(env, 1);
  await drainDuckPhotoCleanup(env, 1);

  assert.deepEqual(bucket.deletes, ["a-poison", "b-healthy"]);
  assert.equal(bucket.objects.has("b-healthy"), false);
  assert.deepEqual(
    database.prepare("SELECT object_key, attempt_count FROM duck_photo_cleanup").all().map((row) => ({ ...row })),
    [{ object_key: "a-poison", attempt_count: 1 }],
  );
});

test("failed cleanup uses attempt count for backoff and remains retryable", async (context) => {
  const database = migratedDatabase();
  context.after(() => database.close());
  database.prepare(`
    INSERT INTO duck_photo_cleanup (object_key, queued_at, attempt_count)
    VALUES (?, ?, ?)
  `).run("poison", "2026-01-01T00:00:00.000Z", 3);
  const bucket = new TestR2Bucket();
  bucket.failures.add("poison");
  const env = makeEnv(database, bucket);

  await drainDuckPhotoCleanup(env);

  const backedOff = database.prepare(`
    SELECT attempt_count, last_attempt_at, queued_at
      FROM duck_photo_cleanup WHERE object_key = ?
  `).get("poison");
  assert.equal(backedOff.attempt_count, 4);
  assert.equal(Date.parse(backedOff.queued_at) - Date.parse(backedOff.last_attempt_at), 8 * 60 * 1000);

  await drainDuckPhotoCleanup(env);
  assert.deepEqual(bucket.deletes, ["poison"], "backed-off work is not retried immediately");

  database.prepare("UPDATE duck_photo_cleanup SET queued_at = ? WHERE object_key = ?")
    .run("2026-01-01T00:00:00.000Z", "poison");
  bucket.failures.delete("poison");
  await drainDuckPhotoCleanup(env);
  assert.deepEqual(bucket.deletes, ["poison", "poison"]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM duck_photo_cleanup").get().count, 0);
});

test("successful cleanup deletes present and missing objects and removes their rows", async (context) => {
  const database = migratedDatabase();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO duck_photo_cleanup (object_key, queued_at) VALUES
      ('existing', '2026-01-01T00:00:00.000Z'),
      ('already-missing', '2026-01-01T00:00:00.000Z')
  `);
  const bucket = new TestR2Bucket();
  bucket.objects.add("existing");

  await drainDuckPhotoCleanup(makeEnv(database, bucket));

  assert.deepEqual(bucket.deletes, ["already-missing", "existing"]);
  assert.equal(bucket.objects.size, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM duck_photo_cleanup").get().count, 0);
});

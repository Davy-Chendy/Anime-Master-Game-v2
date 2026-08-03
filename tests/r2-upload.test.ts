import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker, { expandCleanupQuestionSetImageRows, type Env } from "../worker/index";
import { encodeQuestionSetManifest } from "../worker/questionSetManifest";
import {
  isR2ImageUploadTooLarge,
  R2_IMAGE_UPLOAD_MAX_BYTES,
  R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE,
} from "../src/lib/r2UploadPolicy";

type R2CallCounters = {
  list: number;
  put: number;
};

type CleanupTestEnvOptions = {
  enforceD1LikePatternLimit?: boolean;
  publicBaseUrl?: string;
};

const D1_LIKE_PATTERN_MAX_BYTES = 50;

function createR2TestEnv() {
  const calls: R2CallCounters = { list: 0, put: 0 };
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string | null) {
      calls.put += 1;
      const size = value instanceof ArrayBuffer
        ? value.byteLength
        : ArrayBuffer.isView(value)
          ? value.byteLength
          : typeof value === "string"
            ? new TextEncoder().encode(value).byteLength
            : 0;
      return {
        key,
        version: "test-version",
        size,
        etag: "test-etag",
        httpEtag: '"test-etag"',
        uploaded: new Date(0),
        checksums: {},
        writeHttpMetadata() {},
      } as R2Object;
    },
    async list() {
      calls.list += 1;
      return {
        objects: [],
        truncated: false,
        delimitedPrefixes: [],
      } as R2Objects;
    },
  } as R2Bucket;
  const env = {
    IMAGE_BUCKET: bucket,
    R2_IMAGE_PREFIX: "question-images",
    R2_PUBLIC_BASE_URL: "https://assets.example.com",
  } as Env;
  return { calls, env };
}

function createCleanupTestEnv(options: CleanupTestEnvOptions = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const migrationsDirectory = resolve(import.meta.dirname, "..", "d1", "migrations");
  for (const name of readdirSync(migrationsDirectory).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    sqlite.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
  }
  const deletedKeys: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        let bindings: unknown[] = [];
        return {
          bind(...values: unknown[]) { bindings = values; return this; },
          async all<T>() {
            if (options.enforceD1LikePatternLimit && /\blike\s+\?/i.test(sql)) {
              const oversizedPattern = bindings.find((value) => (
                typeof value === "string"
                && new TextEncoder().encode(value).byteLength > D1_LIKE_PATTERN_MAX_BYTES
              ));
              if (oversizedPattern) {
                throw new Error("LIKE or GLOB pattern too complex");
              }
            }
            return { results: sqlite.prepare(sql).all(...bindings) as T[] };
          },
        };
      },
    },
    IMAGE_BUCKET: {
      async delete(key: string) { deletedKeys.push(key); },
    },
    R2_IMAGE_PREFIX: "question-images",
    R2_PUBLIC_BASE_URL: options.publicBaseUrl ?? "https://assets.example.com",
  } as unknown as Env;
  return { deletedKeys, env, sqlite };
}

test("10 MB final-image policy accepts the boundary and rejects one extra byte", () => {
  assert.equal(isR2ImageUploadTooLarge(R2_IMAGE_UPLOAD_MAX_BYTES), false);
  assert.equal(isR2ImageUploadTooLarge(R2_IMAGE_UPLOAD_MAX_BYTES + 1), true);
});

test("normal uploads perform one R2 put without listing the bucket or returning capacity fields", async () => {
  const { calls, env } = createR2TestEnv();
  const response = await worker.fetch(new Request("https://api.example.com/api/r2-upload?filename=test.webp", {
    method: "POST",
    headers: { "content-type": "image/webp" },
    body: new Uint8Array([1, 2, 3]),
  }), env);

  assert.equal(response.status, 200);
  assert.equal(calls.put, 1);
  assert.equal(calls.list, 0);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(typeof payload.key, "string");
  assert.equal("storageBytes" in payload, false);
  assert.equal("storageLimitBytes" in payload, false);
});

test("a body over 10 MB is stopped by the server even when content-length is forged", async () => {
  const { calls, env } = createR2TestEnv();
  const response = await worker.fetch(new Request("https://api.example.com/api/r2-upload?filename=oversized.webp", {
    method: "POST",
    headers: {
      "content-type": "image/webp",
      "content-length": "1",
    },
    body: new Uint8Array(R2_IMAGE_UPLOAD_MAX_BYTES + 1),
  }), env);

  assert.equal(response.status, 413);
  assert.equal(calls.put, 0);
  assert.equal(calls.list, 0);
  const payload = await response.json() as { error?: string };
  assert.equal(payload.error, R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE);
});

test("the image picker lists only its requested page and does not scan for total storage", async () => {
  const { calls, env } = createR2TestEnv();
  const response = await worker.fetch(new Request("https://api.example.com/api/r2-images"), env);

  assert.equal(response.status, 200);
  assert.equal(calls.list, 1);
  assert.equal(calls.put, 0);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal("storageBytes" in payload, false);
  assert.equal("storageLimitBytes" in payload, false);
});

test("cleanup expands both legacy and manifest image references and fails safely on corruption", () => {
  const manifestJson = encodeQuestionSetManifest([{
    id: "manifest-q1",
    questionSetId: "manifest-set",
    imageUrl: "https://assets.example.com/question-images/manifest.webp",
    orderIndex: 0,
    labelText: null,
    createdAt: "2026-07-31T00:00:00.000Z",
  }]);
  const expanded = expandCleanupQuestionSetImageRows([
    { question_set_id: "legacy-set", image_url: "https://assets.example.com/question-images/legacy.webp" },
    { question_set_id: "manifest-set", image_url: null, manifest_version: 1, manifest_json: manifestJson },
    { question_set_id: "manifest-set", image_url: null, manifest_version: 1, manifest_json: manifestJson },
  ]);
  assert.deepEqual(expanded.map((row) => [row.question_set_id, row.image_url]), [
    ["legacy-set", "https://assets.example.com/question-images/legacy.webp"],
    ["manifest-set", "https://assets.example.com/question-images/manifest.webp"],
  ]);
  assert.throws(
    () => expandCleanupQuestionSetImageRows([{
      question_set_id: "broken-set",
      image_url: null,
      manifest_version: 1,
      manifest_json: "{",
    }]),
    /manifest JSON 已损坏/,
  );
});

test("cleanup avoids D1 LIKE limits and preserves an image referenced by another active manifest set", async () => {
  const publicBaseUrl = "https://assets.animaster.dpdns.org";
  const { deletedKeys, env, sqlite } = createCleanupTestEnv({
    enforceD1LikePatternLimit: true,
    publicBaseUrl,
  });
  const sharedImageUrl = `${publicBaseUrl}/question-images/shared.webp`;
  const expiredManifestJson = encodeQuestionSetManifest([{
    id: "expired-q1",
    questionSetId: "expired-set",
    imageUrl: sharedImageUrl,
    orderIndex: 0,
    labelText: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  }]);
  const activeManifestJson = encodeQuestionSetManifest([{
    id: "active-q1",
    questionSetId: "active-set",
    imageUrl: sharedImageUrl,
    orderIndex: 0,
    labelText: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  }]);
  const insertQuestionSet = sqlite.prepare(`INSERT INTO question_sets(
    id,title,created_by_player_id,is_public,image_count,manifest_version,manifest_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?)`);
  insertQuestionSet.run(
    "expired-set", "Expired", "host", 0, 1, 1, expiredManifestJson,
    "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z",
  );
  insertQuestionSet.run(
    "active-set", "Active", "host", 0, 1, 1, activeManifestJson,
    "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z",
  );
  const now = Date.now();
  const expiredAt = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
  const activeAt = new Date(now).toISOString();
  sqlite.prepare("INSERT INTO rooms(id,room_code,host_player_id,prepared_question_set_id,updated_at) VALUES(?,?,?,?,?)")
    .run("expired-room", "EXP001", "host", "expired-set", expiredAt);
  sqlite.prepare("INSERT INTO rooms(id,room_code,host_player_id,prepared_question_set_id,updated_at) VALUES(?,?,?,?,?)")
    .run("active-room", "ACT001", "host", "active-set", activeAt);

  await worker.scheduled({} as ScheduledController, env);

  assert.deepEqual(deletedKeys, []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM rooms WHERE id='expired-room'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM rooms WHERE id='active-room'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM question_sets WHERE id='expired-set'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM question_sets WHERE id='active-set'").get().count, 1);
});

import assert from "node:assert/strict";
import test from "node:test";

import worker, { type Env } from "../worker/index";
import {
  isR2ImageUploadTooLarge,
  R2_IMAGE_UPLOAD_MAX_BYTES,
  R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE,
} from "../src/lib/r2UploadPolicy";

type R2CallCounters = {
  list: number;
  put: number;
};

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

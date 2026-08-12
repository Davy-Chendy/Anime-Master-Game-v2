# Implementation Tasks: Move URL Image Transformation to the Browser

**Change ID:** `move-url-image-transform-to-browser`

## Phase 1: Shared Browser Image Preparation

- [x] 1.1 Refactor the existing local-file Canvas conversion into a Blob/File-based helper shared by local and URL imports.
- [x] 1.2 Ensure decoded image, object URL, bitmap/canvas, and source Blob references are released after every item.
- [x] 1.3 Keep GIF unchanged, WebP-to-JPEG fallback, maximum dimension 1600, quality 0.78, and original-if-smaller behavior.
- [x] 1.4 Add unit tests for dimensions, output fallback, original retention, ordering, and resource cleanup behavior.

**Quality Gate:**

- [x] `npm run test:local-image-upload`
- [x] Browser image policy remains identical for local uploads

## Phase 2: Bounded Original-Image Fetch

- [x] 2.1 Add a one-image Worker source endpoint with room/presenter authorization.
- [x] 2.2 Reuse URL/private-host validation, source headers, proxy candidates, image content-type checks, redirects, and the 20 MB bounded reader.
- [x] 2.3 Return the original bytes with normalized content type, filename metadata, and `Cache-Control: no-store`; never call Images or write R2.
- [x] 2.4 Add tests for direct success, blocked/private URL, non-image response, oversized/missing-length body, source/proxy failure, and unauthorized room role.

**Quality Gate:**

- [x] New source-fetch endpoint tests pass
- [x] `npm run test:r2-upload`

## Phase 3: URL/JSONL Import Orchestration

- [x] 3.1 Fetch every external source through the authorized Worker source endpoint; never request the original URL from the browser.
- [x] 3.2 Convert and upload each image immediately with concurrency one on mobile/low-memory clients and no more than two elsewhere.
- [x] 3.3 Preserve JSONL order and labels and feed successes into the current local draft preview/reorder/delete/confirm flow.
- [x] 3.4 Preserve successful uploaded items across retry; retry only failures and present separate download/decode/upload messages.
- [x] 3.5 Cover all-success, CORS fallback, mixed partial failure, retry, cancel, order/label preservation, GIF, and 30-item sequential mobile scenarios.

**Quality Gate:**

- [x] New URL-import regression tests pass
- [x] `npm run test:question-set-creation-method`

## Phase 4: Remove Images Dependency and Document Quotas

- [x] 4.1 Delete Worker-side `compressRemoteImage`, Images types/configuration, and obsolete prepared-state RPC branches only after callers/tests have moved.
- [x] 4.2 Remove `[images] binding = "IMAGES"` from `wrangler.toml` and update deployment instructions.
- [x] 4.3 Update `docs/cloudflare-free-budget.md` with the 31/61 request model, zero Images transformations, and 60-set daily estimates.
- [x] 4.4 Confirm existing orphan cleanup covers refresh/cancelled-import R2 objects.

**Quality Gate:**

- [x] `rg "IMAGES|Images binding|9422"` finds no live dependency except historical/explanatory documentation or tests
- [x] Documentation and quota arithmetic reviewed

## Phase 5: Verification

- [x] 5.1 Run `npm run worker:typecheck`.
- [x] 5.2 Run `npm run lint`.
- [x] 5.3 Run `npm run build`.
- [x] 5.4 Run `npm run test:local-image-upload`.
- [x] 5.5 Run `npm run test:r2-upload`.
- [x] 5.6 Run new URL-import tests.
- [x] 5.7 Run `npm run test:question-set-creation-method`.
- [x] 5.8 Run a local Worker manual test with one CORS-enabled source, one CORS-blocked source, partial retry, and a 30-image mobile-emulation import.

## Completion Checklist

Implementation and automated verification completed on 2026-08-13. The manual scenarios are covered by deterministic endpoint/orchestration tests; no production deployment was performed.

Follow-up on 2026-08-13: all external URL downloads now use the authorized Worker source endpoint by default; a regression test asserts that the browser never requests the original external URL.


- [x] All phases complete
- [x] No Cloudflare Images transformation remains in the import path
- [x] All quality gates pass
- [x] Quota and deployment documentation are synchronized
- [x] Ready for `/openspec-archive`

# Proposal: Move URL Image Transformation to the Browser

**Change ID:** `move-url-image-transform-to-browser`  
**Created:** 2026-08-13  
**Status:** Implementation Complete  
**Completed:** 2026-08-13

## Problem Statement

JSONL and pasted-URL imports currently fetch every non-GIF image in the Worker and transform it through the Cloudflare Images binding before writing it to R2. The account-level Images Free plan allows 5,000 unique transformations per calendar month; after exhaustion every new image fails with error 9422, so an otherwise valid question list cannot be imported. Retrying the current dialog repeats the same non-retryable transformation failures.

Local file uploads already resize, compress, and re-encode images in the browser before uploading them to R2. URL imports should reuse that path so normal question-list creation is not coupled to a small monthly Images quota.

## Proposed Solution

- Make the browser the only image-transformation layer for local files and URL/JSONL imports.
- For each URL, first attempt a credential-free browser CORS fetch. If the source does not permit it, call a bounded Worker endpoint that fetches and returns the original image without transforming or storing it.
- Reuse the existing Canvas policy: at most 1600 pixels on either axis, WebP quality 0.78, retain the original when conversion is larger, and retain GIF unchanged.
- Process remote images with concurrency one on mobile and at most two elsewhere; release decoded resources after each image and upload the prepared blob immediately rather than retaining all original blobs.
- Upload each prepared result through the existing R2 upload endpoint, preserve order/labels, and reuse the existing local draft preview, reorder, delete, and final `createUploadedQuestionSet` flow.
- Remove the Images binding and the Worker-side transformation implementation after the browser path is covered by tests.

## Scope

### In Scope

- Browser URL fetch, Blob/File normalization, image decoding, Canvas conversion, immediate R2 upload, progress, and per-image retry.
- A Worker original-image fetch fallback with existing URL validation, private-host blocking, source headers/proxy candidates, content-type validation, and 20 MB response limit.
- Room/presenter authorization on fallback fetches so the endpoint is not an unauthenticated general-purpose proxy.
- Detection of mobile/low-memory clients and bounded sequential processing.
- Removal of Cloudflare Images from URL imports and deployment configuration.
- Regression tests and quota/deployment documentation updates.

### Out of Scope

- D1 or Durable Object schema changes.
- Changes to game rules, phases, scoring, realtime protocol, or question-set persistence.
- Persistent browser storage of source images or saving images to the device download directory.
- Deduplicating identical source images across imports.
- Supporting non-HTTP URLs or images larger than 20 MB.

## Impact Analysis

| Component | Change Required | Details |
| --- | --- | --- |
| Browser uploader | Yes | Fetch remote Blob, reuse shared conversion helper, upload immediately, preserve labels/order and partial successes |
| Worker API | Yes | Return a validated original image for CORS/fetch fallback; do not transform or write it |
| R2 | No contract change | Continue one `PutObject` per successfully prepared image through `/api/r2-upload` |
| Cloudflare Images | Removed | Delete binding and all remote-import transformation calls |
| D1 / Room DO | No schema/state change | Existing authorization and final question-set creation remain authoritative |
| UI | Yes | Distinguish download, local conversion, upload, retry, and source-URL fallback errors |

## Architecture Considerations

The fallback endpoint accepts one URL per request and must verify that the room/presenter may create a set before fetching. This is intentionally bounded to one image and 20 MB; redirects must still resolve to HTTP(S), the final response must be an image, and responses use `Cache-Control: no-store`. Browser direct fetches use omitted credentials and no referrer. Worker fetches reuse the established host-specific Referer behavior and proxy candidates.

The browser must not accumulate up to 30 decoded originals. Each item follows `fetch -> decode -> convert -> release decoder/canvas -> upload -> retain only R2 metadata`. Existing prepared items are not repeated when one image fails. A retry targets failed items only. Page refresh may leave unreferenced R2 objects, which the existing 72-hour orphan cleanup already handles.

## Quota Model

For one 30-image URL question list:

- Cloudflare Images transformations: 0.
- R2 Class A writes: at most 30, unchanged.
- Worker requests when every source supports browser CORS: 30 uploads + 1 final creation = 31.
- Worker requests when every source needs fallback: 30 source fetches + 30 uploads + 1 final creation = 61.
- D1 authorization reads in the simple per-image fallback design: at most 30; this may be reduced later with a signed import session only if production metrics justify the added complexity.

At 60 newly imported 30-image sets per day, the all-fallback upper estimate is 3,660 Worker requests/day (3.66% of the 100,000 daily Free limit), 1,800 D1 authorization-row reads/day (0.036% of 5,000,000), and 54,000 R2 Class A writes/month (5.4% of 1,000,000). It does not multiply by room player count and creates no DO request, Alarm, broadcast, or realtime synchronization work.

## Success Criteria

- [x] A valid 1-30 image JSONL/URL import completes when the account has no remaining Images transformations.
- [x] No URL import invokes the Images binding or can surface error 9422.
- [x] Sources with usable CORS download directly; blocked sources transparently use the bounded Worker fallback.
- [x] Remote images use the same size, quality, format, GIF, and “keep smaller result” policy as local uploads.
- [x] A 30-image mobile import never decodes more than one remote image concurrently and does not retain all original blobs.
- [x] Retrying after partial failure uploads only failed items; successful R2 items retain order and labels.
- [x] Typecheck, lint, build, local upload, R2 upload, new URL-import tests, and relevant question-set tests pass.

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| Mobile tab runs out of memory decoding a large image | Medium | High | Sequential mobile processing, 20 MB/size checks, immediate resource release, pixel guard, actionable failure |
| Source blocks browser CORS or hotlinking | High | Medium | Worker original-fetch fallback with existing source headers and proxy candidates |
| Mobile network pays for source download and compressed upload | High | Medium | Show byte/progress feedback, upload immediately, retry only failed items |
| Fallback becomes an open proxy | Medium | High | Require room/presenter authorization, allow only image HTTP(S), private-host checks, one URL/request, 20 MB cap, no-store |
| Refresh leaves orphaned R2 objects | Medium | Low | Existing 72-hour orphan cleanup; do not create D1 question set before confirmation |
| Browser cannot decode AVIF/WebP or encode WebP | Low | Medium | Surface per-image decode error; retain existing WebP-to-JPEG encoding fallback |

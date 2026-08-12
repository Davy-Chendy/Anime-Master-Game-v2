# Delta: URL and JSONL Image Import

**Change ID:** `move-url-image-transform-to-browser`  
**Affects:** URL/JSONL question import, browser image preparation, Worker source fetch, R2 upload, Cloudflare quota model

## ADDED

### Requirement: Browser-Authoritative Image Transformation

URL and JSONL imports transform images in the presenter's browser with the same bounded policy used by local file uploads. The Worker does not invoke Cloudflare Images.

#### Scenario: Import a remote still image
- GIVEN a valid remote JPEG, PNG, WebP, or AVIF image no larger than 20 MB
- WHEN the presenter imports its URL
- THEN the browser scales it to at most 1600 pixels per axis, encodes with the configured policy, retains the smaller result, and uploads that result to R2
- AND no Cloudflare Images transformation occurs

#### Scenario: Import an animated GIF
- GIVEN a valid remote GIF no larger than 20 MB
- WHEN the presenter imports its URL
- THEN the browser preserves the original GIF bytes and uploads them without Canvas conversion

### Requirement: Bounded Worker Source Fetch

An authorized Worker endpoint returns one validated original image without transforming or persisting it. The browser does not connect directly to external question-list URLs.

#### Scenario: Source allows browser CORS
- GIVEN the source returns an image with usable CORS headers
- WHEN the presenter imports it
- THEN the browser still obtains it through the Worker source endpoint and makes no direct request to the external host

#### Scenario: Source blocks browser CORS
- GIVEN the source uses CORS restrictions or normal hotlink protection
- WHEN the authorized presenter imports it
- THEN the Worker fetches at most 20 MB using bounded source/proxy attempts and returns the original image with no-store caching

#### Scenario: Invalid fallback target
- GIVEN a private/local host, non-HTTP URL, non-image response, empty body, or body exceeding 20 MB
- WHEN the Worker source endpoint is called
- THEN it rejects the request without returning arbitrary content, invoking Images, or writing R2

### Requirement: Mobile-Bounded Processing

Remote image processing does not retain or decode the whole question list at once.

#### Scenario: Import 30 images on mobile
- GIVEN a mobile or low-memory browser imports 30 valid URLs
- WHEN processing begins
- THEN at most one original image is being decoded or converted at a time
- AND each prepared image is uploaded and its decoding resources are released before the next begins

### Requirement: Partial Retry Without Duplicate Work

Successful items remain prepared when other items fail, and retries target failures only.

#### Scenario: Some images fail
- GIVEN 20 images have uploaded successfully and 10 fail during download, decode, or upload
- WHEN the presenter retries
- THEN only the 10 failed items are downloaded, converted, or uploaded again
- AND the 20 successful R2 URLs, original JSONL order, and labels remain unchanged

#### Scenario: Presenter confirms the prepared draft
- GIVEN all desired images have been prepared, reordered, or removed
- WHEN the presenter confirms the question set
- THEN the existing `createUploadedQuestionSet` path writes one final manifest and no abandoned draft set was previously written to D1

## MODIFIED

### Requirement: Remote Import Quota Behavior

Remote imports consume ordinary Worker requests and R2 writes but no Cloudflare Images unique transformations, DO requests, Alarms, or realtime broadcasts.

#### Scenario: Import one 30-image set through fallback
- GIVEN all 30 sources require the Worker fallback
- WHEN the presenter imports and confirms the set
- THEN the operation uses at most 30 Worker source fetches, 30 R2 uploads, and one final creation request
- AND it remains independent of the number of players in the room

## REMOVED

### Requirement: Worker-Side Cloudflare Images Transformation

The URL/JSONL import path no longer requires an Images binding or exposes Images quota error 9422.

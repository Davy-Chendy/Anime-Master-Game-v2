# Implementation Tasks: Add Public Rooms

**Change ID:** `add-public-rooms`

## Phase 1: Foundation

- [x] 1.1 Add public-room types and append-only D1 migration.
- [x] 1.2 Extend room creation, serialization, member-count projection, and prepared-source lifecycle.
- [x] 1.3 Add migration and service-level regression tests.

## Phase 2: Read Path

- [x] 2.1 Add compact read-only Room DO presence endpoint.
- [x] 2.2 Add bounded public-directory D1 query and active-room enrichment.
- [x] 2.3 Add timeout, approximate fallback, concurrency, and no-write tests.

## Phase 3: User Interface

- [x] 3.1 Add accessible public/private creation modal and optional name input.
- [x] 3.2 Add public-room route, status cards, counts, sources, refresh, and error states.
- [x] 3.3 Reuse the existing room-entry session and authoritative join flow.

## Phase 4: Documentation and Verification

- [x] 4.1 Update glossary, rules, README, testing, and Cloudflare budget documentation.
- [x] 4.2 Review the complete diff for correctness, concurrency, schema, recovery, and performance.
- [x] 4.3 Run all selected unit, authority, runtime, typecheck, lint, and build gates.

## Completion Checklist

- [x] All phases complete
- [x] All quality gates passed
- [x] Documentation synced
- [x] Ready for archive

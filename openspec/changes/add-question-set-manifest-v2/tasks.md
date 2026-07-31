# Implementation Tasks: Add Question Set Manifest V2

**Change ID:** `add-question-set-manifest-v2`

## Phase 1: Data Foundation

- [x] 1.1 Add append-only D1 manifest/index migration.
- [x] 1.2 Add manifest types, validation, encoding, and legacy fallback helpers.
- [x] 1.3 Create new sets as manifest-only rows with stable question IDs.
- [x] 1.4 Add migration, codec, and create/read compatibility tests.

## Phase 2: Authority Projection

- [x] 2.1 Track dirty question label IDs in backward-compatible authority aggregate JSON.
- [x] 2.2 Project legacy labels only when dirty.
- [x] 2.3 Add revision-CAS manifest merge with idempotent retries and conflict handling.
- [x] 2.4 Add no-op, multi-label, concurrent-room, duplicate, and recovery tests.

## Phase 3: Cleanup and Budget

- [x] 3.1 Read manifest images in expired-room, orphan-set, and R2 reference cleanup.
- [x] 3.2 Verify candidate/reference query plans and dual-format cleanup behavior.
- [x] 3.3 Update quota documentation and the 50-player x 30-question x 60-game budget model.

## Phase 4: Review and Verification

- [x] 4.1 Review the complete diff for data loss, concurrency, migration, retry, quota, and Workers-runtime risks.
- [x] 4.2 Fix all review findings before deployment testing.
- [x] 4.3 Apply D1 migrations locally and run the local Worker/runtime deployment test.
- [x] 4.4 Run required typecheck, lint, build, authority, archive, budget, and runtime tests.

## Completion Checklist

- [x] All phases complete
- [x] Code review has no unresolved findings
- [x] All quality gates passed
- [x] Documentation synced
- [x] Ready for archive

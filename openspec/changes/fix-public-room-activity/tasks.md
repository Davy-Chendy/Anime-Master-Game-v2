# Implementation Tasks: Fix Public Room Activity

**Change ID:** `fix-public-room-activity`

## Phase 1: Foundation

- [x] 1.1 Add the append-only D1 activity migration and data types.
- [x] 1.2 Record meaningful lobby/setup activity in existing room writes.
- [x] 1.3 Add migration and service regression tests.

## Phase 2: Authority and Directory

- [x] 2.1 Persist gameplay activity through existing authority checkpoints.
- [x] 2.2 Return gameplay activity from compact presence and filter the directory at one hour.
- [x] 2.3 Cover membership, phase progress, restore, fallback, and boundary behavior.

## Phase 3: Documentation and Verification

- [x] 3.1 Update the game rules, Cloudflare budget, and UI copy.
- [x] 3.2 Run all tests required by `docs/testing.md`.
- [x] 3.3 Review the complete diff for correctness, concurrency, migration, and quota regressions.

## Completion Checklist

- [x] All tasks complete.
- [x] Required tests pass.
- [x] Documentation is synchronized.
- [x] Ready for `openspec-archive` after deployment confirmation.

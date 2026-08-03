# Implementation Tasks: Aggregate Room State V4

**Change ID:** `aggregate-room-state-v4`

## Phase 1: Data Foundation

- [x] 1.1 Add append-only D1 room-state migration and generation 4 constant.
- [x] 1.2 Add strict room-state codec and domain types.
- [x] 1.3 Add migration and codec tests.

## Phase 2: Room Lifecycle

- [x] 2.1 Create and read generation 4 rooms without normalized player rows.
- [x] 2.2 Convert join, leave, kick, role, team, and settings mutations to the aggregate row.
- [x] 2.3 Convert game bootstrap and player lookup paths to aggregate reads.
- [x] 2.4 Add no-op, capacity, nickname, host-transfer, and concurrent mutation tests.

## Phase 3: Projection and Cutover

- [x] 3.1 Project room and roster in one D1 update without player reconciliation.
- [x] 3.2 Retire generation 3 HTTP, WebSocket, and Alarm paths.
- [x] 3.3 Update quota documentation and budget model.
- [x] 3.4 Add projection, retry, stale-room, and local-runtime tests.

## Phase 4: Review and Verification

- [x] 4.1 Review the complete diff for data loss, concurrency, stale Alarm, retry, and quota risks.
- [x] 4.2 Fix every review finding.
- [x] 4.3 Apply all D1 migrations locally and run the local Worker/runtime deployment test.
- [x] 4.4 Run required typecheck, lint, build, authority, archive, budget, cutover, and runtime tests.

## Completion Checklist

- [x] All phases complete
- [x] All quality gates passed
- [x] Documentation synced
- [x] Ready for archive

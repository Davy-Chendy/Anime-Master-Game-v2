# Implementation Tasks: Add Manual Team Assignment

**Change ID:** `add-manual-team-assignment`

## Phase 1: Foundation

- [x] 1.1 Add shared room team-assignment types and normalization.
- [x] 1.2 Add append-only D1 and Room DO migrations.
- [x] 1.3 Add migration upgrade and failure tests.

## Phase 2: Authority and Protocol

- [x] 2.1 Add room settings and player team mutations.
- [x] 2.2 Enforce authoritative start validation and handoff to TeamBattleState.
- [x] 2.3 Handle role, presenter, leave, kick and mid-game join transitions.
- [x] 2.4 Add realtime and state-machine regression coverage.

## Phase 3: User Interface

- [x] 3.1 Add host automatic/manual selection.
- [x] 3.2 Add team controls, marks, stable sorting and start blockers.
- [x] 3.3 Add atomic team choice for new players and spectator-to-player transitions.

## Phase 4: Verification

- [x] 4.1 Update game rules and budget documentation.
- [x] 4.2 Run all required typecheck, lint, build, authority and runtime tests.
- [x] 4.3 Review the complete diff for correctness, concurrency, recovery and performance.

## Completion Checklist

- [x] All phases complete
- [x] All quality gates passed
- [x] Documentation synced
- [x] Ready for archive

# Implementation Tasks: Add Spectator Visibility Controls

**Change ID:** `add-spectator-visibility-controls`

## Phase 1: Foundation

- [x] 1.1 Add shared room setting types and defaults.
- [x] 1.2 Add append-only D1 and Room DO migrations.
- [x] 1.3 Extend the existing room settings mutation and persistence mapping.

## Phase 2: Authority and Protocol

- [x] 2.1 Filter live answer text delivery for restricted spectators.
- [x] 2.2 Project bootstrap and round snapshots by spectator permission.
- [x] 2.3 Reuse existing deltas to reveal labels and answer text at review.

## Phase 3: User Interface

- [x] 3.1 Add two concise host-controlled lobby switches.
- [x] 3.2 Gate spectator original preview, correct answer and answer text UI.
- [x] 3.3 Reset open spoiler UI when permission or question changes.

## Phase 4: Verification

- [x] 4.1 Update game rules and Cloudflare budget documentation.
- [x] 4.2 Add migration, realtime, reconnect and mode regression tests.
- [x] 4.3 Run required tests, typecheck, lint and build.
- [x] 4.4 Review the complete diff for correctness, concurrency and performance.

## Completion Checklist

- [x] All phases complete
- [x] All quality gates passed
- [x] Documentation synced
- [x] Ready for archive

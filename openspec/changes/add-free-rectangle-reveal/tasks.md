# Implementation Tasks: Add Free Rectangle Reveal

**Change ID:** `add-free-rectangle-reveal`

## Phase 1: Contract and Foundation

- [x] 1.1 Update the game rules contract and shared reveal types.
- [x] 1.2 Add normalized rectangle geometry utilities and unit tests.
- [x] 1.3 Add append-only D1 migration and compatibility mappings.

## Phase 2: Settings and Authority

- [x] 2.1 Add the host-controlled lobby setting and freeze it at game start.
- [x] 2.2 Add the idempotent Room DO `confirmRevealRegions` mutation.
- [x] 2.3 Update review, reset, recovery and final projection helpers.

## Phase 3: User Interface

- [x] 3.1 Add the free rectangle editor with locked historical regions.
- [x] 3.2 Add rectangle player rendering and V-key preview.
- [x] 3.3 Keep copy concise and verify mouse, touch and keyboard behavior.

## Phase 4: Verification

- [x] 4.1 Add migration, protocol, multiplayer, retry and recovery regressions.
- [x] 4.2 Update the Cloudflare budget documentation and payload assertions.
- [x] 4.3 Run all required quality gates and complete code review.

## Completion Checklist

- [x] All phases complete
- [x] All quality gates passed
- [x] Documentation synced
- [x] Ready for `/openspec-archive`

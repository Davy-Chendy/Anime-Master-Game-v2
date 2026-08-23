# Implementation Tasks: Add Presenter Early Round End

**Change ID:** `add-presenter-early-round-end`

## Phase 1: Contract and Authority

- [x] 1.1 Update the game rules, authority design and shared session contract.
- [x] 1.2 Add the presenter-only early-end mutation and shared personal-round close logic.
- [x] 1.3 Lock submissions against the authoritative deadline and preserve restore compatibility.

**Quality Gate:** PASSED — authority tests, Worker typecheck and frontend typecheck.

## Phase 2: Protocol and User Interface

- [x] 2.1 Register the mutation through the realtime protocol and client API.
- [x] 2.2 Replace the disabled settle action with a confirmed early-end action while the timer is open.
- [x] 2.3 Display the authoritative early-end reason for all roles and affected players.

**Quality Gate:** PASSED — protocol/Outbox regression and production build.

## Phase 3: Verification

- [x] 3.1 Add authority tests for roles, modes, pending answers, late actions, duplicate/stale actions and Alarm races.
- [x] 3.2 Add full-game/state-machine and checkpoint/recovery coverage.
- [x] 3.3 Update the Cloudflare budget documentation and run all required quality gates.
- [x] 3.4 Complete a detailed diff and full-file code review, fix findings and rerun verification.

**Review findings fixed:** committed duplicate response contract, matching authoritative deadline validation, all-acted rejection, and early-end metadata cleanup on game end.

**Quality Gate:** PASSED — 10-player full game, 200-seed state machine, 50×30 budget, and local workerd/WebSocket stress with restart/reconnect recovery.

## Completion Checklist

- [x] All phases complete
- [x] All quality gates passed
- [x] Documentation synced
- [x] Ready for `/openspec-archive`

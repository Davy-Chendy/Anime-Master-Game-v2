# Proposal: Fix Public Room Activity

**Change ID:** `fix-public-room-activity`
**Created:** 2026-08-10
**Status:** Implementation Complete
**Completed:** 2026-08-10

## Problem Statement

The public-room directory currently treats D1 room updates and Room Durable Object checkpoints as activity. Membership churn can therefore keep an abandoned lobby, active game, or result room visible indefinitely even when the host or presenter is no longer advancing the game.

## Proposed Solution

- Add a dedicated D1 `public_activity_at` value for lobby and setup activity.
- Add `lastPublicActivityAtMs` to the existing authority vNext aggregate and persist it through existing checkpoints.
- Refresh activity only for host/presenter setup actions and authoritative gameplay progress, never for ordinary membership changes, reconnects, or persistence-only checkpoints.
- Increase the directory visibility window from 30 minutes to 1 hour.

## Scope

### In Scope

- Public-room directory filtering and displayed activity time.
- Additive D1 migration and authority aggregate compatibility.
- Existing final room projection, compact presence response, tests, rules, and budget documentation.

### Out of Scope

- Heartbeats, automatic directory polling, a global directory Durable Object, or phase-level D1 writes.
- Filling a filtered page by automatically querying additional pages.
- Changes to scoring, timers, membership, or room ownership rules.

## Impact Analysis

| Component | Change Required | Details |
| --- | --- | --- |
| Database | Yes | Add nullable `public_activity_at` and backfill current public rooms |
| API | Compatible | Existing `updatedAt` response field now carries dedicated public activity |
| State | Yes | Store the last meaningful activity in the existing vNext aggregate JSON |
| UI | Minimal | Update the one-hour explanatory copy |

## Architecture Considerations

Room DO remains authoritative for active-game progress. The new timestamp piggybacks existing checkpoints and final projections, so runtime D1/DO statement counts do not increase. Lobby/setup activity remains a D1 catalog concern and does not add Room DO reads.

## Success Criteria

- [x] Ordinary joins, leaves, reconnects, role changes, and persistence-only checkpoints do not renew public activity.
- [x] Authoritative phase progress, game start/result, and meaningful lobby/setup control actions renew public activity.
- [x] Rooms remain visible for one hour after meaningful activity and are hidden afterwards.
- [x] Runtime Worker, D1, DO, Alarm, checkpoint, and broadcast counts remain unchanged.

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| Old aggregates lack the new value | High | Low | Restore from the existing checkpoint time once, then persist normally |
| Membership-driven team repair looks like progress | Medium | Medium | Explicitly exclude membership mutations from activity renewal |
| Stale active candidates shrink a page after DO filtering | Low | Low | Preserve the existing bounded behavior and avoid automatic read amplification |
| Migration consumes daily writes | Low | Low | Backfill only existing public rooms and add no activity index |

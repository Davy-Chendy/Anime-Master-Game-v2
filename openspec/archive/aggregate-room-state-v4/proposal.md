# Proposal: Aggregate Room State V4

**Change ID:** `aggregate-room-state-v4`  
**Created:** 2026-08-01  
**Status:** Implementation Complete

## Problem Statement

Production data from 2026-07-30 attributed 969 D1 rowsWritten to player UPSERT/delete/final roster projection and another 325 rowsWritten to room settings/final projection. After Question Set Manifest V2, room and player persistence becomes the largest remaining D1 write source. The normalized `players` table also caused 4,512 rowsRead during final roster reconciliation and repeated nickname unique-index projection failures.

## Proposed Solution

- Hard-cut all newly created rooms to runtime generation 4 during a maintenance window.
- Store the bounded room roster inside the existing `rooms` row as a versioned JSON document with a revision counter.
- Keep room lifecycle and lobby scalar columns in the same `rooms` row so indexed routing/reference queries remain efficient.
- Stop writing normalized `players` rows for generation 4 rooms.
- Persist roster and room final projection in one D1 room update.
- Expire generation 3 HTTP, WebSocket, and Alarm activity immediately; users create a new room.

## Scope

### In Scope

- Append-only D1 migration for room-state version, revision, and JSON.
- Versioned room-state codec with strict validation and bounded roster size.
- Generation 4 room creation, lifecycle, reads, game bootstrap, and final projection.
- No-op suppression for semantically identical rejoin and lobby changes.
- Old generation DO retirement and client-visible room-expired behavior.
- Migration, concurrency, multiplayer, projection, quota, and local runtime tests.

### Out of Scope

- Backfilling or preserving active generation 3 rooms.
- Dropping the legacy `players` table in the same deployment.
- Aggregating game participants, question eligibility, or result archives.
- Moving lobby persistence into an additional Durable Object table.
- Changing game rules or public Room/Player API contracts.

## Impact Analysis

| Component | Change Required | Details |
| --- | --- | --- |
| D1 | Yes | Add room state fields; new rooms use one aggregate row |
| Worker data layer | Yes | Decode roster from `rooms.room_state_json` and stop player table writes |
| Room DO | Yes | Reject generation 3 requests, sockets, and alarms after hard cut |
| Final projection | Yes | Merge room lifecycle and roster into one update |
| UI | No | Existing room-expired handling and public contracts remain |

## Success Criteria

- [x] New room creation writes one `rooms` data row and no `players` rows.
- [x] Generation 4 room lifecycle behavior matches current public contracts.
- [x] Final projection performs no normalized player DELETE/UPSERT.
- [x] Duplicate/no-op mutations do not rewrite room state.
- [x] Generation 3 requests, sockets, and alarms retire without retry loops.
- [x] Under the 2026-07-30 workload model, player-derived writes fall from 969 to at most 220 rows.
- [x] Local migration, Worker runtime, multiplayer, recovery, and quota tests pass.

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| Corrupt aggregate silently empties roster | Low | High | Strict versioned decoder; fail closed |
| Concurrent roster update loses a player | Low | High | Per-room DO serialization plus revision-guarded writes |
| Old DO Alarm continues after hard cut | Medium | High | Generation check before restore; delete Alarm and expire sockets |
| Final projection overwrites newer room state | Low | High | Same Room DO queue and one atomic room update |
| Unbounded JSON increases CPU/payload | Low | Medium | 50-player and byte-size hard limits |

---

## Archive Information

**Archived:** 2026-08-01 03:33  
**Duration:** 0 days  
**Outcome:** Successfully implemented

### Files Modified

- `d1/migrations/0018_room_state_manifest.sql`
- `worker/roomStateManifest.ts`
- `worker/gameService.ts`
- `worker/roomAuthorityVNext.ts`
- `worker/index.ts`
- `worker/roomRuntimeV3.ts`
- `tests/*room*` and authority/runtime budget tests
- `docs/cloudflare-free-budget.md`

### Specs Updated

- `openspec/specs/room_state_storage.md`

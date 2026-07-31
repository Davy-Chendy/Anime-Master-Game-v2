# Proposal: Add Question Set Manifest V2

**Change ID:** `add-question-set-manifest-v2`  
**Created:** 2026-07-31  
**Status:** Implementation Complete  
**Completed:** 2026-07-31

## Problem Statement

Question sets currently store one D1 row per question and project every question label at game end even when no label changed. The 2026-07-30 production window attributed 796 D1 rowsWritten to question creation and 810 to unconditional label projection, together accounting for 42.3% of D1 writes. The daily orphan private-set query also read 65,062 rows because its candidate and room-reference predicates lack matching indexes.

## Proposed Solution

- Store all questions for each new set in one bounded, versioned `question_sets.manifest_json` row while retaining catalog metadata as relational columns.
- Keep legacy question sets readable from `questions`; do not backfill existing rows.
- Track only changed question labels in Room Authority and persist manifest labels with revision-based optimistic concurrency.
- Replace public catalog indexes with partial public-only indexes and add focused private-cleanup/reference indexes.
- Keep the external `QuestionSet`/`Question[]` contract and game rules unchanged.

## Scope

### In Scope

- Append-only D1 migration for manifest columns and indexes.
- Manifest codec, new-write/legacy-read storage routing, stable question IDs, and cleanup compatibility.
- Dirty-label projection, idempotent retries, concurrent manifest merge, and legacy fallback.
- Migration, multiplayer, retry/recovery, cleanup, quota, and local-runtime tests.
- Cloudflare budget documentation and budget-model updates.

### Out of Scope

- Player or lobby row aggregation.
- Moving question manifests to R2.
- Backfilling or deleting legacy `questions` rows.
- Changing WebSocket payloads, UI behavior, scoring, phases, or answer-label semantics.
- Durable Object SQLite table, column, or index changes.

## Impact Analysis

| Component | Change Required | Details |
| --- | --- | --- |
| D1 | Yes | Add manifest/revision columns; rebuild catalog indexes as partial; add cleanup indexes |
| Worker data layer | Yes | Decode manifest or fall back to normalized questions |
| Room Authority | Yes | Persist dirty label IDs in aggregate JSON and merge them once at projection |
| Cleanup/R2 | Yes | Extract image references from both storage formats |
| API/UI | No | Preserve existing domain and realtime contracts |
| Game rules | No | Existing label validation and first-write semantics remain authoritative |

## Success Criteria

- [x] New question sets write one D1 data row and no `questions` rows.
- [x] Legacy and manifest question sets produce equivalent domain objects across detail, start, recovery, community, and result paths.
- [x] A game with no label changes performs no question-label D1 write.
- [x] Multiple dirty labels in one manifest set require at most one successful manifest row update.
- [x] Concurrent rooms merge different labels without lost updates and never silently overwrite conflicting existing labels.
- [x] Cleanup handles both formats and the orphan query uses its candidate and room-reference indexes.
- [x] The measured 2026-07-30 model falls from 3,795 to approximately 2,150-2,350 D1 rowsWritten.

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| Whole-manifest lost update | Medium | High | Dedicated revision CAS with bounded reread/merge retries |
| Old active game lacks dirty metadata | Medium | High | Optional aggregate field with restore normalization and conservative derivation |
| Cleanup misses manifest images | Medium | High | Shared manifest decoder plus dual-format cleanup tests |
| Rollback cannot read new rows | Medium | High | Deploy manifest-capable reader before enabling manifest-only writes |
| Index rebuild consumes daily writes | Low | Medium | Verify production row counts and migration plan before remote deployment |

# Proposal: Add Public Rooms

**Change ID:** `add-public-rooms`
**Created:** 2026-08-09
**Status:** Implementation Complete
**Completed:** 2026-08-09

## Problem Statement

Rooms can currently only be discovered by sharing a six-digit code, which works for private play but prevents players from browsing open games. Players need an optional public room type with a compact, manually refreshed directory while private-room behavior and all in-room game rules remain unchanged.

## Proposed Solution

- Add immutable public/private visibility and an optional public room name. Blank public names are stored as `{host nickname}的房间`.
- Add a manually refreshed public-room page backed by one bounded D1 directory query.
- Reuse existing Room DO entry rules for all joins.
- Store ordinary roster counts in the existing D1 room row without extra statements; enrich `PLAYING` and `GAME_RESULT` counts through a compact read-only Room DO endpoint.
- Freeze the displayed question source when a question set is prepared as community, creation-tool, or manual.

## Scope

### In Scope

- Creation modal, visibility choice, optional public name, and public-room browser.
- Status, game mode, bounded member count, and prepared question-source display.
- Additive D1 migration, compact Room DO presence reads, concurrency/timeout fallback, tests, rules, and budget documentation.

### Out of Scope

- Changing visibility or room name after creation.
- Automatic directory polling or a global directory Durable Object.
- Any change to scoring, timers, rounds, teams, answer visibility, or settlement semantics.

## Impact Analysis

| Component | Change Required | Details |
| --- | --- | --- |
| Database | Yes | Add visibility, name, member count, prepared source, and a partial public-room index |
| API | Yes | Extend room creation and add a bounded GET directory endpoint plus internal DO presence read |
| State | Yes | Piggyback lobby/final member counts and freeze/clear prepared source |
| UI | Yes | Add creation modal, browser route, cards, refresh, and existing-entry handoff |

## Architecture Considerations

Room DO remains authoritative for membership and joining. D1 is the public catalog snapshot. The browser performs one initial read and explicit refreshes only. Only rooms whose D1 state can lag during active play receive a compact read-only DO request; failures fall back to the stored count and never block the whole list.

## Success Criteria

- [ ] Historical and default rooms remain private and existing create calls remain compatible.
- [ ] Public rooms are discoverable with correct metadata and optional-name fallback.
- [ ] Active-room counts are enriched without D1/DO writes, checkpoint, Alarm, broadcast, or full snapshot construction.
- [ ] Joining from the directory follows the existing authoritative role/team/capacity flow.
- [ ] Required multiplayer, migration, budget, lint, typecheck, build, and runtime tests pass.

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| Active count read times out | Medium | Low | Bounded timeout, all-settled response, approximate D1 fallback |
| Directory causes read amplification | Low | Medium | Manual refresh only, capped candidates/results, active-state enrichment only, bounded concurrency |
| New metadata is lost at handoff | Low | Medium | Add regression coverage for start, result, cancel, and return-to-lobby projections |
| Migration breaks existing rooms | Low | High | Additive defaults, production-previous migration fixture, idempotent migration tests |

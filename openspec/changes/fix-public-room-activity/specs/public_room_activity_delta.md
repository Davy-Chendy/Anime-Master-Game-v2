# Delta: Public Room Activity

**Change ID:** `fix-public-room-activity`
**Affects:** public room catalog, room lifecycle activity, authority checkpoints, final projection

## ADDED

### Requirement: Meaningful Public Activity

Public activity represents room organization or authoritative gameplay progress. Persistence events and ordinary membership traffic do not count as activity.

#### Scenario: Membership churn
- GIVEN a public room whose host or presenter stops advancing it
- WHEN ordinary players repeatedly join, leave, reconnect, change role, or select teams
- THEN its public activity time remains unchanged and it is hidden one hour after the last meaningful activity

#### Scenario: Gameplay progress
- GIVEN a public game is visible
- WHEN the Room DO authoritatively changes round, question, gameplay phase, or result status
- THEN the existing checkpoint persists the transition time as public activity without an additional write

#### Scenario: Persistence-only checkpoint
- GIVEN a public game remains in the same gameplay phase
- WHEN it checkpoints for action count, event age, attachment budget, connection close, replay, or membership repair
- THEN public activity remains unchanged

## MODIFIED

### Requirement: Manually Refreshed Public Catalog

The public-room catalog displays rooms with meaningful activity during the previous hour. Lobby and setup states use the dedicated D1 activity projection; playing and result states use the compact Room DO activity value with D1 fallback.

#### Scenario: Two-hour boundary
- GIVEN the directory is loaded at a known time
- WHEN a room last made meaningful progress no more than one hour ago
- THEN it remains visible
- AND when its activity is older than one hour it is hidden

## REMOVED

(None)

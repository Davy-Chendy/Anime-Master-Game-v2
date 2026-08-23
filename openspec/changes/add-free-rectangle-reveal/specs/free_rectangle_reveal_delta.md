# Delta: Free Rectangle Reveal

**Change ID:** `add-free-rectangle-reveal`  
**Affects:** room settings, personal reveal authority, realtime snapshots, game UI

## ADDED

### Requirement: Optional personal free reveal

The host can enable free rectangle reveal in advanced settings while the room is in `LOBBY` or `QUESTION_SETUP`. Existing and new rooms default to grid reveal, and team battle always uses its existing grid flow.

#### Scenario: Freeze the setting at game start
- GIVEN a personal-mode room has free reveal enabled
- WHEN the host starts a game
- THEN the game session uses free rectangle reveal for the whole game
- AND later lobby state cannot change that active session

### Requirement: Authoritative rectangle commitment

The presenter may commit one to sixteen normalized rectangles before a personal round. Room DO validates and atomically appends regions, starts the existing round deadline, checkpoints the phase boundary and broadcasts the resulting state.

#### Scenario: Commit a free reveal round
- GIVEN a free-reveal personal question is waiting for the presenter
- WHEN the presenter commits valid regions that add visible area
- THEN those regions become immutable historical regions
- AND the existing answer round begins once

#### Scenario: Reject stale or redundant submission
- GIVEN a duplicate, old-question, active-round or fully redundant region submission
- WHEN Room DO processes it
- THEN it cannot append regions or advance the phase twice

### Requirement: Consistent rectangle projection

Player rendering, presenter preview, bootstrap, reconnect and recovery use the same normalized committed region state. Presenter drafts remain local until confirmation.

#### Scenario: Reconnect after confirmation
- GIVEN a rectangle round was committed and checkpointed
- WHEN any role reconnects
- THEN its projected image and public phase converge without an HTTP polling path

## MODIFIED

### Requirement: Personal reveal selection

Grid reveal remains the default. When free reveal is enabled, references to selecting unopened cells instead mean committing at least one region that adds previously hidden image area. All other personal-mode behavior is unchanged.

## REMOVED

(None)

# Delta: Spectator Visibility

**Change ID:** `add-spectator-visibility-controls`  
**Affects:** room settings, game realtime projection, spectator UI

## ADDED

### Requirement: Independent spectator visibility controls

The host can independently allow early question preview and player-answer text while the room is in `LOBBY` or `QUESTION_SETUP`.

#### Scenario: Restrict early question preview
- GIVEN early question preview is disabled
- WHEN a spectator watches an active question before review
- THEN the spectator cannot open the original image or correct answer through the game UI
- AND review reveals both normally

#### Scenario: Restrict player answer text
- GIVEN spectator player answers are disabled
- WHEN an answer arrives or the spectator reconnects before review
- THEN the spectator receives public answer progress without answer text
- AND review provides the answer text through the existing realtime channel

#### Scenario: Preserve current defaults
- GIVEN an existing room is upgraded
- WHEN its settings are loaded
- THEN both spectator controls are enabled

## MODIFIED

### Requirement: Qualified answer-text recipients

Spectators are qualified answer-text recipients before review only when the room enables spectator player answers. Presenter, owner and already-correct player permissions remain unchanged.

## REMOVED

(None)

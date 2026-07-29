# Delta: Team Assignment

**Change ID:** `add-manual-team-assignment`  
**Affects:** room lobby, membership, team battle start, realtime protocol

## ADDED

### Requirement: Manual Team Assignment

New rooms default to manual assignment, and the host can switch team battle rooms between automatic and manual assignment. In manual mode each non-spectator, non-presenter player selects red or blue.

#### Scenario: Join before play
- GIVEN a manual team room is in `LOBBY` or `QUESTION_SETUP`
- WHEN a new player joins the room
- THEN the player enters the lobby unassigned and selects red or blue from the player list

#### Scenario: Free switching before play
- GIVEN a room is in `LOBBY` or `QUESTION_SETUP` with manual assignment enabled
- WHEN an eligible player selects red or blue
- THEN the Room DO records the latest team and broadcasts the new room state

#### Scenario: Presenter exemption
- GIVEN an assigned player is selected as presenter
- WHEN the presenter setup begins
- THEN the presenter is removed from manual teams and is not considered unassigned

#### Scenario: Start validation
- GIVEN the question set is ready in manual team mode
- WHEN the host starts the game
- THEN the server starts only if both teams are non-empty and every non-spectator, non-presenter player is assigned

#### Scenario: Switching to automatic
- GIVEN manual assignments exist
- WHEN the host selects automatic assignment
- THEN all manual assignments are cleared and do not reappear after switching back

#### Scenario: Mid-game join
- GIVEN a manual team battle is already playing
- WHEN a new member joins as a player and selects a team
- THEN the selected team is persisted atomically, the member watches the current question, and joins that team on the next question

## MODIFIED

### Requirement: Team Battle Initialization

Automatic mode retains random balanced assignment. Manual mode initializes `TeamBattleState` from the authoritative room assignments without rebalancing.

## REMOVED

(None)

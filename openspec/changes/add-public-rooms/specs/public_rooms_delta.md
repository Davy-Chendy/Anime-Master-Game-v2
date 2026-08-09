# Delta: Public Rooms

**Change ID:** `add-public-rooms`
**Affects:** room creation, room catalog reads, membership summary, question-set preparation, room entry

## ADDED

### Requirement: Room Visibility and Name

Rooms are created as immutable private or public rooms. A public room stores the supplied trimmed name, or `{host nickname}的房间` when the name is blank.

#### Scenario: Default compatibility
- GIVEN an existing client omits room options
- WHEN it creates a room
- THEN the room is private and does not appear in the public catalog

#### Scenario: Blank public name
- GIVEN a host named 小明 selects a public room and leaves the name blank
- WHEN creation commits
- THEN the stored room name is `小明的房间`

### Requirement: Manually Refreshed Public Catalog

The public-room page loads once on entry and reloads only after an explicit player refresh. It returns a bounded list of current-generation public rooms with name, status, mode, count, and prepared source.

#### Scenario: Private room exclusion
- GIVEN public and private rooms coexist
- WHEN the catalog is loaded
- THEN only public generation-4 rooms are returned

#### Scenario: Active count enrichment
- GIVEN a listed room is playing and its D1 count is stale
- WHEN the catalog is loaded
- THEN the Worker reads a compact Room DO presence summary and returns the authoritative count

#### Scenario: Presence failure
- GIVEN one active Room DO read times out
- WHEN the catalog is loaded
- THEN the other rooms still return and that room uses an approximate D1 count

### Requirement: Prepared Question Source

Preparing a question set freezes its displayed source as community, creation-tool, or manual until the room returns to the lobby or the round is cancelled.

#### Scenario: Publish during play
- GIVEN a private manual set was prepared and the game started
- WHEN its owner publishes it to the community
- THEN the public room source remains manual for that game

## MODIFIED

### Requirement: Room Entry

Entering from the public catalog saves the target room in the local session and delegates membership, capacity, role, and team selection to the existing Room DO flow.

## REMOVED

(None)

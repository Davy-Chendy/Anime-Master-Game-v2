# Room State Storage Specification

## Requirements

### Versioned Single-Row Room State

Every generation 4 room stores its complete bounded roster in its existing D1 `rooms` row and stores no normalized player rows.

#### Scenario: Create a room
- GIVEN a player creates a room after the generation 4 deployment
- WHEN room creation commits
- THEN the room row contains a valid versioned roster with the host
- AND no `players` row is inserted

#### Scenario: Read a room
- GIVEN a valid generation 4 room state
- WHEN any room, roster, bootstrap, or player lookup path reads it
- THEN it returns the unchanged public Room and Player contracts from one room document

#### Scenario: Reject corrupt state
- GIVEN a generation 4 room with invalid state JSON, version, duplicate identity, duplicate nickname, or excessive size
- WHEN the state is read
- THEN the Worker fails closed with a structured storage error
- AND never treats the room as empty

### Atomic Room Mutation

Membership/roster changes use revision protection; lobby scalar changes share the same physical room row. All room mutations are serialized by the Room DO and suppress semantic no-ops.

#### Scenario: Duplicate rejoin
- GIVEN a player already has the same nickname, role, and team
- WHEN the player rejoins
- THEN the existing room is returned without a D1 write

#### Scenario: Concurrent membership changes
- GIVEN two membership intents for one room
- WHEN they are processed through the room coordinator
- THEN both are serialized and no roster update is lost

### Aggregate Final Projection

Generation 4 final projection persists room lifecycle and roster state in one room update.

#### Scenario: Finish a game
- GIVEN a generation 4 game reaches final projection
- WHEN the projection outbox flushes
- THEN it updates the room row once
- AND performs no normalized player DELETE or UPSERT

### Maintenance-Window Hard Cut

Generation 3 rooms are expired immediately after generation 4 deployment.

#### Scenario: Access an old room
- GIVEN a generation 3 room or Durable Object exists
- WHEN it receives HTTP, WebSocket, or Alarm activity after deployment
- THEN it returns or emits the existing room-expired contract
- AND cancels old business Alarms without retrying or projecting

### Player Identity Scope

Player identity is scoped to a room aggregate; the same browser player ID may exist in different rooms without a global directory write.

#### Scenario: Join separate rooms
- GIVEN the same local player ID is used in two current rooms
- WHEN each room validates its own roster
- THEN each room manages that identity independently

## Deprecated

### Normalized generation 4 player persistence (Removed: 2026-08-01)

Generation 4 no longer writes the normalized `players` table.

### Generation 3 active-room compatibility (Removed: 2026-08-01)

The maintenance-window hard cut intentionally expires active generation 3 rooms instead of preserving compatibility.

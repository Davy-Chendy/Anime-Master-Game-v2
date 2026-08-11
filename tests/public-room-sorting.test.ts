import assert from "node:assert/strict";
import test from "node:test";

import { sortPublicRooms } from "../src/lib/publicRoomSorting";
import type { GameMode, PublicRoomSummary, RoomQuestionSource, RoomStatus } from "../src/types/game";

function room(
  id: string,
  status: RoomStatus,
  playerCount: number,
  gameMode: GameMode,
  questionSource: RoomQuestionSource | null,
  updatedAt: string,
  name = id,
): PublicRoomSummary {
  return { id, code: id, name, status, playerCount, spectatorCount: 0, gameMode, questionSource, updatedAt, playerCapacity: 50, spectatorCapacity: 50, isCountApproximate: false, createdAt: updatedAt };
}

const rooms = [
  room("lobby", "LOBBY", 5, "BUZZER_RANKED", null, "2026-08-09T03:00:00Z"),
  room("playing-old", "PLAYING", 2, "TEAM_BATTLE", "MANUAL", "2026-08-09T01:00:00Z"),
  room("playing-new", "PLAYING", 8, "ROUND_REVEAL", "COMMUNITY", "2026-08-09T04:00:00Z"),
  room("setup-ready", "QUESTION_SETUP", 3, "BUZZER_FIRST_CORRECT", "CREATION_TOOL", "2026-08-09T02:00:00Z"),
  room("setup-preparing", "QUESTION_SETUP", 4, "ROUND_REVEAL", null, "2026-08-09T02:30:00Z"),
  room("result", "GAME_RESULT", 1, "ROUND_REVEAL", "MANUAL", "2026-08-09T05:00:00Z"),
];

test("public room client sorting supports activity, status, and people without mutating input", () => {
  assert.deepEqual(sortPublicRooms(rooms, "activity").map(({ id }) => id), ["result", "playing-new", "lobby", "setup-preparing", "setup-ready", "playing-old"]);
  assert.deepEqual(sortPublicRooms(rooms, "status").map(({ id }) => id), ["playing-new", "playing-old", "setup-ready", "setup-preparing", "lobby", "result"]);
  assert.deepEqual(sortPublicRooms(rooms, "people").map(({ id }) => id), ["playing-new", "lobby", "setup-preparing", "setup-ready", "playing-old", "result"]);
  assert.equal(rooms[0].id, "lobby");
});

test("public room client sorting groups official modes and question sources with activity tie-breaking", () => {
  assert.deepEqual(sortPublicRooms(rooms, "mode").map(({ id }) => id), ["result", "playing-new", "setup-preparing", "setup-ready", "lobby", "playing-old"]);
  assert.deepEqual(sortPublicRooms(rooms, "source").map(({ id }) => id), ["playing-new", "setup-ready", "result", "playing-old", "lobby", "setup-preparing"]);
});

test("every public room column supports both sorting directions", () => {
  const namedRooms = [
    room("z", "LOBBY", 1, "ROUND_REVEAL", null, "2026-08-09T01:00:00Z", "最后的房间"),
    room("a", "PLAYING", 3, "TEAM_BATTLE", "MANUAL", "2026-08-09T03:00:00Z", "阿明的房间"),
    room("b", "QUESTION_SETUP", 2, "BUZZER_FIRST_CORRECT", "COMMUNITY", "2026-08-09T02:00:00Z", "白熊房间"),
  ];

  assert.deepEqual(sortPublicRooms(namedRooms, "name", "asc").map(({ id }) => id), ["a", "b", "z"]);
  assert.deepEqual(sortPublicRooms(namedRooms, "name", "desc").map(({ id }) => id), ["z", "b", "a"]);
  assert.deepEqual(sortPublicRooms(namedRooms, "status", "asc").map(({ id }) => id), ["a", "b", "z"]);
  assert.deepEqual(sortPublicRooms(namedRooms, "status", "desc").map(({ id }) => id), ["z", "b", "a"]);
  assert.deepEqual(sortPublicRooms(namedRooms, "mode", "asc").map(({ id }) => id), ["z", "b", "a"]);
  assert.deepEqual(sortPublicRooms(namedRooms, "mode", "desc").map(({ id }) => id), ["a", "b", "z"]);
  assert.deepEqual(sortPublicRooms(namedRooms, "people", "asc").map(({ id }) => id), ["z", "b", "a"]);
  assert.deepEqual(sortPublicRooms(namedRooms, "people", "desc").map(({ id }) => id), ["a", "b", "z"]);
  assert.deepEqual(sortPublicRooms(namedRooms, "source", "asc").map(({ id }) => id), ["b", "a", "z"]);
  assert.deepEqual(sortPublicRooms(namedRooms, "source", "desc").map(({ id }) => id), ["a", "b", "z"]);
  assert.deepEqual(sortPublicRooms(namedRooms, "activity", "asc").map(({ id }) => id), ["z", "b", "a"]);
  assert.deepEqual(sortPublicRooms(namedRooms, "activity", "desc").map(({ id }) => id), ["a", "b", "z"]);
});

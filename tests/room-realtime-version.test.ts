import assert from "node:assert/strict";
import test from "node:test";
import { completesAuthorityLobbyHandoff } from "../src/lib/roomRealtimeVersion";

const lobby = { status: "LOBBY" as const, currentGameId: null };

test("completed authority lobby handoff resets a higher game-stream version before lobby updates", () => {
  let lastVersion: number | null = 80;

  if (completesAuthorityLobbyHandoff({ name: "returnRoomToLobby", authorityVersion: 2 }, lobby)) {
    lastVersion = null;
  }

  const firstLobbyVersion = 13;
  assert.equal(lastVersion === null || firstLobbyVersion > lastVersion, true);
});

test("canceling an active authority game also completes the lobby handoff", () => {
  assert.equal(
    completesAuthorityLobbyHandoff({ name: "cancelCurrentRound", authorityVersion: 2 }, lobby),
    true,
  );
});

test("ordinary lobby updates do not reset realtime version ordering", () => {
  assert.equal(
    completesAuthorityLobbyHandoff({ name: "selectTeamForPlayer", authorityVersion: 1 }, lobby),
    false,
  );
  assert.equal(
    completesAuthorityLobbyHandoff(
      { name: "returnRoomToLobby", authorityVersion: 2 },
      { status: "GAME_RESULT", currentGameId: "game-1" },
    ),
    false,
  );
});

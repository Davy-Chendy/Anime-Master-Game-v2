import assert from "node:assert/strict";
import test from "node:test";
import { isRoomNicknameTaken } from "../src/lib/roomNickname";

const players = [
  { id: "p0", nickname: "Alice" },
  { id: "p1", nickname: "Bob" },
];

test("room entry rejects another player's normalized nickname before navigation", () => {
  assert.equal(isRoomNicknameTaken(players, "late", " alice "), true);
  assert.equal(isRoomNicknameTaken(players, "late", "BOB"), true);
});

test("room entry allows the same player identity and an unused nickname", () => {
  assert.equal(isRoomNicknameTaken(players, "p0", " alice "), false);
  assert.equal(isRoomNicknameTaken(players, "late", "Carol"), false);
});

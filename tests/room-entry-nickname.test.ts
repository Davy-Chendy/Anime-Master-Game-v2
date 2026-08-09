import assert from "node:assert/strict";
import test from "node:test";
import { isRoomNicknameTaken } from "../src/lib/roomNickname";
import { getInviteNicknameNotice, ROOM_REMOVAL_NOTICE } from "../src/lib/roomEntryNotice";

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

test("room entry explains a valid invitation when the nickname is missing", () => {
  assert.equal(getInviteNicknameNotice("890884", ""), "已填入房间号 890884，输入昵称后即可加入。");
  assert.equal(getInviteNicknameNotice("890884", "小明"), "");
  assert.equal(getInviteNicknameNotice("invalid", ""), "");
  assert.equal(ROOM_REMOVAL_NOTICE, "你已主动退出或被房主移出房间");
});

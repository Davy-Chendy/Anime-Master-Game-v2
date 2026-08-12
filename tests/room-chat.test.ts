import assert from "node:assert/strict";
import test from "node:test";
import { clampRoomChatPanelHeight } from "../src/components/RoomChat";
import {
  appendRoomChatMessage,
  clearAllRoomChatMessages,
  clearRoomChatMessages,
  loadRoomChatMessages,
  saveRoomChatMessages,
  type StoredRoomChatMessage,
} from "../src/lib/roomChat";
import { ROOM_CHAT_MAX_MESSAGES, ROOM_CHAT_MAX_TEXT_CODE_POINTS } from "../src/types/chat";
import { buildRoomChatTeamAudience, RoomChatRateLimiter, tryHandleRoomChatMessage, type RoomChatTeamAudience } from "../worker/roomChat";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class FakeSocket {
  readonly sent: string[] = [];
  closed = false;

  constructor(private readonly attachment: { topic?: string; playerId?: string } | null) {}
  deserializeAttachment() { return this.attachment; }
  send(payload: string) { this.sent.push(payload); }
  close() { this.closed = true; }
}

class FailingSocket extends FakeSocket {
  send() { throw new Error("socket closed"); }
}

function socket(topic = "room:one", playerId = "player-1") {
  return new FakeSocket({ topic, playerId });
}

function sendChat(
  sender: FakeSocket,
  sockets: FakeSocket[],
  text: string,
  limiter = new RoomChatRateLimiter(),
  now = 1000,
  channel?: "room" | "team",
  resolveTeamAudience?: (topic: string, playerId: string) => RoomChatTeamAudience | null,
) {
  return tryHandleRoomChatMessage({
    socket: sender as unknown as WebSocket,
    sockets: sockets as unknown as WebSocket[],
    message: JSON.stringify({ type: "chat_send", clientMessageId: `client-${now}`, channel, text }),
    rateLimiter: limiter,
    resolveTeamAudience,
    now,
  });
}

function stored(index: number): StoredRoomChatMessage {
  return {
    type: "chat_message",
    messageId: `message-${index}`,
    clientMessageId: `client-${index}`,
    topic: "room:one",
    playerId: `player-${index % 3}`,
    nickname: `玩家 ${index}`,
    text: `消息 ${index}`,
    sentAt: index,
  };
}

test("room chat ignores non-chat protocol messages", () => {
  const sender = socket();
  const handled = tryHandleRoomChatMessage({
    socket: sender as unknown as WebSocket,
    sockets: [sender] as unknown as WebSocket[],
    message: JSON.stringify({ type: "action", name: "submitAnswer" }),
    rateLimiter: new RoomChatRateLimiter(),
  });
  assert.equal(handled, false);
  assert.deepEqual(sender.sent, []);
});

test("room chat validates identity, content length, and byte length", () => {
  const unidentified = new FakeSocket(null);
  assert.equal(sendChat(unidentified, [unidentified], "你好"), true);
  assert.equal(JSON.parse(unidentified.sent[0]!).code, "NO_IDENTITY");

  const sender = socket();
  sendChat(sender, [sender], "   ");
  assert.equal(JSON.parse(sender.sent.at(-1)!).code, "INVALID_MESSAGE");
  sendChat(sender, [sender], "a".repeat(ROOM_CHAT_MAX_TEXT_CODE_POINTS + 1));
  assert.equal(JSON.parse(sender.sent.at(-1)!).code, "INVALID_MESSAGE");
  sendChat(sender, [sender], "界".repeat(ROOM_CHAT_MAX_TEXT_CODE_POINTS));
  assert.equal(JSON.parse(sender.sent.at(-1)!).type, "chat_message");

  const oversizedEnvelope = JSON.stringify({
    type: "chat_send",
    clientMessageId: "client-envelope",
    text: "a".repeat(2100),
  });
  tryHandleRoomChatMessage({
    socket: sender as unknown as WebSocket,
    sockets: [sender] as unknown as WebSocket[],
    message: oversizedEnvelope,
    rateLimiter: new RoomChatRateLimiter(),
  });
  assert.equal(JSON.parse(sender.sent.at(-1)!).code, "INVALID_MESSAGE");

  tryHandleRoomChatMessage({
    socket: sender as unknown as WebSocket,
    sockets: [sender] as unknown as WebSocket[],
    message: JSON.stringify({ type: "chat_send", clientMessageId: "client-channel", channel: "spectator", text: "无效频道" }),
    rateLimiter: new RoomChatRateLimiter(),
  });
  assert.equal(JSON.parse(sender.sent.at(-1)!).code, "INVALID_MESSAGE");
});

test("room chat limits each socket to three messages per five seconds", () => {
  const sender = socket();
  const limiter = new RoomChatRateLimiter();
  for (let index = 0; index < 3; index += 1) sendChat(sender, [sender], `消息 ${index}`, limiter, 1000 + index);
  sendChat(sender, [sender], "第四条", limiter, 1004);
  assert.equal(JSON.parse(sender.sent.at(-1)!).code, "RATE_LIMITED");
  sendChat(sender, [sender], "窗口后", limiter, 6000);
  assert.equal(JSON.parse(sender.sent.at(-1)!).text, "窗口后");
});

test("one inbound message broadcasts once to all 50 same-room sockets only", () => {
  const sameRoom = Array.from({ length: 50 }, (_, index) => socket("room:one", `player-${index}`));
  const otherRoom = socket("room:two", "outsider");
  sendChat(sameRoom[0]!, [...sameRoom, otherRoom], "  大家好  ", new RoomChatRateLimiter(), 1234);

  for (const target of sameRoom) {
    assert.equal(target.sent.length, 1);
    const event = JSON.parse(target.sent[0]!);
    assert.equal(event.playerId, "player-0");
    assert.equal(event.topic, "room:one");
    assert.equal(event.channel, "room");
    assert.equal(event.text, "大家好");
    assert.equal(event.sentAt, 1234);
  }
  assert.equal(otherRoom.sent.length, 0);
});

test("team chat in a 50-member room reaches the sender's team, presenter, and spectators only", () => {
  const red = Array.from({ length: 24 }, (_, index) => socket("room:one", `red-${index}`));
  const blue = Array.from({ length: 24 }, (_, index) => socket("room:one", `blue-${index}`));
  const redOneSecondTab = socket("room:one", "red-0");
  const presenter = socket("room:one", "presenter");
  const spectator = socket("room:one", "spectator");
  const otherRoom = socket("room:two", "red-0");
  const redAudienceIds = new Set([
    ...red.map((_, index) => `red-${index}`),
    "presenter",
    "spectator",
  ]);

  sendChat(
    red[0]!,
    [...red, ...blue, redOneSecondTab, presenter, spectator, otherRoom],
    "只给红队",
    new RoomChatRateLimiter(),
    2000,
    "team",
    (topic, playerId) => topic === "room:one" && playerId === "red-0"
      ? { team: "red", playerIds: redAudienceIds }
      : null,
  );

  for (const target of [...red, redOneSecondTab, presenter, spectator]) {
    assert.equal(target.sent.length, 1);
    const event = JSON.parse(target.sent[0]!);
    assert.equal(event.channel, "team");
    assert.equal(event.team, "red");
    assert.equal(event.text, "只给红队");
  }
  for (const target of [...blue, otherRoom]) assert.equal(target.sent.length, 0);
});

test("team chat audience includes presenter and spectators but excludes opponents and unassigned players", () => {
  const audience = buildRoomChatTeamAudience({
    senderPlayerId: "red-1",
    teams: { red: ["red-1", "red-2"], blue: ["blue-1"] },
    players: [
      { id: "red-1", nickname: "红一", isHost: false, role: "PLAYER", joinedAt: 1 },
      { id: "red-2", nickname: "红二", isHost: false, role: "PLAYER", joinedAt: 2 },
      { id: "blue-1", nickname: "蓝一", isHost: false, role: "PLAYER", joinedAt: 3 },
      { id: "presenter", nickname: "裁判", isHost: true, role: "PLAYER", joinedAt: 4 },
      { id: "spectator", nickname: "观众", isHost: false, role: "SPECTATOR", joinedAt: 5 },
      { id: "unassigned", nickname: "未分队", isHost: false, role: "PLAYER", joinedAt: 6 },
    ],
    presenterPlayerId: "presenter",
  });

  assert.equal(audience?.team, "red");
  assert.deepEqual(audience?.playerIds, new Set(["red-1", "red-2", "presenter", "spectator"]));
  assert.equal(buildRoomChatTeamAudience({
    senderPlayerId: "spectator",
    teams: { red: ["red-1"], blue: ["blue-1"] },
    players: [{ id: "spectator", nickname: "观众", isHost: false, role: "SPECTATOR", joinedAt: 1 }],
    presenterPlayerId: "presenter",
  }), null);
});

test("presenters, spectators, and unassigned players cannot send team chat", () => {
  for (const playerId of ["presenter", "spectator", "unassigned"]) {
    const sender = socket("room:one", playerId);
    sendChat(sender, [sender], "不能发送", new RoomChatRateLimiter(), 3000, "team", () => null);
    const event = JSON.parse(sender.sent[0]!);
    assert.equal(event.type, "chat_error");
    assert.equal(event.code, "CHANNEL_UNAVAILABLE");
  }
});

test("room and team channels share the same per-socket rate limit", () => {
  const sender = socket("room:one", "red-1");
  const limiter = new RoomChatRateLimiter();
  const redAudience = () => ({ team: "red" as const, playerIds: new Set(["red-1"]) });
  sendChat(sender, [sender], "房间一", limiter, 1000, "room", redAudience);
  sendChat(sender, [sender], "队内一", limiter, 1001, "team", redAudience);
  sendChat(sender, [sender], "房间二", limiter, 1002, "room", redAudience);
  sendChat(sender, [sender], "队内二", limiter, 1003, "team", redAudience);
  assert.equal(JSON.parse(sender.sent.at(-1)!).code, "RATE_LIMITED");
});

test("a newly connected socket receives no history but receives future messages", () => {
  const original = socket("room:one", "original");
  sendChat(original, [original], "旧消息");
  const reconnected = socket("room:one", "reconnected");
  assert.equal(reconnected.sent.length, 0);
  sendChat(original, [original, reconnected], "新消息", new RoomChatRateLimiter(), 2000);
  assert.equal(reconnected.sent.length, 1);
  assert.equal(JSON.parse(reconnected.sent[0]!).text, "新消息");
});

test("one failed recipient does not prevent delivery to the rest of the room", () => {
  const sender = socket("room:one", "sender");
  const failed = new FailingSocket({ topic: "room:one", playerId: "failed" });
  const healthy = socket("room:one", "healthy");
  sendChat(sender, [sender, failed, healthy], "仍然送达");
  assert.equal(failed.closed, true);
  assert.equal(JSON.parse(healthy.sent[0]!).text, "仍然送达");
});

test("session history deduplicates and retains the latest 100 messages", () => {
  let messages: StoredRoomChatMessage[] = [];
  for (let index = 0; index < ROOM_CHAT_MAX_MESSAGES + 5; index += 1) {
    messages = appendRoomChatMessage(messages, stored(index));
  }
  assert.equal(messages.length, ROOM_CHAT_MAX_MESSAGES);
  assert.equal(messages[0]?.messageId, "message-5");
  const duplicate = appendRoomChatMessage(messages, messages.at(-1)!);
  assert.deepEqual(duplicate, messages);
});

test("session history loads, clears one room, clears all rooms, and tolerates damaged JSON", () => {
  const storage = new MemoryStorage();
  const teamMessage = { ...stored(2), channel: "team" as const, team: "red" as const };
  saveRoomChatMessages("one", [stored(1), teamMessage], storage);
  saveRoomChatMessages("two", [stored(3)], storage);
  const loaded = loadRoomChatMessages("one", storage);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0]?.channel, undefined);
  assert.equal(loaded[1]?.channel, "team");
  assert.equal(loaded[1]?.team, "red");
  clearRoomChatMessages("one", storage);
  assert.deepEqual(loadRoomChatMessages("one", storage), []);
  assert.equal(loadRoomChatMessages("two", storage).length, 1);
  storage.setItem("unrelated", "keep");
  clearAllRoomChatMessages(storage);
  assert.deepEqual(loadRoomChatMessages("two", storage), []);
  assert.equal(storage.getItem("unrelated"), "keep");
  storage.setItem("anime-master:room-chat:broken", "{");
  assert.deepEqual(loadRoomChatMessages("broken", storage), []);
});

test("expanded panel height stays within the viewport allowance", () => {
  assert.equal(clampRoomChatPanelHeight(20, 800), 84);
  assert.equal(clampRoomChatPanelHeight(240, 800), 240);
  assert.equal(clampRoomChatPanelHeight(900, 800), 400);
});

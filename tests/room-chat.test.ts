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
import { ROOM_CHAT_MAX_MESSAGES } from "../src/types/chat";
import { RoomChatRateLimiter, tryHandleRoomChatMessage } from "../worker/roomChat";

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
) {
  return tryHandleRoomChatMessage({
    socket: sender as unknown as WebSocket,
    sockets: sockets as unknown as WebSocket[],
    message: JSON.stringify({ type: "chat_send", clientMessageId: `client-${now}`, text }),
    rateLimiter: limiter,
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
  sendChat(sender, [sender], "a".repeat(201));
  assert.equal(JSON.parse(sender.sent.at(-1)!).code, "INVALID_MESSAGE");
  sendChat(sender, [sender], "界".repeat(200));
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
    assert.equal(event.text, "大家好");
    assert.equal(event.sentAt, 1234);
  }
  assert.equal(otherRoom.sent.length, 0);
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
  saveRoomChatMessages("one", [stored(1), stored(2)], storage);
  saveRoomChatMessages("two", [stored(3)], storage);
  assert.equal(loadRoomChatMessages("one", storage).length, 2);
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
  assert.equal(clampRoomChatPanelHeight(20, 800), 92);
  assert.equal(clampRoomChatPanelHeight(240, 800), 240);
  assert.equal(clampRoomChatPanelHeight(900, 800), 400);
});

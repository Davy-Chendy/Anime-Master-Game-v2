import assert from "node:assert/strict";
import test from "node:test";

import { applyConnectionPresenceChanges, CONNECTION_DISCONNECTED_GRACE_MS, isConnectionDisconnected } from "../src/lib/connectionPresence";
import type { ConnectionPresenceChange } from "../src/types/game";
import { CONNECTION_PRESENCE_STORAGE_KEY, RoomConnectionPresence } from "../worker/roomConnectionPresence";

class PresenceStorage {
  readonly values = new Map<string, unknown>();
  putCount = 0;
  deleteCount = 0;
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown) { this.putCount += 1; this.values.set(key, structuredClone(value)); }
  async delete(key: string) { this.deleteCount += 1; this.values.delete(key); }
}

class PresenceSocket {
  constructor(readonly attachment: { topic: string; playerId: string }) {}
  deserializeAttachment() { return this.attachment; }
}

function createHarness(playerIds: string[], storage = new PresenceStorage()) {
  const sockets: PresenceSocket[] = [];
  const broadcasts: ConnectionPresenceChange[][] = [];
  const state = {
    storage,
    getWebSockets: () => sockets,
    waitUntil(promise: Promise<unknown>) { void promise; },
  } as unknown as DurableObjectState;
  const presence = new RoomConnectionPresence(
    state,
    () => "room:A",
    (changes) => broadcasts.push(changes),
    () => new Set(playerIds),
  );
  return { presence, storage, sockets, broadcasts };
}

test("last same-room socket close records one disconnect and the UI applies a 60 second grace", async () => {
  const harness = createHarness(["p1"]);
  const socket = new PresenceSocket({ topic: "room:A", playerId: "p1" });
  harness.sockets.push(socket);
  await harness.presence.handleConnect("p1");
  await harness.presence.flushNow();

  const disconnectedAt = 10_000;
  harness.presence.handleDisconnect(socket as unknown as WebSocket, disconnectedAt);
  await harness.presence.flushNow();

  assert.deepEqual(harness.broadcasts, [[{ playerId: "p1", disconnectedAt }]]);
  assert.equal(isConnectionDisconnected(disconnectedAt, disconnectedAt + CONNECTION_DISCONNECTED_GRACE_MS - 1), false);
  assert.equal(isConnectionDisconnected(disconnectedAt, disconnectedAt + CONNECTION_DISCONNECTED_GRACE_MS), true);
});

test("a reconnect snapshot replaces stale client markers, including with an empty snapshot", () => {
  assert.deepEqual(
    applyConnectionPresenceChanges({ stale: 1_000 }, [{ playerId: "current", disconnectedAt: 2_000 }], true),
    { current: 2_000 },
  );
  assert.deepEqual(applyConnectionPresenceChanges({ stale: 1_000 }, [], true), {});
});

test("another same-room tab keeps the player connected, while a different room socket does not", async () => {
  const harness = createHarness(["p1"]);
  const first = new PresenceSocket({ topic: "room:A", playerId: "p1" });
  const second = new PresenceSocket({ topic: "room:A", playerId: "p1" });
  const otherRoom = new PresenceSocket({ topic: "room:B", playerId: "p1" });
  harness.sockets.push(first, second, otherRoom);
  await harness.presence.handleConnect("p1");
  await harness.presence.flushNow();

  harness.presence.handleDisconnect(first as unknown as WebSocket, 1_000);
  await harness.presence.flushNow();
  assert.deepEqual(harness.broadcasts, []);

  harness.presence.handleDisconnect(second as unknown as WebSocket, 2_000);
  await harness.presence.flushNow();
  assert.deepEqual(harness.broadcasts, [[{ playerId: "p1", disconnectedAt: 2_000 }]]);
});

test("reconnect clears an existing marker immediately and duplicate close/error is idempotent", async () => {
  const harness = createHarness(["p1"]);
  const oldSocket = new PresenceSocket({ topic: "room:A", playerId: "p1" });
  harness.sockets.push(oldSocket);
  await harness.presence.handleConnect("p1");
  await harness.presence.flushNow();
  harness.presence.handleDisconnect(oldSocket as unknown as WebSocket, 3_000);
  harness.presence.handleDisconnect(oldSocket as unknown as WebSocket, 3_100);
  await harness.presence.flushNow();

  const reconnected = new PresenceSocket({ topic: "room:A", playerId: "p1" });
  harness.sockets.push(reconnected);
  const snapshot = await harness.presence.handleConnect("p1");
  assert.deepEqual(snapshot, [{ playerId: "p1", disconnectedAt: 3_000 }]);
  await harness.presence.flushNow();

  assert.deepEqual(harness.broadcasts, [
    [{ playerId: "p1", disconnectedAt: 3_000 }],
    [{ playerId: "p1", disconnectedAt: null }],
  ]);
});

test("stored disconnect time survives reconstruction and roster cleanup removes stale players", async () => {
  const storage = new PresenceStorage();
  storage.values.set(CONNECTION_PRESENCE_STORAGE_KEY, {
    version: 1,
    disconnectedAtByPlayerId: { p1: 4_000, removed: 5_000 },
  });
  const harness = createHarness(["p1"], storage);
  assert.deepEqual(await harness.presence.handleConnect(undefined), [
    { playerId: "p1", disconnectedAt: 4_000 },
    { playerId: "removed", disconnectedAt: 5_000 },
  ]);
  await harness.presence.handleRosterChanged();
  await harness.presence.flushNow();
  assert.deepEqual(harness.broadcasts, [[{ playerId: "removed", disconnectedAt: null }]]);
});

test("50-player disconnect and reconnect storms are coalesced into one write and one broadcast each", async () => {
  const playerIds = Array.from({ length: 50 }, (_, index) => `p${index + 1}`);
  const harness = createHarness(playerIds);
  const sockets = playerIds.map((playerId) => new PresenceSocket({ topic: "room:A", playerId }));
  harness.sockets.push(...sockets);
  for (const playerId of playerIds) await harness.presence.handleConnect(playerId);
  await harness.presence.flushNow();

  sockets.forEach((socket, index) => harness.presence.handleDisconnect(socket as unknown as WebSocket, 10_000 + index));
  await harness.presence.flushNow();
  assert.equal(harness.storage.putCount, 1);
  assert.equal(harness.broadcasts.length, 1);
  assert.equal(harness.broadcasts[0].length, 50);

  const reconnects = playerIds.map((playerId) => new PresenceSocket({ topic: "room:A", playerId }));
  harness.sockets.push(...reconnects);
  for (const playerId of playerIds) await harness.presence.handleConnect(playerId);
  await harness.presence.flushNow();
  assert.equal(harness.storage.deleteCount, 1);
  assert.equal(harness.broadcasts.length, 2);
  assert.equal(harness.broadcasts[1].length, 50);
});

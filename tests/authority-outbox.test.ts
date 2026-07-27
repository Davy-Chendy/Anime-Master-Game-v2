import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";

import { commitAuthorityOutbox, discardSupersededAuthorityOutbox, enqueueAuthorityMutation, listAuthorityOutbox, resetAuthorityOutboxForTests } from "../src/lib/authorityOutbox";

test.beforeEach(async () => {
  await resetAuthorityOutboxForTests();
});

function mutation(actorId: string, gameId = "g1") {
  return {
    topic: "room:r1",
    actorId,
    gameId,
    questionIndex: 3,
    name: "submitAnswer",
    payload: { gameSessionId: gameId, playerId: actorId, answerText: "answer" },
    args: [{ gameSessionId: gameId, playerId: actorId, answerText: "answer" }],
  };
}

test("enqueue allocates monotonic clientSeq in the same IndexedDB transaction", async () => {
  const first = await enqueueAuthorityMutation(mutation("p1"));
  const second = await enqueueAuthorityMutation(mutation("p1"));
  const otherActor = await enqueueAuthorityMutation(mutation("host"));
  assert.equal(first.clientSeq, 1);
  assert.equal(second.clientSeq, 2);
  assert.equal(otherActor.clientSeq, 1);
  assert.deepEqual((await listAuthorityOutbox("room:r1")).map((item) => [item.actorId, item.clientSeq]), [["host", 1], ["p1", 1], ["p1", 2]]);
});

test("durable ACK deletes only committed actor sequences for the matching game", async () => {
  await enqueueAuthorityMutation(mutation("p1"));
  await enqueueAuthorityMutation(mutation("p1"));
  await enqueueAuthorityMutation(mutation("host"));
  await enqueueAuthorityMutation(mutation("p1", "g2"));
  await commitAuthorityOutbox("room:r1", "g1", { p1: 1, host: 1 });
  const remaining = await listAuthorityOutbox("room:r1");
  assert.deepEqual(remaining.map((item) => [item.gameId, item.actorId, item.clientSeq]), [["g2", "p1", 1], ["g1", "p1", 2]]);
});

test("refresh-style reopen preserves uncommitted mutations", async () => {
  const queued = await enqueueAuthorityMutation(mutation("p1"));
  const reloaded = await listAuthorityOutbox("room:r1");
  assert.equal(reloaded[0]?.actionId, queued.actionId);
  assert.equal(reloaded[0]?.questionIndex, 3);
});

test("durable new-game handshake discards only superseded game mutations", async () => {
  await enqueueAuthorityMutation(mutation("p1", "g1"));
  const current = await enqueueAuthorityMutation(mutation("p1", "g2"));
  await discardSupersededAuthorityOutbox("room:r1", "g2");
  const remaining = await listAuthorityOutbox("room:r1");
  assert.deepEqual(remaining.map((item) => item.actionId), [current.actionId]);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { RoomGameAuthority } from "../worker/roomGameAuthority";
import { ATTACHMENT_BUDGET_BYTES, RoomAuthorityVNext, type VNextMutationEnvelope, type VNextSocketAttachment } from "../worker/roomAuthorityVNext";
import type { GameSession, Player, Question, QuestionSet, Room } from "../src/types/game";

class Cursor<T extends Record<string, unknown>> {
  constructor(private readonly rows: T[]) {}
  toArray() { return this.rows; }
  one() {
    if (this.rows.length !== 1) throw new Error(`Expected one row, received ${this.rows.length}`);
    return this.rows[0];
  }
  get rowsRead() { return this.rows.length; }
  get rowsWritten() { return 0; }
  get columnNames() { return Object.keys(this.rows[0] ?? {}); }
  [Symbol.iterator]() { return this.rows[Symbol.iterator](); }
}

class SqlAdapter {
  activeWrites = 0;
  archiveWrites = 0;
  failOn = "";
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
    if (this.failOn && query.includes(this.failOn)) throw new Error("injected migration failure");
    if (/INSERT INTO authority_vnext_active_game/i.test(query)) this.activeWrites += 1;
    if (/INSERT INTO authority_vnext_question_archive/i.test(query)) this.archiveWrites += 1;
    const statement = this.db.prepare(query);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
      return new Cursor(statement.all(...bindings) as T[]);
    }
    statement.run(...bindings);
    return new Cursor<T>([]);
  }
  get databaseSize() { return 0; }
}

class StorageAdapter {
  readonly sql = new SqlAdapter();
  private readonly kv = new Map<string, unknown>();
  private alarmAt: number | null = null;
  transactionSync<T>(callback: () => T) {
    this.sql.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.sql.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.sql.db.exec("ROLLBACK");
      throw error;
    }
  }
  async get<T>(key: string) { return this.kv.get(key) as T | undefined; }
  async put(key: string, value: unknown) { this.kv.set(key, value); }
  async delete(key: string) { return this.kv.delete(key); }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(value: number | Date) { this.alarmAt = typeof value === "number" ? value : value.getTime(); }
  async deleteAlarm() { this.alarmAt = null; }
}

class FakeSocket {
  attachment: unknown = null;
  sent: string[] = [];
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(value: string) { this.sent.push(value); }
  close() {}
}

class FakeState {
  readonly storage = new StorageAdapter();
  readonly sockets: FakeSocket[] = [];
  id = { toString: () => "test-room" };
  getWebSockets() { return this.sockets as unknown as WebSocket[]; }
  waitUntil() {}
}

const fakeD1 = {
  prepare() { return { bind() { return this; } }; },
  async batch() { return []; },
} as unknown as D1Database;

function socketFor(state: FakeState, playerId: string) {
  const socket = new FakeSocket();
  const attachment: VNextSocketAttachment = { attachmentVersion: 1, topic: "room:r1", playerId, pending: [], serializedBytes: 0 };
  socket.serializeAttachment(attachment);
  state.sockets.push(socket);
  return socket as unknown as WebSocket;
}

function bootstrap(playerCount = 50, questionCount = 1) {
  const players: Player[] = [
    { id: "host", roomId: "r1", nickname: "Host", isHost: true, role: "PLAYER", joinedAt: 0 },
    ...Array.from({ length: playerCount }, (_, index) => ({ id: `p${index}`, roomId: "r1", nickname: `P${index}`, isHost: false, role: "PLAYER" as const, joinedAt: index + 1 })),
  ];
  const room: Room = { id: "r1", code: "ROOM01", hostPlayerId: "host", players, status: "PLAYING", currentPresenterPlayerId: "host", currentGameId: "g1", createdAt: 0 };
  const questions: Question[] = Array.from({ length: questionCount }, (_, index) => ({ id: `q${index + 1}`, questionSetId: "set1", imageUrl: `https://example.com/${index + 1}.webp`, orderIndex: index, createdAt: new Date(0).toISOString() }));
  const questionSet: QuestionSet = { id: "set1", title: "Set", createdByPlayerId: "host", source: "uploaded", isPublic: false, imageCount: questionCount, ratingAvg: 0, ratingCount: 0, playCount: 0, createdAt: new Date(0).toISOString(), questions };
  const gameSession: GameSession = { id: "g1", roomId: "r1", questionSetId: "set1", presenterPlayerId: "host", status: "PLAYING", gameMode: "ROUND_REVEAL", currentQuestionIndex: 0, currentRevealRound: 1, revealedBlocks: [], maxRevealRounds: 3, roundSeconds: 45, roundScores: [5, 3, 1], eligiblePlayerIds: players.slice(1).map((player) => player.id), roundStartedAt: null, createdAt: new Date(0).toISOString() };
  return { room, players, questionSet, questions, gameSession };
}

function envelope(actorId: string, clientSeq: number, name: string, payload: Record<string, unknown>, actionId = `${actorId}:${clientSeq}:${name}`): VNextMutationEnvelope {
  return { actionId, actorId, clientSeq, gameId: "g1", questionIndex: 0, name, payload };
}

function createAuthority(playerCount = 50, d1: D1Database = fakeD1, questionCount = 1) {
  const state = new FakeState();
  state.storage.sql.db.exec(`
    CREATE TABLE authority_vnext_active_game (id INTEGER PRIMARY KEY CHECK(id=1),room_id TEXT NOT NULL,game_id TEXT NOT NULL,authority_version INTEGER NOT NULL,schema_version INTEGER NOT NULL,cutover_state TEXT NOT NULL,state_version INTEGER NOT NULL,state_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE authority_vnext_question_archive (game_id TEXT NOT NULL,question_index INTEGER NOT NULL,checkpoint_version INTEGER NOT NULL,state_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(game_id,question_index));
    CREATE TABLE authority_vnext_projection_outbox (id INTEGER PRIMARY KEY CHECK(id=1),payload_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
  `);
  const authority = new RoomAuthorityVNext(state as unknown as DurableObjectState, d1);
  authority.beginStart("r1", "g1", { startRequestId: "g1" });
  authority.activateStart(bootstrap(playerCount, questionCount));
  return { state, authority };
}

test("v6 upgrades atomically to v7 and repeated initialization is idempotent", () => {
  const storage = new StorageAdapter();
  storage.sql.db.exec("CREATE TABLE authority_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO authority_schema VALUES(1,6)");
  const authority = new RoomGameAuthority(storage as unknown as DurableObjectStorage, fakeD1);
  authority.initializeSchema();
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 7);
  authority.initializeSchema();
  assert.equal(storage.sql.db.prepare("SELECT COUNT(*) count FROM authority_vnext_active_game").get().count, 0);
});

test("migration failure does not advance production v6", () => {
  const storage = new StorageAdapter();
  storage.sql.db.exec("CREATE TABLE authority_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO authority_schema VALUES(1,6)");
  storage.sql.failOn = "authority_vnext_question_archive";
  const authority = new RoomGameAuthority(storage as unknown as DurableObjectStorage, fakeD1);
  assert.throws(() => authority.initializeSchema(), /injected migration failure/);
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 6);
});

test("fresh schema reaches v7", () => {
  const storage = new StorageAdapter();
  new RoomGameAuthority(storage as unknown as DurableObjectStorage, fakeD1).initializeSchema();
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 7);
  assert.equal(storage.sql.db.prepare("SELECT COUNT(*) count FROM pragma_table_info('authority_vnext_projection_outbox') WHERE name='payload_json'").get().count, 1);
});

test("v6 journal and existing business Alarm survive the additive upgrade", async () => {
  const storage = new StorageAdapter();
  storage.sql.db.exec(`
    CREATE TABLE authority_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT INTO authority_schema VALUES(1,6);
    CREATE TABLE mutation_journal(id INTEGER PRIMARY KEY CHECK(id=1),room_id TEXT NOT NULL,name TEXT NOT NULL,action_key TEXT,started_at INTEGER NOT NULL);
    INSERT INTO mutation_journal VALUES(1,'r1','submitAnswer','a1',123);
  `);
  await storage.setAlarm(456_789);
  new RoomGameAuthority(storage as unknown as DurableObjectStorage, fakeD1).initializeSchema();
  assert.equal(storage.sql.db.prepare("SELECT action_key FROM mutation_journal WHERE id=1").get().action_key, "a1");
  assert.equal(await storage.getAlarm(), 456_789);
});

test("50 answers and 50 judgements coalesce checkpoints and never write per action", async () => {
  const { state, authority } = createAuthority(50);
  const hostSocket = socketFor(state, "host");
  const startedAt = Date.now();
  authority.handleMutation(hostSocket, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), startedAt);
  await authority.forceCheckpoint("phase-boundary");
  const afterStartWrites = state.storage.sql.activeWrites;
  const answerSockets: WebSocket[] = [];
  for (let index = 0; index < 50; index += 1) {
    const playerId = `p${index}`;
    const socket = socketFor(state, playerId);
    answerSockets.push(socket);
    authority.handleMutation(socket, envelope(playerId, 1, "submitAnswer", { playerId, answerText: `a${index}` }), startedAt + 100 + index);
    await authority.maybeCheckpoint();
  }
  assert.ok(state.storage.sql.activeWrites - afterStartWrites <= 2, "answers should checkpoint in aggregate batches");
  for (let index = 0; index < 50; index += 1) {
    authority.handleMutation(hostSocket, envelope("host", index + 2, "setAnswerJudgements", {
      presenterPlayerId: "host",
      judgements: [{ buzzerAnswerId: `p${index}:1:submitAnswer:b`, isCorrect: true }],
    }), startedAt + 5000 + index);
    await authority.maybeCheckpoint();
  }
  assert.ok(state.storage.sql.activeWrites < 10, `unexpected checkpoint amplification: ${state.storage.sql.activeWrites}`);
  assert.equal(authority.getSnapshot().scores.filter((score) => score.score === 5).length, 50);
});

test("batch judgement sends each target only its own compact delta", async () => {
  const { state, authority } = createAuthority(12);
  const host = socketFor(state, "host");
  const startedAt = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), startedAt);
  for (let index = 0; index < 12; index += 1) {
    const playerId = `p${index}`;
    authority.handleMutation(socketFor(state, playerId), envelope(playerId, 1, "submitAnswer", { playerId, answerText: `a${index}` }), startedAt + index + 1);
  }
  const outcome = authority.handleMutation(host, envelope("host", 2, "setAnswerJudgements", {
    presenterPlayerId: "host",
    judgements: Array.from({ length: 12 }, (_, index) => ({ buzzerAnswerId: `p${index}:1:submitAnswer:b`, isCorrect: true })),
  }), startedAt + 4000);
  assert.equal(outcome.presenterDeltas.length, 1);
  assert.equal(outcome.playerDeltas.length, 12);
  for (const delivery of outcome.playerDeltas) {
    assert.ok(JSON.stringify(delivery.delta).length < 1024);
    assert.equal(delivery.delta.type, "answer_judgements_changed");
    if (delivery.delta.type === "answer_judgements_changed") {
      assert.deepEqual(delivery.delta.answers.map((answer) => answer.playerId), [delivery.playerId]);
      assert.ok(delivery.delta.scores.every((score) => score.playerId === delivery.playerId));
      assert.ok(delivery.delta.questionResults.every((result) => result.playerId === delivery.playerId));
    }
  }
});

test("presenter can judge an offline player while later answers still arrive", () => {
  const { state, authority } = createAuthority(3);
  const host = socketFor(state, "host");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  authority.handleMutation(null, envelope("p0", 1, "submitAnswer", { playerId: "p0", answerText: "offline" }), now + 1);
  const judged = authority.handleMutation(host, envelope("host", 2, "setAnswerJudgements", {
    presenterPlayerId: "host",
    judgements: [{ buzzerAnswerId: "p0:1:submitAnswer:b", isCorrect: true }],
  }), now + 4000);
  assert.equal(judged.playerDeltas[0]?.playerId, "p0");
  assert.equal(authority.getSnapshot().scores.find((score) => score.playerId === "p0")?.score, 5);
  const later = authority.handleMutation(socketFor(state, "p1"), envelope("p1", 1, "submitAnswer", { playerId: "p1", answerText: "later" }), now + 4001);
  assert.equal(later.error, undefined);
  assert.equal(later.provisional, true);
});

test("checkpoint generation does not commit an action arriving in-flight", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  for (let seq = 1; seq <= 20; seq += 1) {
    authority.handleMutation(host, envelope("host", seq, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: `L${seq}`, source: "manual" }), Date.now() + seq);
  }
  const checkpoint = authority.maybeCheckpoint();
  authority.handleMutation(host, envelope("host", 21, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "late", source: "manual" }), Date.now() + 30);
  const receipt = await checkpoint;
  assert.equal(receipt?.committedSeqByActor.host, 20);
  assert.equal(authority.getAggregate()?.committedSeqByActor.host, 20);
  await authority.forceCheckpoint("phase-boundary");
  assert.equal(authority.getAggregate()?.committedSeqByActor.host, 21);
});

test("hibernation merges uncommitted Attachment exactly once", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  authority.handleMutation(host, envelope("host", 1, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "pending", source: "manual" }), Date.now());
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  assert.equal(restored.getAggregate()?.questions[0].labelText, "pending");
  assert.equal(restored.getAggregate()?.seenSeqByActor.host, 1);
});

test("50 dirty closes merge to one aggregate checkpoint", async () => {
  const { state, authority } = createAuthority(1);
  const sockets: WebSocket[] = [];
  for (let seq = 1; seq <= 50; seq += 1) {
    const socket = socketFor(state, "host");
    sockets.push(socket);
    authority.handleMutation(socket, envelope("host", seq, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: `close-${seq}`, source: "manual" }), Date.now() + seq);
  }
  const before = state.storage.sql.activeWrites;
  await Promise.all(sockets.map((socket) => authority.handleSocketClose(socket)));
  assert.equal(state.storage.sql.activeWrites - before, 1);
});

test("Attachment budget checkpoints and compacts without crashing", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  authority.handleMutation(host, envelope("host", 1, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "x".repeat(ATTACHMENT_BUDGET_BYTES), source: "manual" }), Date.now());
  await authority.forceCheckpoint("attachment-budget");
  const attachment = (host as unknown as FakeSocket).deserializeAttachment() as VNextSocketAttachment;
  assert.equal(attachment.pending.length, 0);
});

test("deadline execution is persist-first and idempotent", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  await authority.forceCheckpoint("phase-boundary");
  const deadline = authority.getDeadline();
  assert.ok(deadline);
  const first = await authority.executeDueDeadline(deadline!.runAtMs);
  assert.ok(first?.receipt);
  const writes = state.storage.sql.activeWrites;
  const second = await authority.executeDueDeadline(deadline!.runAtMs + 1);
  assert.equal(second, null);
  assert.equal(state.storage.sql.activeWrites, writes);
});

test("failed deadline checkpoint reloads durable deadline before same-instance retry", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  await authority.forceCheckpoint("phase-boundary");
  const deadline = authority.getDeadline();
  assert.ok(deadline);
  state.storage.sql.failOn = "authority_vnext_active_game";
  await assert.rejects(authority.executeDueDeadline(deadline!.runAtMs), /injected migration failure/);
  authority.resetAfterFailedTransition();
  state.storage.sql.failOn = "";
  await authority.restoreFromStorage();
  const retried = await authority.executeDueDeadline(deadline!.runAtMs + 1);
  assert.ok(retried?.receipt);
  assert.equal(authority.getAggregate()?.deadline, null);
  const writes = state.storage.sql.activeWrites;
  assert.equal(await authority.executeDueDeadline(deadline!.runAtMs + 2), null);
  assert.equal(state.storage.sql.activeWrites, writes);
});

test("duplicate and out-of-order mutations never apply twice", () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const action = envelope("host", 1, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "once", source: "manual" }, "same");
  assert.equal(authority.handleMutation(host, action, Date.now()).duplicate, undefined);
  assert.equal(authority.handleMutation(host, action, Date.now()).duplicate, true);
  const outOfOrder = authority.handleMutation(host, envelope("host", 3, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "bad", source: "manual" }), Date.now());
  assert.match(outOfOrder.error ?? "", /乱序/);
  assert.equal(authority.getAggregate()?.questions[0].labelText, "once");
});

test("uncommitted persist-first duplicate retains its checkpoint requirement", async () => {
  const { state, authority } = createAuthority(1, fakeD1, 2);
  const host = socketFor(state, "host");
  const action = envelope("host", 1, "skipCurrentQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0 });
  const first = authority.handleMutation(host, action, Date.now());
  assert.equal(first.forceCheckpoint, "phase-boundary");
  state.storage.sql.failOn = "authority_vnext_active_game";
  await assert.rejects(authority.forceCheckpoint(first.forceCheckpoint!, first.archiveQuestion), /injected migration failure/);
  state.storage.sql.failOn = "";
  const replay = authority.handleMutation(host, action, Date.now() + 1);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.forceCheckpoint, "phase-boundary");
  await authority.forceCheckpoint(replay.forceCheckpoint!, replay.archiveQuestion);
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  state.sockets.length = 0;
  await restored.restoreFromStorage();
  assert.equal(restored.getAggregate()?.gameSession?.currentQuestionIndex, 1);
});

test("hibernation replay remembers persist-first outcome before duplicate ACK", async () => {
  const { state, authority } = createAuthority(1, fakeD1, 2);
  const host = socketFor(state, "host");
  const action = envelope("host", 1, "skipCurrentQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0 });
  authority.handleMutation(host, action, Date.now());
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  const replay = restored.handleMutation(host, action, Date.now() + 1);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.forceCheckpoint, "phase-boundary");
  assert.equal(replay.archiveQuestion, true);
});

test("terminal rejection replays from Attachment without blocking hibernation restore", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const rejected = authority.handleMutation(host, envelope("host", 1, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "missing", labelText: "bad" }), Date.now());
  assert.equal(rejected.terminal, true);
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  assert.equal(restored.getAggregate()?.seenSeqByActor.host, 1);
  assert.match(restored.getAggregate()?.terminalRejections["host:1"] ?? "", /参数无效/);
});

test("committed terminal rejection keeps the same error after restart", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const action = envelope("host", 1, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "missing", labelText: "bad" });
  const rejected = authority.handleMutation(host, action, Date.now());
  assert.equal(rejected.terminal, true);
  await authority.forceCheckpoint("replay");
  state.sockets.length = 0;
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  const replay = restored.handleMutation(null, action, Date.now() + 1);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.provisional, false);
  assert.equal(replay.error, rejected.error);
});

test("late join and PLAYER role promotion receive scores on the next question", async () => {
  const { state, authority } = createAuthority(1, fakeD1, 2);
  const host = socketFor(state, "host");
  const late = socketFor(state, "late");
  const p0 = socketFor(state, "p0");
  const now = Date.now();
  authority.handleMutation(late, envelope("late", 1, "joinRoom", { nickname: "Late", role: "PLAYER" }), now);
  authority.handleMutation(host, envelope("host", 1, "updatePlayerRole", { targetPlayerId: "p0", role: "SPECTATOR" }), now + 1);
  authority.getAggregate()!.scores = authority.getAggregate()!.scores.filter((score) => score.playerId !== "p0");
  delete authority.getAggregate()!.scoreBaseline.p0;
  authority.handleMutation(host, envelope("host", 2, "updatePlayerRole", { targetPlayerId: "p0", role: "PLAYER" }), now + 2);
  const skipped = authority.handleMutation(host, envelope("host", 3, "skipCurrentQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0 }), now + 3);
  await authority.forceCheckpoint(skipped.forceCheckpoint ?? "phase-boundary", skipped.archiveQuestion);
  const opened = authority.handleMutation(host, { ...envelope("host", 4, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), questionIndex: 1 }, now + 4);
  await authority.forceCheckpoint(opened.forceCheckpoint ?? "phase-boundary");
  authority.handleMutation(late, { ...envelope("late", 2, "submitAnswer", { playerId: "late", answerText: "a" }), questionIndex: 1 }, now + 5);
  authority.handleMutation(p0, { ...envelope("p0", 1, "submitAnswer", { playerId: "p0", answerText: "a" }), questionIndex: 1 }, now + 6);
  authority.handleMutation(host, { ...envelope("host", 5, "setAnswerJudgements", { presenterPlayerId: "host", judgements: [
    { buzzerAnswerId: "late:2:submitAnswer:b", isCorrect: true },
    { buzzerAnswerId: "p0:1:submitAnswer:b", isCorrect: true },
  ] }), questionIndex: 1 }, now + 4006);
  assert.equal(authority.getSnapshot().scores.find((score) => score.playerId === "late")?.score, 5);
  assert.equal(authority.getSnapshot().scores.find((score) => score.playerId === "p0")?.score, 5);
});

test("deadline actions use the server actor and never consume presenter clientSeq", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  await authority.forceCheckpoint("phase-boundary");
  const deadline = authority.getDeadline();
  assert.ok(deadline);
  await authority.executeDueDeadline(deadline!.runAtMs);
  assert.equal(authority.getAggregate()?.seenSeqByActor.host, 1);
  assert.equal(authority.getAggregate()?.seenSeqByActor.__server__, 1);
});

test("confirm reveal requires a newly revealed block", () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.revealedBlocks = [1];
  const result = authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), Date.now());
  assert.equal(result.terminal, true);
  assert.match(result.error ?? "", /尚未打开/);
});

test("FIRST_CORRECT judgement locks the question for review", async () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "BUZZER_FIRST_CORRECT";
  const host = socketFor(state, "host");
  const p0 = socketFor(state, "p0");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  authority.handleMutation(p0, envelope("p0", 1, "submitBuzzerAnswer", { playerId: "p0", answerText: "ok" }), now + 10);
  const judged = authority.handleMutation(host, envelope("host", 2, "judgeBuzzerAnswer", { presenterPlayerId: "host", buzzerAnswerId: "p0:1:submitBuzzerAnswer", isCorrect: true }), now + 3011);
  assert.equal(judged.forceCheckpoint, "phase-boundary");
  assert.equal(authority.getAggregate()?.gameSession?.revealedBlocks.length, 45);
});

test("RANKED settlement advances only after all chances are resolved", () => {
  const { state, authority } = createAuthority(1);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "BUZZER_RANKED";
  const host = socketFor(state, "host");
  const p0 = socketFor(state, "p0");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  authority.handleMutation(p0, envelope("p0", 1, "submitBuzzerAnswer", { playerId: "p0", answerText: "no" }), now + 10);
  authority.handleMutation(host, envelope("host", 2, "judgeBuzzerAnswer", { presenterPlayerId: "host", buzzerAnswerId: "p0:1:submitBuzzerAnswer", isCorrect: false }), now + 3011);
  authority.handleMutation(host, envelope("host", 3, "settleBuzzerRound", { presenterPlayerId: "host" }), now + 3012);
  assert.equal(authority.getAggregate()?.gameSession?.currentRevealRound, 2);
  assert.equal(authority.getAggregate()?.gameSession?.roundStartedAt, null);
});

test("TEAM_BATTLE skip advances both turn and reveal round", () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "GUESS_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    voteDeadlineAt: new Date(1000).toISOString(), revealVotes: {}, guessVotes: { p0: { type: "skip" } }, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  const host = socketFor(state, "host");
  authority.handleMutation(host, envelope("host", 1, "finalizeTeamBattleVote", { presenterPlayerId: "host" }), 1000);
  assert.equal(authority.getAggregate()?.gameSession?.teamBattleState?.turnNumber, 2);
  assert.equal(authority.getAggregate()?.gameSession?.currentRevealRound, 2);
  assert.equal(authority.getAggregate()?.gameSession?.teamBattleState?.activeTeam, "blue");
});

test("initializing cutover survives restart with its idempotency parameters", async () => {
  const state = new FakeState();
  state.storage.sql.db.exec(`
    CREATE TABLE authority_vnext_active_game (id INTEGER PRIMARY KEY CHECK(id=1),room_id TEXT NOT NULL,game_id TEXT NOT NULL,authority_version INTEGER NOT NULL,schema_version INTEGER NOT NULL,cutover_state TEXT NOT NULL,state_version INTEGER NOT NULL,state_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE authority_vnext_question_archive (game_id TEXT NOT NULL,question_index INTEGER NOT NULL,checkpoint_version INTEGER NOT NULL,state_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(game_id,question_index));
    CREATE TABLE authority_vnext_projection_outbox (id INTEGER PRIMARY KEY CHECK(id=1),payload_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
  `);
  new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1).beginStart("r1", "g1", { startRequestId: "g1", presenterPlayerId: "host", authorityVersion: 2 });
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  assert.deepEqual(restored.getInitializingStart(), { roomId: "r1", gameId: "g1", startParams: { startRequestId: "g1", presenterPlayerId: "host", authorityVersion: 2 } });
});

test("ROUND_REVEAL deadline locks submissions but still allows presenter grading", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  await authority.forceCheckpoint("phase-boundary");
  const deadline = authority.getDeadline();
  assert.ok(deadline);
  await authority.executeDueDeadline(deadline!.runAtMs);
  assert.ok(authority.getAggregate()?.gameSession?.roundStartedAt, "expired round must remain gradeable");
  const graded = authority.handleMutation(host, envelope("host", 2, "gradeAnswersAndAdvance", { presenterPlayerId: "host", correctPlayerIds: [] }), deadline!.runAtMs + 1);
  assert.equal(graded.error, undefined);
  assert.equal(graded.forceCheckpoint, "phase-boundary");
});

test("archive survives an in-flight checkpoint for the same boundary generation", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const outcome = authority.handleMutation(host, envelope("host", 1, "skipCurrentQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0, padding: "x".repeat(100) }), Date.now());
  const budgetCheckpoint = authority.maybeCheckpoint("attachment-budget");
  await authority.forceCheckpoint(outcome.forceCheckpoint ?? "phase-boundary", outcome.archiveQuestion === true);
  await budgetCheckpoint;
  assert.equal(state.storage.sql.db.prepare("SELECT COUNT(*) count FROM authority_vnext_question_archive WHERE game_id='g1' AND question_index=0").get().count, 1);
});

test("archive failure cannot commit an advanced active_game", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const outcome = authority.handleMutation(host, envelope("host", 1, "skipCurrentQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0 }), Date.now());
  state.storage.sql.failOn = "authority_vnext_question_archive";
  await assert.rejects(authority.forceCheckpoint(outcome.forceCheckpoint ?? "phase-boundary", true), /injected migration failure/);
  state.storage.sql.failOn = "";
  state.sockets.length = 0;
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  assert.equal(restored.getAggregate()?.cutoverState, "active");
  assert.equal(restored.getAggregate()?.gameSession?.status, "PLAYING");
});

test("final projection uses a dissolved tombstone and full roster replacement", async () => {
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const d1 = {
    prepare(sql: string) { return { bind(...bindings: unknown[]) { const statement = { sql, bindings }; statements.push(statement); return statement; } }; },
    async batch() { return []; },
  } as unknown as D1Database;
  const first = createAuthority(1, d1);
  const host = socketFor(first.state, "host");
  first.authority.handleMutation(host, envelope("host", 1, "returnRoomToLobby", { hostPlayerId: "host" }), Date.now());
  await first.authority.forceCheckpoint("projection");
  await first.authority.flushFinalProjection();
  assert.ok(statements.some((statement) => /DELETE FROM players WHERE room_id/.test(statement.sql)));
  const playerInsert = statements.filter((statement) => /INSERT INTO players/.test(statement.sql));
  assert.equal(playerInsert.length, 1);
  assert.match(playerInsert[0].sql, /json_each/);
  assert.equal(JSON.parse(String(playerInsert[0].bindings[0])).length, 2);

  statements.length = 0;
  const second = createAuthority(1, d1);
  const secondHost = socketFor(second.state, "host");
  second.authority.handleMutation(secondHost, envelope("host", 1, "dissolveRoom", { hostPlayerId: "host" }), Date.now());
  await second.authority.forceCheckpoint("game-end");
  await second.authority.flushFinalProjection();
  assert.ok(statements.some((statement) => /DELETE FROM rooms WHERE id/.test(statement.sql)));
  assert.ok(statements.findIndex((statement) => /UPDATE questions SET/.test(statement.sql)) < statements.findIndex((statement) => /DELETE FROM rooms/.test(statement.sql)));
});

test("D1 projection failure retains the aggregate outbox until a later retry succeeds", async () => {
  let shouldFail = true;
  const d1 = {
    prepare(sql: string) { return { bind(...bindings: unknown[]) { return { sql, bindings }; } }; },
    async batch() {
      if (shouldFail) throw new Error("temporary D1 outage");
      return [];
    },
  } as unknown as D1Database;
  const { state, authority } = createAuthority(1, d1);
  const host = socketFor(state, "host");
  const outcome = authority.handleMutation(host, envelope("host", 1, "returnRoomToLobby", { hostPlayerId: "host" }), Date.now());
  await authority.forceCheckpoint(outcome.forceCheckpoint ?? "projection");
  assert.equal(await authority.flushFinalProjection(), false);
  assert.equal(authority.canStartAnotherGame(), true);
  assert.equal(state.storage.sql.db.prepare("SELECT COUNT(*) count FROM authority_vnext_projection_outbox").get().count, 1);
  shouldFail = false;
  assert.equal(await authority.flushFinalProjection(), true);
  assert.equal(state.storage.sql.db.prepare("SELECT COUNT(*) count FROM authority_vnext_projection_outbox").get().count, 0);
});

test("final participants retain scored players after leaving or becoming spectators", async () => {
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const d1 = {
    prepare(sql: string) { return { bind(...bindings: unknown[]) { const statement = { sql, bindings }; statements.push(statement); return statement; } }; },
    async batch() { return []; },
  } as unknown as D1Database;
  const { state, authority } = createAuthority(2, d1);
  const host = socketFor(state, "host");
  const p0 = socketFor(state, "p0");
  const p1 = socketFor(state, "p1");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  authority.handleMutation(p0, envelope("p0", 1, "submitAnswer", { playerId: "p0", answerText: "a" }), now + 1);
  authority.handleMutation(p1, envelope("p1", 1, "submitAnswer", { playerId: "p1", answerText: "a" }), now + 2);
  authority.handleMutation(host, envelope("host", 2, "setAnswerJudgements", { presenterPlayerId: "host", judgements: [
    { buzzerAnswerId: "p0:1:submitAnswer:b", isCorrect: true },
    { buzzerAnswerId: "p1:1:submitAnswer:b", isCorrect: true },
  ] }), now + 4000);
  authority.handleMutation(p0, envelope("p0", 2, "leaveRoom", { playerId: "p0" }), now + 4001);
  authority.handleMutation(host, envelope("host", 3, "updatePlayerRole", { targetPlayerId: "p1", role: "SPECTATOR" }), now + 4002);
  const ended = authority.handleMutation(host, envelope("host", 4, "returnRoomToLobby", { hostPlayerId: "host" }), now + 4003);
  await authority.forceCheckpoint(ended.forceCheckpoint ?? "projection");
  await authority.flushFinalProjection();
  const participantInsert = statements.find((statement) => /INSERT INTO game_participants/.test(statement.sql));
  assert.ok(participantInsert);
  const participants = JSON.parse(String(participantInsert.bindings[1])) as Player[];
  assert.deepEqual(participants.filter((player) => player.id === "p0" || player.id === "p1").map((player) => [player.id, player.role]).sort(), [["p0", "PLAYER"], ["p1", "PLAYER"]]);
});

test("vNext mutations never append legacy journal or normalized hot rows", async () => {
  const { state, authority } = createAuthority(2);
  state.storage.sql.db.exec(`
    CREATE TABLE mutation_journal(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE processed_actions(action_id TEXT PRIMARY KEY);
    CREATE TABLE game_answers(id TEXT PRIMARY KEY);
    CREATE TABLE buzzer_answers(id TEXT PRIMARY KEY);
  `);
  const host = socketFor(state, "host");
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), Date.now());
  authority.handleMutation(socketFor(state, "p0"), envelope("p0", 1, "submitAnswer", { playerId: "p0", answerText: "a" }), Date.now() + 1);
  authority.handleMutation(host, envelope("host", 2, "setAnswerJudgements", { presenterPlayerId: "host", judgements: [{ buzzerAnswerId: "p0:1:submitAnswer:b", isCorrect: true }] }), Date.now() + 4000);
  for (const table of ["mutation_journal", "processed_actions", "game_answers", "buzzer_answers"]) {
    assert.equal(state.storage.sql.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0, table);
  }
});

test("realtime authority source has no heartbeat, keepalive, or periodic checkpoint mechanism", () => {
  const client = readFileSync(new URL("../src/lib/cloudflareClient.ts", import.meta.url), "utf8");
  const authority = readFileSync(new URL("../worker/roomAuthorityVNext.ts", import.meta.url), "utf8");
  assert.doesNotMatch(client, /heartbeat|\bping\b|\bpong\b/i);
  assert.doesNotMatch(authority, /setInterval|setTimeout|setAlarm|heartbeat|\bping\b|\bpong\b/i);
});

test("50 players complete 30 questions within the vNext write budget", async () => {
  const projectionBatches: Array<Array<{ sql: string; bindings: unknown[] }>> = [];
  const projectionD1 = {
    prepare(sql: string) { return { bind(...bindings: unknown[]) { return { sql, bindings }; } }; },
    async batch(statements: Array<{ sql: string; bindings: unknown[] }>) { projectionBatches.push(statements); return []; },
  } as unknown as D1Database;
  const { state, authority } = createAuthority(50, projectionD1, 30);
  const host = socketFor(state, "host");
  const players = Array.from({ length: 50 }, (_, index) => ({ id: `p${index}`, socket: socketFor(state, `p${index}`) }));
  let hostSeq = 0;
  let actionCount = 0;
  let broadcastCount = 0;
  let broadcastBytes = 0;
  let maxAttachmentBytes = 0;
  let maxAttachmentTotalBytes = 0;
  let maxDeltaBytes = 0;
  let maxDeltaType = "";
  let maxDeltaStats: unknown = null;
  const judgementLatencies: number[] = [];
  let finalSnapshotResultCount = 0;
  const started = Date.now();
  for (let questionIndex = 0; questionIndex < 30; questionIndex += 1) {
    const base = started + questionIndex * 10_000;
    hostSeq += 1;
    const opened = authority.handleMutation(host, { ...envelope("host", hostSeq, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [questionIndex % 45] }), questionIndex }, base);
    actionCount += 1;
    await authority.forceCheckpoint(opened.forceCheckpoint ?? "phase-boundary");
    for (const player of players) {
      const submitted = authority.handleMutation(player.socket, { ...envelope(player.id, questionIndex + 1, "submitAnswer", { playerId: player.id, answerText: `answer-${questionIndex}` }), questionIndex }, base + 100);
      actionCount += 1;
      const payloadBytes = JSON.stringify(submitted.presenterDeltas).length;
      broadcastCount += submitted.presenterDeltas.length;
      broadcastBytes += payloadBytes;
      for (const delta of submitted.presenterDeltas) { const bytes = JSON.stringify(delta).length; if (bytes > maxDeltaBytes) { maxDeltaBytes = bytes; maxDeltaType = delta.type; } }
      await authority.maybeCheckpoint();
    }
    let diagnostics = authority.getDiagnostics();
    maxAttachmentBytes = Math.max(maxAttachmentBytes, diagnostics.maxAttachmentBytes);
    maxAttachmentTotalBytes = Math.max(maxAttachmentTotalBytes, diagnostics.attachmentBytes);
    for (const player of players) {
      hostSeq += 1;
      const before = performance.now();
      const judged = authority.handleMutation(host, { ...envelope("host", hostSeq, "setAnswerJudgements", { presenterPlayerId: "host", judgements: [{ buzzerAnswerId: `${player.id}:${questionIndex + 1}:submitAnswer:b`, isCorrect: true }] }), questionIndex }, base + 3200);
      judgementLatencies.push(performance.now() - before);
      actionCount += 1;
      broadcastCount += judged.presenterDeltas.length + judged.playerDeltas.length;
      broadcastBytes += JSON.stringify(judged.presenterDeltas).length + JSON.stringify(judged.playerDeltas).length;
      for (const delta of [...judged.presenterDeltas, ...judged.playerDeltas.map((delivery) => delivery.delta)]) { const bytes = JSON.stringify(delta).length; if (bytes > maxDeltaBytes) { maxDeltaBytes = bytes; maxDeltaType = delta.type; maxDeltaStats = delta.type === "answer_judgements_changed" ? { answers: delta.answers.length, scores: delta.scores.length, results: delta.questionResults.length, hasSession: Boolean(delta.gameSession) } : null; } }
      await authority.maybeCheckpoint();
    }
    hostSeq += 1;
    const graded = authority.handleMutation(host, { ...envelope("host", hostSeq, "gradeAnswersAndAdvance", { presenterPlayerId: "host", correctPlayerIds: players.map((player) => player.id) }), questionIndex }, base + 3300);
    actionCount += 1;
    await authority.forceCheckpoint(graded.forceCheckpoint ?? "phase-boundary");
    hostSeq += 1;
    const advanced = authority.handleMutation(host, { ...envelope("host", hostSeq, "advanceReviewedQuestion", { presenterPlayerId: "host", expectedQuestionIndex: questionIndex }), questionIndex }, base + 3400);
    actionCount += 1;
    const finalSnapshot = advanced.publicDeltas.find((delta) => delta.type === "game_result_snapshot");
    if (finalSnapshot?.type === "game_result_snapshot") finalSnapshotResultCount = finalSnapshot.snapshot.questionResults.length;
    if (advanced.forceCheckpoint === "game-end") authority.prepareFinalResultsFromArchives();
    await authority.forceCheckpoint(advanced.forceCheckpoint ?? "phase-boundary", advanced.archiveQuestion === true);
    diagnostics = authority.getDiagnostics();
    maxAttachmentBytes = Math.max(maxAttachmentBytes, diagnostics.maxAttachmentBytes);
    maxAttachmentTotalBytes = Math.max(maxAttachmentTotalBytes, diagnostics.attachmentBytes);
  }
  const diagnostics = authority.getDiagnostics();
  const d1WritesDuringGame = diagnostics.d1Writes;
  assert.equal(await authority.flushFinalProjection(), true);
  const finalProjectionStatements = projectionBatches[0] ?? [];
  const restoredStarted = performance.now();
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  const restoreMs = performance.now() - restoredStarted;
  judgementLatencies.sort((left, right) => left - right);
  const judgementP95 = judgementLatencies[Math.floor(judgementLatencies.length * 0.95)] ?? 0;
  const report = {
    players: 50,
    questions: 30,
    totalActions: actionCount,
    checkpoints: diagnostics.checkpoints,
    checkpointTriggers: diagnostics.checkpointTriggers,
    estimatedDoSqlChangedRows: diagnostics.checkpointChangedRows,
    d1ReadsDuringGame: diagnostics.d1Reads,
    d1WritesDuringGame,
    finalProjectionStatements: finalProjectionStatements.length,
    broadcastCount,
    broadcastBytes,
    maxActiveGameBytes: diagnostics.maxActiveGameBytes,
    maxAttachmentBytes,
    maxAttachmentTotalBytes,
    maxDeltaBytes,
    maxDeltaType,
    maxDeltaStats,
    hibernationRestoreMs: restoreMs,
    judgementVisibleHandlerP95Ms: judgementP95,
  };
  console.info(JSON.stringify({ event: "authority_vnext_load_result", ...report }));
  assert.equal(actionCount, 3090);
  assert.ok(diagnostics.checkpointChangedRows >= 150 && diagnostics.checkpointChangedRows <= 300, JSON.stringify(report));
  assert.equal(d1WritesDuringGame, 0);
  assert.equal(finalSnapshotResultCount, 1500);
  assert.ok(finalProjectionStatements.length <= 50, JSON.stringify(report));
  assert.ok(finalProjectionStatements.some((statement) => /INSERT INTO game_participants/.test(statement.sql) && /json_each/.test(statement.sql)));
  assert.ok(finalProjectionStatements.some((statement) => /INSERT OR IGNORE INTO completed_question_set_plays/.test(statement.sql)));
  assert.ok(finalProjectionStatements.some((statement) => /INSERT INTO question_results/.test(statement.sql) && /json_each/.test(statement.sql)));
  assert.ok(
    authority
      .getSnapshot()
      .scores.filter((score) => score.playerId !== "host")
      .every((score) => score.score === 150 && score.correctCount === 30),
  );
  assert.ok(maxAttachmentBytes < ATTACHMENT_BUDGET_BYTES);
  assert.ok(maxAttachmentTotalBytes <= 100 * 1024);
  assert.ok(maxDeltaBytes < 1024, JSON.stringify(report));
  assert.ok(restoreMs < 250);
  assert.ok(judgementP95 <= 150);
});

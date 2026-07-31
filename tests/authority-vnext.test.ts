import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { RoomGameAuthority } from "../worker/roomGameAuthority";
import { ATTACHMENT_BUDGET_BYTES, RoomAuthorityVNext, type VNextMutationEnvelope, type VNextSocketAttachment } from "../worker/roomAuthorityVNext";
import { decodeQuestionSetManifest, encodeQuestionSetManifest } from "../worker/questionSetManifest";
import { removePlayerFromTeamBattleState } from "../worker/gameService";
import { getBuzzerAnswerStabilityDelayMs, getRemainingSeconds, isBuzzerAnswerReadyForJudging, isGameSessionPositionStale, shouldAcceptServerClock } from "../src/components/ImageRevealGame";
import type { DbQuestionSet, GameSession, Player, Question, QuestionSet, Room } from "../src/types/game";

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

class SqliteProjectionStatement {
  bindings: unknown[] = [];
  constructor(readonly db: DatabaseSync, readonly sql: string) {}
  bind(...bindings: unknown[]) { this.bindings = bindings; return this; }
  run() { this.db.prepare(this.sql).run(...this.bindings); }
  first<T>() { return (this.db.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null; }
}

class SqliteProjectionD1 {
  readonly db = new DatabaseSync(":memory:");
  batchCalls = 0;
  failNextBatch = false;

  constructor() {
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE rooms(id TEXT PRIMARY KEY,room_code TEXT NOT NULL UNIQUE,host_player_id TEXT NOT NULL,game_status TEXT NOT NULL,current_game_id TEXT,updated_at TEXT NOT NULL,lobby_team_assignment_mode TEXT NOT NULL DEFAULT 'AUTO',lobby_team_assignments TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE players(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,nickname TEXT NOT NULL,is_host INTEGER NOT NULL,joined_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,role TEXT NOT NULL);
      CREATE UNIQUE INDEX players_room_nickname_unique ON players(room_id,lower(nickname));
      CREATE INDEX players_room_id_idx ON players(room_id);
      CREATE INDEX players_room_role_idx ON players(room_id,role);
      CREATE TABLE questions(id TEXT PRIMARY KEY,label_text TEXT,label_source TEXT,label_source_answer_id TEXT,label_updated_by_player_id TEXT,label_updated_at TEXT);
      CREATE TABLE question_sets(id TEXT PRIMARY KEY,manifest_version INTEGER,manifest_revision INTEGER NOT NULL DEFAULT 0,manifest_json TEXT);
      CREATE TABLE game_sessions(id TEXT PRIMARY KEY,status TEXT NOT NULL,current_question_index INTEGER NOT NULL,current_reveal_round INTEGER NOT NULL,revealed_blocks TEXT NOT NULL,team_battle_state TEXT,round_started_at TEXT,ended_at TEXT,completed_normally_at TEXT);
      CREATE TABLE completed_question_set_plays(game_session_id TEXT PRIMARY KEY,question_set_id TEXT NOT NULL,completed_at TEXT NOT NULL);
      CREATE TABLE game_result_archives(game_session_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,question_set_id TEXT NOT NULL,archive_version INTEGER NOT NULL,completed_at TEXT NOT NULL,result_json TEXT NOT NULL);
      CREATE TABLE player_write_audit(kind TEXT NOT NULL,player_id TEXT NOT NULL);
      CREATE TRIGGER audit_player_insert AFTER INSERT ON players BEGIN INSERT INTO player_write_audit VALUES('insert',new.id); END;
      CREATE TRIGGER audit_player_update AFTER UPDATE ON players BEGIN INSERT INTO player_write_audit VALUES('update',new.id); END;
      CREATE TRIGGER audit_player_delete AFTER DELETE ON players BEGIN INSERT INTO player_write_audit VALUES('delete',old.id); END;
    `);
  }

  prepare(sql: string) { return new SqliteProjectionStatement(this.db, sql); }

  async batch(statements: D1PreparedStatement[]) {
    this.batchCalls += 1;
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error("injected projection batch failure");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements as unknown as SqliteProjectionStatement[]) statement.run();
      this.db.exec("COMMIT");
      return [];
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function createSqliteProjectionAuthority(playerCount: number, questionCount = 1) {
  const d1 = new SqliteProjectionD1();
  const created = createAuthority(playerCount, d1 as unknown as D1Database, questionCount);
  const aggregate = created.authority.getAggregate()!;
  const fixedLastSeenAt = "2026-07-28T00:00:00.000Z";
  for (const player of aggregate.players) player.lastSeenAt = fixedLastSeenAt;
  aggregate.room!.players = aggregate.players;
  d1.db.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status,current_game_id,updated_at) VALUES(?,?,?,?,?,?)").run("r1", "ROOM01", "host", "PLAYING", "g1", fixedLastSeenAt);
  for (const player of aggregate.players) {
    d1.db.prepare("INSERT INTO players VALUES(?,?,?,?,?,?,?)").run(
      player.id,
      player.roomId,
      player.nickname,
      player.isHost ? 1 : 0,
      typeof player.joinedAt === "number" ? new Date(player.joinedAt).toISOString() : player.joinedAt,
      player.lastSeenAt,
      player.role,
    );
  }
  for (const question of aggregate.questions) d1.db.prepare("INSERT INTO questions(id) VALUES(?)").run(question.id);
  d1.db.prepare("INSERT INTO game_sessions VALUES(?,?,?,?,?,?,?,?,?)").run("g1", "PLAYING", 0, 1, "[]", null, null, null, null);
  d1.db.exec("DELETE FROM player_write_audit");
  return { ...created, d1 };
}

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

function teamVoteFallbackPayload(session: GameSession) {
  const state = session.teamBattleState;
  assert.ok(state);
  assert.ok(state.phase === "REVEAL_VOTE" || state.phase === "GUESS_VOTE");
  assert.ok(state.voteDeadlineAt);
  return {
    presenterPlayerId: session.presenterPlayerId,
    expectedPhase: state.phase,
    expectedTurnNumber: state.turnNumber,
    expectedVoteDeadlineAt: state.voteDeadlineAt,
  };
}

function createAuthority(playerCount = 50, d1: D1Database = fakeD1, questionCount = 1, random: () => number = Math.random) {
  const state = new FakeState();
  state.storage.sql.db.exec(`
    CREATE TABLE authority_vnext_active_game (id INTEGER PRIMARY KEY CHECK(id=1),room_id TEXT NOT NULL,game_id TEXT NOT NULL,authority_version INTEGER NOT NULL,schema_version INTEGER NOT NULL,cutover_state TEXT NOT NULL,state_version INTEGER NOT NULL,state_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE authority_vnext_question_archive (game_id TEXT NOT NULL,question_index INTEGER NOT NULL,checkpoint_version INTEGER NOT NULL,state_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(game_id,question_index));
    CREATE TABLE authority_vnext_projection_outbox (id INTEGER PRIMARY KEY CHECK(id=1),payload_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
  `);
  const authority = new RoomAuthorityVNext(state as unknown as DurableObjectState, d1, random);
  authority.beginStart("r1", "g1", { startRequestId: "g1" });
  authority.activateStart(bootstrap(playerCount, questionCount));
  return { state, authority };
}

function enterReview(authority: RoomAuthorityVNext) {
  const session = authority.getAggregate()!.gameSession!;
  session.revealedBlocks = Array.from({ length: 45 }, (_, index) => index);
  session.roundStartedAt = null;
}

test("v6 upgrades atomically through v10 and repeated initialization is idempotent", () => {
  const storage = new StorageAdapter();
  storage.sql.db.exec(`
    CREATE TABLE authority_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT INTO authority_schema VALUES(1,6);
    CREATE TABLE question_sets(id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE rooms(id TEXT PRIMARY KEY);
  `);
  const authority = new RoomGameAuthority(storage as unknown as DurableObjectStorage, fakeD1);
  authority.initializeSchema();
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 10);
  authority.initializeSchema();
  assert.equal(storage.sql.db.prepare("SELECT COUNT(*) count FROM authority_vnext_active_game").get().count, 0);
  assert.equal(storage.sql.db.prepare("SELECT COUNT(*) count FROM pragma_table_info('question_sets') WHERE name='creation_method'").get().count, 1);
  assert.equal(storage.sql.db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_team_reveal_vote_seconds'").get().count, 1);
  assert.equal(storage.sql.db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_team_guess_vote_seconds'").get().count, 1);
  assert.equal(storage.sql.db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_team_assignment_mode'").get().count, 1);
  assert.equal(storage.sql.db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_team_assignments'").get().count, 1);
});

test("migration failure does not advance production v6", () => {
  const storage = new StorageAdapter();
  storage.sql.db.exec("CREATE TABLE authority_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO authority_schema VALUES(1,6)");
  storage.sql.failOn = "authority_vnext_question_archive";
  const authority = new RoomGameAuthority(storage as unknown as DurableObjectStorage, fakeD1);
  assert.throws(() => authority.initializeSchema(), /injected migration failure/);
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 6);
});

test("fresh schema reaches v10", () => {
  const storage = new StorageAdapter();
  new RoomGameAuthority(storage as unknown as DurableObjectStorage, fakeD1).initializeSchema();
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 10);
  assert.equal(storage.sql.db.prepare("SELECT COUNT(*) count FROM pragma_table_info('authority_vnext_projection_outbox') WHERE name='payload_json'").get().count, 1);
  assert.equal(storage.sql.db.prepare("SELECT COUNT(*) count FROM pragma_table_info('question_sets') WHERE name='creation_method'").get().count, 1);
});

test("v7 question-set migration preserves rows and failure does not advance the schema version", () => {
  const storage = new StorageAdapter();
  storage.sql.db.exec(`
    CREATE TABLE authority_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT INTO authority_schema VALUES(1,7);
    CREATE TABLE question_sets(id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE rooms(id TEXT PRIMARY KEY);
    INSERT INTO question_sets VALUES('set-1','Legacy');
  `);
  storage.sql.failOn = "ALTER TABLE question_sets";
  const authority = new RoomGameAuthority(storage as unknown as DurableObjectStorage, fakeD1);
  assert.throws(() => authority.initializeSchema(), /injected migration failure/);
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 7);

  storage.sql.failOn = "";
  authority.initializeSchema();
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 10);
  assert.equal(storage.sql.db.prepare("SELECT title FROM question_sets WHERE id='set-1'").get().title, "Legacy");
  assert.equal(storage.sql.db.prepare("SELECT creation_method FROM question_sets WHERE id='set-1'").get().creation_method, null);
});

test("v8 team vote duration migration preserves rooms, Alarm, and failure does not advance the schema version", async () => {
  const storage = new StorageAdapter();
  storage.sql.db.exec(`
    CREATE TABLE authority_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT INTO authority_schema VALUES(1,8);
    CREATE TABLE rooms(id TEXT PRIMARY KEY, room_code TEXT NOT NULL);
    INSERT INTO rooms VALUES('r1','ROOM01');
  `);
  await storage.setAlarm(456_789);
  storage.sql.failOn = "lobby_team_guess_vote_seconds";
  const authority = new RoomGameAuthority(storage as unknown as DurableObjectStorage, fakeD1);
  assert.throws(() => authority.initializeSchema(), /injected migration failure/);
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 8);

  storage.sql.failOn = "";
  authority.initializeSchema();
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 10);
  const room = storage.sql.db.prepare("SELECT * FROM rooms WHERE id='r1'").get();
  assert.equal(room.room_code, "ROOM01");
  assert.equal(room.lobby_team_reveal_vote_seconds, 15);
  assert.equal(room.lobby_team_guess_vote_seconds, 50);
  assert.equal(await storage.getAlarm(), 456_789);
});

test("v9 manual-team migration preserves rooms and Alarm, and failure does not advance", async () => {
  const storage = new StorageAdapter();
  storage.sql.db.exec(`
    CREATE TABLE authority_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT INTO authority_schema VALUES(1,9);
    CREATE TABLE rooms(id TEXT PRIMARY KEY, room_code TEXT NOT NULL);
    INSERT INTO rooms VALUES('r1','ROOM01');
  `);
  await storage.setAlarm(987_654);
  storage.sql.failOn = "lobby_team_assignments";
  const authority = new RoomGameAuthority(storage as unknown as DurableObjectStorage, fakeD1);
  assert.throws(() => authority.initializeSchema(), /injected migration failure/);
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 9);
  storage.sql.failOn = "";
  authority.initializeSchema();
  const room = storage.sql.db.prepare("SELECT * FROM rooms WHERE id='r1'").get();
  assert.equal(storage.sql.db.prepare("SELECT version FROM authority_schema WHERE id=1").get().version, 10);
  assert.equal(room.lobby_team_assignment_mode, "AUTO");
  assert.equal(room.lobby_team_assignments, "{}");
  assert.equal(await storage.getAlarm(), 987_654);
});

test("v6 journal and existing business Alarm survive the additive upgrade", async () => {
  const storage = new StorageAdapter();
  storage.sql.db.exec(`
    CREATE TABLE authority_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT INTO authority_schema VALUES(1,6);
    CREATE TABLE mutation_journal(id INTEGER PRIMARY KEY CHECK(id=1),room_id TEXT NOT NULL,name TEXT NOT NULL,action_key TEXT,started_at INTEGER NOT NULL);
    INSERT INTO mutation_journal VALUES(1,'r1','submitAnswer','a1',123);
    CREATE TABLE question_sets(id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE rooms(id TEXT PRIMARY KEY);
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

test("answer progress is public without exposing answer text", () => {
  const { state, authority } = createAuthority(2);
  const host = socketFor(state, "host");
  const player = socketFor(state, "p0");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);

  const submitted = authority.handleMutation(player, envelope("p0", 1, "submitAnswer", { playerId: "p0", answerText: "secret-answer" }), now + 1);
  const submittedProgress = submitted.publicDeltas.find((delta) => delta.type === "answer_progress_changed");
  assert.ok(submittedProgress && submittedProgress.type === "answer_progress_changed");
  assert.deepEqual(submittedProgress.answers.map((answer) => answer.playerId), ["p0"]);
  assert.deepEqual(submittedProgress.buzzerAnswers.map((answer) => [answer.playerId, answer.status]), [["p0", "pending"]]);
  assert.equal(JSON.stringify(submittedProgress).includes("secret-answer"), false);
  assert.ok(JSON.stringify(submittedProgress).length < 1024);
  assert.equal(submitted.spectatorDeltas?.length, 1);
  assert.equal(JSON.stringify(submitted.spectatorDeltas).includes("secret-answer"), true);

  const judged = authority.handleMutation(host, envelope("host", 2, "setAnswerJudgements", {
    presenterPlayerId: "host",
    judgements: [{ buzzerAnswerId: "p0:1:submitAnswer:b", isCorrect: true }],
  }), now + 4000);
  const judgedProgress = judged.publicDeltas.find((delta) => delta.type === "answer_progress_changed");
  assert.ok(judgedProgress && judgedProgress.type === "answer_progress_changed");
  assert.deepEqual(judgedProgress.buzzerAnswers.map((answer) => [answer.playerId, answer.status]), [["p0", "correct"]]);
  assert.equal(judgedProgress.scores.find((score) => score.playerId === "p0")?.score, 5);
  assert.equal(judgedProgress.questionResults.some((result) => result.playerId === "p0"), true);
  assert.equal(JSON.stringify(judgedProgress).includes("secret-answer"), false);
  assert.ok(JSON.stringify(judgedProgress).length < 1024);
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
  enterReview(authority);
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
  enterReview(authority);
  authority.handleMutation(null, envelope("p0", 1, "joinRoom", { nickname: "P0", role: "PLAYER" }), Date.now() - 1);
  await authority.forceCheckpoint("phase-boundary");
  authority.handleMutation(host, envelope("host", 1, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "pending", source: "manual" }), Date.now());
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  assert.equal(restored.getAggregate()?.questions[0].labelText, "pending");
  assert.equal(restored.getAggregate()?.seenSeqByActor.host, 1);
});

test("50 dirty closes merge to one aggregate checkpoint", async () => {
  const { state, authority } = createAuthority(1);
  const sockets: WebSocket[] = [];
  enterReview(authority);
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
  enterReview(authority);
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
  enterReview(authority);
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

test("committed advance and skip duplicates return current state after restart without reapplying", async () => {
  for (const name of ["advanceReviewedQuestion", "skipCurrentQuestion"] as const) {
    const { state, authority } = createAuthority(1, fakeD1, 2);
    const host = socketFor(state, "host");
    if (name === "advanceReviewedQuestion") enterReview(authority);
    const action = envelope("host", 1, name, { presenterPlayerId: "host", expectedQuestionIndex: 0 });
    const first = authority.handleMutation(host, action, Date.now());
    assert.equal(first.forceCheckpoint, "phase-boundary");
    await authority.forceCheckpoint(first.forceCheckpoint!, first.archiveQuestion);
    const archiveWrites = state.storage.sql.archiveWrites;
    const activeWrites = state.storage.sql.activeWrites;

    state.sockets.length = 0;
    const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
    await restored.restoreFromStorage();
    const replay = restored.handleMutation(null, action, Date.now() + 1);
    const replayData = replay.data as { gameSession?: GameSession; room?: Room | null };
    assert.equal(replay.duplicate, true);
    assert.equal(replay.provisional, false);
    assert.equal(replayData.gameSession?.currentQuestionIndex, 1);
    assert.equal(replayData.gameSession?.status, "PLAYING");
    assert.equal(replayData.room?.currentGameId, "g1");
    assert.equal(restored.getAggregate()?.gameSession?.currentQuestionIndex, 1);
    assert.equal(state.storage.sql.archiveWrites, archiveWrites);
    assert.equal(state.storage.sql.activeWrites, activeWrites);
  }
});

test("every committed mutation duplicate preserves its public top-level RPC contract", async () => {
  const { state, authority } = createAuthority(2, fakeD1, 2);
  const aggregate = authority.getAggregate()!;
  aggregate.answers.push({ id: "preserved-answer", gameSessionId: "g1", questionIndex: 0, revealRound: 1, playerId: "p0", answerText: "current", submittedAt: new Date().toISOString() });
  aggregate.buzzerAnswers.push({ id: "preserved-answer:b", gameSessionId: "g1", questionIndex: 0, revealRound: 1, playerId: "p0", answerText: "current", status: "pending", scoreAwarded: 0, submittedAt: new Date().toISOString(), serverReceivedAt: new Date().toISOString() });
  authority.handleMutation(null, envelope("p0", 1, "joinRoom", { nickname: "P0", role: "PLAYER" }), Date.now());
  aggregate.seenSeqByActor.host = 100;
  aggregate.seenSeqByActor.p0 = 100;
  await authority.forceCheckpoint("phase-boundary");
  state.sockets.length = 0;
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  const before = {
    activeWrites: state.storage.sql.activeWrites,
    archiveWrites: state.storage.sql.archiveWrites,
    state: JSON.stringify(restored.getAggregate()),
  };

  const isGameSession = (value: unknown) => Boolean(value && typeof value === "object" && (value as { id?: string }).id === "g1");
  const isRoom = (value: unknown) => Boolean(value && typeof value === "object" && (value as { code?: string }).code === "ROOM01");
  const cases: Array<{ name: string; actorId?: string; actionId?: string; payload?: Record<string, unknown>; validate: (data: unknown) => void }> = [
    { name: "confirmRevealBlocks", validate: (data) => { assert.ok(isGameSession(data)); assert.equal("gameSession" in (data as object), false); } },
    { name: "submitAnswer", actorId: "p0", actionId: "edit-action", payload: { answerText: "edited" }, validate: (data) => { const value = data as { id: string; buzzerAnswer?: { id: string } }; assert.equal(value.id, "preserved-answer"); assert.equal(value.buzzerAnswer?.id, "preserved-answer:b"); } },
    { name: "submitForfeitAnswer", actorId: "p0", actionId: "forfeit-action", validate: (data) => assert.equal((data as { id?: string }).id, "preserved-answer") },
    { name: "cancelForfeitAnswer", actorId: "p0", validate: (data) => { const value = data as { gameSession?: GameSession; canceledAnswerId?: string }; assert.ok(isGameSession(value.gameSession)); assert.ok(value.canceledAnswerId); } },
    { name: "submitBuzzerAnswer", actorId: "p0", validate: (data) => assert.equal((data as { id?: string }).id, "preserved-answer:b") },
    { name: "judgeBuzzerAnswer", payload: { buzzerAnswerId: "preserved-answer:b", isCorrect: true }, validate: (data) => { const value = data as { gameSession?: GameSession; judgedAnswer?: unknown; scores?: unknown[]; questionResults?: unknown[]; buzzerAnswers?: unknown[] }; assert.ok(isGameSession(value.gameSession)); assert.ok(value.judgedAnswer); assert.ok(Array.isArray(value.scores)); assert.ok(Array.isArray(value.questionResults)); assert.ok(Array.isArray(value.buzzerAnswers)); } },
    ...["setAnswerJudgements", "markPendingRoundAnswersWrong"].map((name) => ({ name, validate: (data: unknown) => { const value = data as { gameSession?: GameSession; judgedAnswers?: unknown[]; scores?: unknown[]; questionResults?: unknown[] }; assert.ok(isGameSession(value.gameSession)); assert.ok(Array.isArray(value.judgedAnswers)); assert.ok(Array.isArray(value.scores)); assert.ok(Array.isArray(value.questionResults)); } })),
    ...["settleBuzzerRound", "autoForfeitExpiredRound", "completeTeamBattleBlockSelection", "finalizeTeamBattleVote", "judgeTeamBattleGuess", "advanceTeamBattleTurn", "revealTeamBattleAnswer"].map((name) => ({ name, validate: (data: unknown) => assert.ok(isGameSession((data as { gameSession?: GameSession }).gameSession)) })),
    { name: "gradeAnswersAndAdvance", payload: { correctPlayerIds: ["p0"] }, validate: (data) => { const value = data as { gameSession?: GameSession; room?: Room | null; newlyScoredPlayerIds?: string[] }; assert.ok(isGameSession(value.gameSession)); assert.ok(value.room === null || isRoom(value.room)); assert.ok(Array.isArray(value.newlyScoredPlayerIds)); } },
    ...["submitTeamBattleRevealVote", "submitTeamBattleGuessVote"].map((name) => ({ name, validate: (data: unknown) => { assert.ok(isGameSession(data)); assert.equal("gameSession" in (data as object), false); } })),
    ...["advanceReviewedQuestion", "skipCurrentQuestion"].map((name) => ({ name, validate: (data: unknown) => { const value = data as { gameSession?: GameSession; room?: Room | null }; assert.ok(isGameSession(value.gameSession)); assert.ok(value.room === null || isRoom(value.room)); } })),
    { name: "endCurrentGameEarly", validate: (data) => { const value = data as { gameSession?: GameSession; room?: Room }; assert.ok(isGameSession(value.gameSession)); assert.ok(isRoom(value.room)); } },
    { name: "updateQuestionLabel", payload: { questionId: "q1" }, validate: (data) => assert.equal((data as { id?: string }).id, "q1") },
    { name: "joinRoom", validate: (data) => { const value = data as { room?: Room | null; error?: string | null; errorCode?: string | null }; assert.ok(value.room === null || isRoom(value.room)); assert.equal(value.error, null); assert.equal(value.errorCode, null); } },
    { name: "leaveRoom", actorId: "p0", validate: (data) => assert.ok(data === null || isRoom(data)) },
    ...["kickPlayerFromRoom", "updatePlayerRole", "cancelCurrentRound", "returnRoomToLobby"].map((name) => ({ name, validate: (data: unknown) => assert.ok(isRoom(data)) })),
    { name: "dissolveRoom", validate: (data) => assert.equal(data, null) },
  ];
  assert.equal(cases.length, 29);

  for (const [index, contract] of cases.entries()) {
    const actorId = contract.actorId ?? "host";
    const action = { ...envelope(actorId, 1, contract.name, contract.payload ?? {}, contract.actionId ?? `duplicate-${index}`), questionIndex: 0 };
    const replay = restored.handleMutation(null, action, Date.now() + index + 1);
    assert.equal(replay.duplicate, true, contract.name);
    assert.equal(replay.provisional, false, contract.name);
    contract.validate(replay.data);
  }

  assert.equal(state.storage.sql.activeWrites, before.activeWrites);
  assert.equal(state.storage.sql.archiveWrites, before.archiveWrites);
  assert.equal(JSON.stringify(restored.getAggregate()), before.state);
});

test("committed answer duplicates recover edited and forfeited entity ids and archived-safe shapes", async () => {
  const { state, authority } = createAuthority(1, fakeD1, 2);
  const host = socketFor(state, "host");
  const player = socketFor(state, "p0");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  authority.handleMutation(player, envelope("p0", 1, "submitAnswer", { playerId: "p0", answerText: "first" }, "first-answer"), now + 1);
  const editedAction = envelope("p0", 2, "submitAnswer", { playerId: "p0", answerText: "edited" }, "edit-action");
  authority.handleMutation(player, editedAction, now + 2);
  await authority.forceCheckpoint("phase-boundary");
  state.sockets.length = 0;
  const restoredEdit = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restoredEdit.restoreFromStorage();
  const editedReplay = restoredEdit.handleMutation(null, editedAction, now + 3);
  assert.equal((editedReplay.data as { id: string }).id, "first-answer");
  assert.equal((editedReplay.data as { buzzerAnswer: { id: string } }).buzzerAnswer.id, "first-answer:b");

  const forfeitedAction = envelope("p0", 3, "submitForfeitAnswer", { playerId: "p0" }, "forfeit-action");
  restoredEdit.handleMutation(null, forfeitedAction, now + 4);
  await restoredEdit.forceCheckpoint("phase-boundary");
  const restoredForfeit = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restoredForfeit.restoreFromStorage();
  const forfeitedReplay = restoredForfeit.handleMutation(null, forfeitedAction, now + 5);
  assert.equal((forfeitedReplay.data as { id: string }).id, "first-answer");

  const cancelAction = envelope("p0", 4, "cancelForfeitAnswer", { playerId: "p0" }, "cancel-action");
  restoredForfeit.handleMutation(null, cancelAction, now + 6);
  await restoredForfeit.forceCheckpoint("phase-boundary");
  const restoredCancel = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restoredCancel.restoreFromStorage();
  const cancelReplay = restoredCancel.handleMutation(null, cancelAction, now + 7);
  const cancelData = cancelReplay.data as { gameSession?: GameSession; canceledAnswerId?: string };
  assert.equal(cancelReplay.duplicate, true);
  assert.equal(cancelData.gameSession?.id, "g1");
  assert.ok(cancelData.canceledAnswerId);
  assert.notEqual(cancelData.canceledAnswerId, "cancel-action");

  enterReview(restoredCancel);
  const advanceAction = envelope("host", 2, "advanceReviewedQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0 }, "advance-after-answer");
  const advanced = restoredCancel.handleMutation(null, advanceAction, now + 8);
  await restoredCancel.forceCheckpoint(advanced.forceCheckpoint!, advanced.archiveQuestion);
  const restoredArchived = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restoredArchived.restoreFromStorage();
  const archivedReplay = restoredArchived.handleMutation(null, editedAction, now + 9);
  const archivedData = archivedReplay.data as { id?: string; gameSessionId?: string; answerText?: string; buzzerAnswer?: { id?: string } };
  assert.equal(archivedReplay.duplicate, true);
  assert.equal(archivedData.id, "edit-action");
  assert.equal(archivedData.gameSessionId, "g1");
  assert.equal(archivedData.answerText, "edited");
  assert.ok(archivedData.buzzerAnswer?.id);
});

test("terminal rejection replays from Attachment without blocking hibernation restore", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  enterReview(authority);
  authority.handleMutation(null, envelope("p0", 1, "joinRoom", { nickname: "P0", role: "PLAYER" }), Date.now() - 1);
  await authority.forceCheckpoint("phase-boundary");
  const rejected = authority.handleMutation(host, envelope("host", 1, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "missing", labelText: "bad" }), Date.now());
  assert.equal(rejected.terminal, true);
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  assert.equal(restored.getAggregate()?.seenSeqByActor.host, 1);
  assert.match(restored.getAggregate()?.terminalRejections["host:1"] ?? "", /当前题目不存在/);
});

test("committed terminal rejection keeps the same error after restart", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  enterReview(authority);
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
  const joined = authority.handleMutation(late, envelope("late", 1, "joinRoom", { nickname: "Late", role: "PLAYER" }), now);
  assert.deepEqual(joined.data, { room: authority.getAggregate()?.room, error: null, errorCode: null });
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

test("direct GameSession mutations preserve their public RPC response contract", () => {
  const { state, authority } = createAuthority(2);
  const host = socketFor(state, "host");
  const p0 = socketFor(state, "p0");
  const now = Date.now();
  const opened = authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  assert.equal((opened.data as GameSession).id, authority.getAggregate()?.gameSession?.id);
  assert.equal("gameSession" in (opened.data as Record<string, unknown>), false);

  const session = authority.getAggregate()!.gameSession!;
  session.roundStartedAt = null;
  session.gameMode = "TEAM_BATTLE";
  session.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    voteDeadlineAt: null, revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  const revealed = authority.handleMutation(p0, envelope("p0", 1, "submitTeamBattleRevealVote", { playerId: "p0", selectedBlocks: [2], revealBlockCount: 45 }), now + 1);
  assert.equal((revealed.data as GameSession).id, session.id);
  assert.equal("gameSession" in (revealed.data as Record<string, unknown>), false);

  session.teamBattleState.phase = "GUESS_VOTE";
  session.teamBattleState.voteDeadlineAt = null;
  const guessed = authority.handleMutation(p0, envelope("p0", 2, "submitTeamBattleGuessVote", { playerId: "p0", vote: { type: "skip" } }), now + 2);
  assert.equal((guessed.data as GameSession).id, session.id);
  assert.equal("gameSession" in (guessed.data as Record<string, unknown>), false);
});

test("cancel current round persistently releases vNext for the next game", async () => {
  const { authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.room!.preparedQuestionSetId = "set-1";
  aggregate.deadline = { kind: "round", gameId: "g1", questionIndex: 0, phaseKey: "round:1", runAtMs: Date.now() + 10_000 };
  const canceled = authority.handleMutation(null, envelope("host", 1, "cancelCurrentRound", { roomId: "r1", hostPlayerId: "host" }), Date.now());
  assert.equal(canceled.forceCheckpoint, "projection");
  assert.equal(authority.getAggregate()?.cutoverState, "ended");
  assert.equal(authority.getAggregate()?.deadline, null);
  assert.deepEqual(canceled.data, {
    ...aggregate.room,
    status: "LOBBY",
    currentGameId: null,
    currentPresenterPlayerId: null,
    preparedQuestionSetId: null,
  });
  await authority.forceCheckpoint(canceled.forceCheckpoint!);
  authority.beginStart("r1", "g2", { startRequestId: "g2" });
  assert.equal(authority.getAggregate()?.gameId, "g2");
  assert.equal(authority.getAggregate()?.cutoverState, "initializing");
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

test("RANKED deadline preserves pending answers until presenter settles manually", async () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "BUZZER_RANKED";
  const host = socketFor(state, "host");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  authority.handleMutation(socketFor(state, "p0"), envelope("p0", 1, "submitBuzzerAnswer", { playerId: "p0", answerText: "pending" }), now + 10);
  await authority.forceCheckpoint("phase-boundary");
  const deadline = authority.getDeadline();
  assert.ok(deadline);

  const expired = await authority.executeDueDeadline(deadline!.runAtMs);
  assert.ok(expired);
  assert.equal(authority.getAggregate()?.gameSession?.currentRevealRound, 1);
  assert.ok(authority.getAggregate()?.gameSession?.roundStartedAt, "deadline must keep the judgement phase open");
  assert.equal(authority.getAggregate()?.buzzerAnswers.find((answer) => answer.playerId === "p0")?.status, "pending");
  const forfeitDelta = expired!.outcome.publicDeltas.find((delta) => delta.type === "answer_progress_changed");
  assert.ok(forfeitDelta && forfeitDelta.type === "answer_progress_changed");
  assert.deepEqual(forfeitDelta.answers.map((answer) => [answer.playerId, answer.forfeited]), [["p1", true]]);

  authority.handleMutation(host, envelope("host", 2, "judgeBuzzerAnswer", { presenterPlayerId: "host", buzzerAnswerId: "p0:1:submitBuzzerAnswer", isCorrect: false }), deadline!.runAtMs + 1);
  assert.equal(authority.getAggregate()?.gameSession?.currentRevealRound, 1, "judgement alone must not advance the round");
  authority.handleMutation(host, envelope("host", 3, "settleBuzzerRound", { presenterPlayerId: "host" }), deadline!.runAtMs + 2);
  assert.equal(authority.getAggregate()?.gameSession?.currentRevealRound, 2);
  assert.equal(authority.getAggregate()?.gameSession?.roundStartedAt, null);
});

test("RANKED all-correct result reveals the answer only after presenter settlement", async () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "BUZZER_RANKED";
  const host = socketFor(state, "host");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  authority.handleMutation(socketFor(state, "p0"), envelope("p0", 1, "submitBuzzerAnswer", { playerId: "p0", answerText: "a" }), now + 10);
  authority.handleMutation(socketFor(state, "p1"), envelope("p1", 1, "submitBuzzerAnswer", { playerId: "p1", answerText: "b" }), now + 11);
  authority.handleMutation(host, envelope("host", 2, "setAnswerJudgements", {
    presenterPlayerId: "host",
    judgements: [
      { buzzerAnswerId: "p0:1:submitBuzzerAnswer", isCorrect: true },
      { buzzerAnswerId: "p1:1:submitBuzzerAnswer", isCorrect: true },
    ],
  }), now + 3012);
  assert.equal(authority.getAggregate()?.gameSession?.revealedBlocks.length, 1);
  assert.ok(authority.getAggregate()?.gameSession?.roundStartedAt);

  await authority.forceCheckpoint("phase-boundary");
  const deadline = authority.getDeadline();
  assert.ok(deadline);
  await authority.executeDueDeadline(deadline!.runAtMs);
  assert.equal(authority.getAggregate()?.gameSession?.revealedBlocks.length, 1);
  assert.ok(authority.getAggregate()?.gameSession?.roundStartedAt);

  authority.handleMutation(host, envelope("host", 3, "settleBuzzerRound", { presenterPlayerId: "host" }), deadline!.runAtMs + 1);
  assert.equal(authority.getAggregate()?.gameSession?.currentRevealRound, 1);
  assert.equal(authority.getAggregate()?.gameSession?.revealedBlocks.length, 45);
  assert.equal(authority.getAggregate()?.gameSession?.roundStartedAt, null);
});

test("RANKED final-round forfeit settles immediately after another player scored earlier", () => {
  const { state, authority } = createAuthority(2);
  authority.getAggregate()!.gameSession!.gameMode = "BUZZER_RANKED";
  const host = socketFor(state, "host");
  const p0 = socketFor(state, "p0");
  const p1 = socketFor(state, "p1");
  const now = Date.now();

  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  authority.handleMutation(p0, envelope("p0", 1, "submitBuzzerAnswer", { playerId: "p0", answerText: "round-1-a" }), now + 1);
  authority.handleMutation(p1, envelope("p1", 1, "submitBuzzerAnswer", { playerId: "p1", answerText: "round-1-b" }), now + 2);
  authority.handleMutation(host, envelope("host", 2, "setAnswerJudgements", { presenterPlayerId: "host", judgements: [
    { buzzerAnswerId: "p0:1:submitBuzzerAnswer", isCorrect: false },
    { buzzerAnswerId: "p1:1:submitBuzzerAnswer", isCorrect: false },
  ] }), now + 3003);
  authority.handleMutation(host, envelope("host", 3, "settleBuzzerRound", { presenterPlayerId: "host" }), now + 3004);

  authority.handleMutation(host, envelope("host", 4, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [2] }), now + 3005);
  authority.handleMutation(p0, envelope("p0", 2, "submitBuzzerAnswer", { playerId: "p0", answerText: "round-2-a" }), now + 3006);
  authority.handleMutation(p1, envelope("p1", 2, "submitBuzzerAnswer", { playerId: "p1", answerText: "round-2-b" }), now + 3007);
  authority.handleMutation(host, envelope("host", 5, "setAnswerJudgements", { presenterPlayerId: "host", judgements: [
    { buzzerAnswerId: "p0:2:submitBuzzerAnswer", isCorrect: true },
    { buzzerAnswerId: "p1:2:submitBuzzerAnswer", isCorrect: false },
  ] }), now + 6008);
  authority.handleMutation(host, envelope("host", 6, "settleBuzzerRound", { presenterPlayerId: "host" }), now + 6009);
  assert.equal(authority.getAggregate()?.gameSession?.currentRevealRound, 3);

  authority.handleMutation(host, envelope("host", 7, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [3] }), now + 6010);
  authority.handleMutation(p1, envelope("p1", 3, "submitForfeitAnswer", { playerId: "p1" }), now + 6011);
  const refreshedSnapshot = authority.getSnapshot(now + 6011);
  assert.deepEqual(refreshedSnapshot.answers.map((answer) => [answer.playerId, answer.revealRound]), [["p1", 3]]);
  assert.deepEqual(refreshedSnapshot.buzzerAnswers, []);
  assert.deepEqual(
    refreshedSnapshot.labelBuzzerAnswers.map((answer) => [answer.playerId, answer.revealRound, answer.status]),
    [["p0", 2, "correct"]],
  );
  const settled = authority.handleMutation(host, envelope("host", 8, "settleBuzzerRound", { presenterPlayerId: "host" }), now + 6012);

  assert.equal(settled.forceCheckpoint, "phase-boundary");
  assert.equal(authority.getAggregate()?.gameSession?.currentRevealRound, 3);
  assert.equal(authority.getAggregate()?.gameSession?.revealedBlocks.length, 45);
  assert.equal(authority.getAggregate()?.gameSession?.roundStartedAt, null);
  assert.equal(authority.getAggregate()?.answers.some((answer) => answer.revealRound === 3 && answer.playerId === "p0"), false);
});

test("RANKED scores use stable correct order across rounds and fully recompute after rejudgement", () => {
  const { state, authority } = createAuthority(3);
  authority.getAggregate()!.gameSession!.gameMode = "BUZZER_RANKED";
  const host = socketFor(state, "host");
  const p0 = socketFor(state, "p0");
  const p1 = socketFor(state, "p1");
  const p2 = socketFor(state, "p2");
  const now = Date.now();

  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  authority.handleMutation(p0, envelope("p0", 1, "submitBuzzerAnswer", { playerId: "p0", answerText: "first" }), now + 1);
  authority.handleMutation(p1, envelope("p1", 1, "submitBuzzerAnswer", { playerId: "p1", answerText: "wrong" }), now + 2);
  authority.handleMutation(p2, envelope("p2", 1, "submitBuzzerAnswer", { playerId: "p2", answerText: "wrong" }), now + 3);
  authority.handleMutation(host, envelope("host", 2, "setAnswerJudgements", { presenterPlayerId: "host", judgements: [
    { buzzerAnswerId: "p0:1:submitBuzzerAnswer", isCorrect: true },
    { buzzerAnswerId: "p1:1:submitBuzzerAnswer", isCorrect: false },
    { buzzerAnswerId: "p2:1:submitBuzzerAnswer", isCorrect: false },
  ] }), now + 3004);
  authority.handleMutation(host, envelope("host", 3, "settleBuzzerRound", { presenterPlayerId: "host" }), now + 3005);

  authority.handleMutation(host, envelope("host", 4, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [2] }), now + 3006);
  authority.handleMutation(p1, envelope("p1", 2, "submitBuzzerAnswer", { playerId: "p1", answerText: "second" }), now + 3007);
  authority.handleMutation(p2, envelope("p2", 2, "submitBuzzerAnswer", { playerId: "p2", answerText: "third" }), now + 3008);
  authority.handleMutation(host, envelope("host", 5, "setAnswerJudgements", { presenterPlayerId: "host", judgements: [
    { buzzerAnswerId: "p1:2:submitBuzzerAnswer", isCorrect: true },
    { buzzerAnswerId: "p2:2:submitBuzzerAnswer", isCorrect: true },
  ] }), now + 6009);

  assert.deepEqual(authority.getAggregate()!.scores.map((score) => [score.playerId, score.score]), [["p0", 3], ["p1", 2], ["p2", 1]]);
  assert.deepEqual(authority.getAggregate()!.questionResults.map((result) => [result.playerId, result.scoredRound, result.scoreAwarded]), [["p0", 1, 3], ["p1", 2, 2], ["p2", 2, 1]]);

  const rejudged = authority.handleMutation(host, envelope("host", 6, "judgeBuzzerAnswer", { presenterPlayerId: "host", buzzerAnswerId: "p1:2:submitBuzzerAnswer", isCorrect: false }), now + 6010);
  assert.deepEqual(authority.getAggregate()!.scores.map((score) => [score.playerId, score.score, score.correctCount]), [["p0", 3, 1], ["p1", 0, 0], ["p2", 2, 1]]);
  assert.deepEqual(authority.getAggregate()!.questionResults.map((result) => [result.playerId, result.scoredRound, result.scoreAwarded]), [["p0", 1, 3], ["p2", 2, 2]]);
  assert.deepEqual(authority.getAggregate()!.buzzerAnswers.filter((answer) => answer.status === "correct").map((answer) => [answer.playerId, answer.scoreAwarded]), [["p0", 3], ["p2", 2]]);
  const publicProgress = rejudged.publicDeltas.find((delta) => delta.type === "answer_progress_changed");
  assert.ok(publicProgress && publicProgress.type === "answer_progress_changed");
  assert.deepEqual(publicProgress.buzzerAnswers.map((answer) => [answer.playerId, answer.status, answer.scoreAwarded]), [["p1", "wrong", 0], ["p2", "correct", 2]]);
  assert.equal(JSON.stringify(publicProgress).includes("second"), false);
  assert.equal(JSON.stringify(publicProgress).includes("third"), false);
  assert.deepEqual(rejudged.playerDeltas.map((delivery) => [delivery.playerId, delivery.delta.type === "answer_judgements_changed" ? delivery.delta.answers[0].scoreAwarded : null]), [["p1", 0], ["p2", 2]]);
  assert.equal(JSON.stringify(rejudged.playerDeltas.find((delivery) => delivery.playerId === "p2")).includes("second"), false);
});

test("ROUND_REVEAL settlement returns to block selection before the next round", () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const player = socketFor(state, "p0");
  const now = Date.now();
  authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), now);
  authority.handleMutation(player, envelope("p0", 1, "submitAnswer", { playerId: "p0", answerText: "wrong" }), now + 10);
  authority.handleMutation(host, envelope("host", 2, "setAnswerJudgements", {
    presenterPlayerId: "host",
    judgements: [{ buzzerAnswerId: "p0:1:submitAnswer:b", isCorrect: false }],
  }), now + 3010);

  const settled = authority.handleMutation(host, envelope("host", 3, "settleBuzzerRound", { presenterPlayerId: "host" }), now + 3011);
  assert.equal(settled.error, undefined);
  assert.equal(authority.getAggregate()?.gameSession?.currentRevealRound, 2);
  assert.equal(authority.getAggregate()?.gameSession?.roundStartedAt, null);
  assert.equal(authority.getDeadline(), null);

  const reopened = authority.handleMutation(host, envelope("host", 4, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [2] }), now + 3012);
  assert.equal(reopened.error, undefined);
  assert.ok(authority.getAggregate()?.gameSession?.roundStartedAt);
});

test("advance requires review while explicit skip still ends the current question", () => {
  const { state, authority } = createAuthority(1, fakeD1, 2);
  const host = socketFor(state, "host");
  const now = Date.now();
  const advanced = authority.handleMutation(host, envelope("host", 1, "advanceReviewedQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0 }), now);
  assert.equal(advanced.terminal, true);
  assert.match(advanced.error ?? "", /完整图片复盘阶段/);
  assert.equal(authority.getAggregate()?.gameSession?.currentQuestionIndex, 0);

  const skipped = authority.handleMutation(host, envelope("host", 2, "skipCurrentQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0 }), now + 1);
  assert.equal(skipped.error, undefined);
  assert.equal(skipped.forceCheckpoint, "phase-boundary");
  assert.equal(authority.getAggregate()?.gameSession?.currentQuestionIndex, 1);
});

test("question labels enforce review, current question, immutability, and answer ownership", () => {
  {
    const { state, authority } = createAuthority(1);
    const rejected = authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "answer", source: "manual" }), Date.now());
    assert.match(rejected.error ?? "", /完整图片复盘阶段/);
  }
  {
    const { state, authority } = createAuthority(1, fakeD1, 2);
    enterReview(authority);
    const rejected = authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q2", labelText: "answer", source: "manual" }), Date.now());
    assert.match(rejected.error ?? "", /当前题目不存在/);
  }
  {
    const { state, authority } = createAuthority(1);
    authority.getAggregate()!.questions[0].labelText = "existing";
    enterReview(authority);
    const rejected = authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "replacement", source: "manual" }), Date.now());
    assert.match(rejected.error ?? "", /不能重复填写/);
    assert.equal(authority.getAggregate()!.questions[0].labelText, "existing");
  }
  {
    const { state, authority } = createAuthority(1);
    const aggregate = authority.getAggregate()!;
    enterReview(authority);
    aggregate.answers.push({ id: "foreign-ordinary", gameSessionId: "other-game", questionIndex: 0, revealRound: 1, playerId: "p0", answerText: "foreign", submittedAt: new Date().toISOString() });
    aggregate.buzzerAnswers.push({ id: "foreign-buzzer", gameSessionId: "other-game", questionIndex: 0, revealRound: 1, playerId: "p0", answerText: "foreign", status: "correct", scoreAwarded: 1, submittedAt: new Date().toISOString(), serverReceivedAt: new Date().toISOString() });
    const host = socketFor(state, "host");
    const ordinaryRejected = authority.handleMutation(host, envelope("host", 1, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "answer", source: "answer", answerId: "foreign-ordinary" }), Date.now());
    assert.match(ordinaryRejected.error ?? "", /引用的答案不存在/);
    const buzzerRejected = authority.handleMutation(host, envelope("host", 2, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "answer", source: "answer", answerId: "foreign-buzzer" }), Date.now() + 1);
    assert.match(buzzerRejected.error ?? "", /引用的答案不存在/);
  }
  {
    const { state, authority } = createAuthority(1);
    const host = socketFor(state, "host");
    authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), Date.now());
    authority.handleMutation(socketFor(state, "p0"), envelope("p0", 1, "submitAnswer", { playerId: "p0", answerText: "ordinary" }), Date.now());
    enterReview(authority);
    const saved = authority.handleMutation(host, envelope("host", 2, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "ordinary", source: "answer", answerId: "p0:1:submitAnswer" }), Date.now() + 1);
    assert.equal(saved.error, undefined);
    assert.equal(authority.getAggregate()!.questions[0].labelSourceAnswerId, "p0:1:submitAnswer");
    assert.equal(saved.publicDeltas[0]?.type, "question_label_updated");
  }
  {
    const { state, authority } = createAuthority(1);
    const host = socketFor(state, "host");
    authority.getAggregate()!.gameSession!.gameMode = "BUZZER_RANKED";
    authority.handleMutation(host, envelope("host", 1, "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [1] }), Date.now());
    authority.handleMutation(socketFor(state, "p0"), envelope("p0", 1, "submitBuzzerAnswer", { playerId: "p0", answerText: "buzzer" }), Date.now());
    enterReview(authority);
    const saved = authority.handleMutation(host, envelope("host", 2, "updateQuestionLabel", { presenterPlayerId: "host", questionId: "q1", labelText: "buzzer", source: "answer", answerId: "p0:1:submitBuzzerAnswer" }), Date.now() + 1);
    assert.equal(saved.error, undefined);
    assert.equal(authority.getAggregate()!.questions[0].labelSourceAnswerId, "p0:1:submitBuzzerAnswer");
  }
});

test("game completion broadcasts both final results and GAME_RESULT room state", () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  enterReview(authority);
  const ended = authority.handleMutation(host, envelope("host", 1, "advanceReviewedQuestion", {
    presenterPlayerId: "host",
    expectedQuestionIndex: 0,
  }), Date.now());

  const resultDelta = ended.publicDeltas.find((delta) => delta.type === "game_result_snapshot");
  const roomDelta = ended.publicDeltas.find((delta) => delta.type === "room_updated");
  assert.equal(resultDelta?.type, "game_result_snapshot");
  assert.equal(roomDelta?.type, "room_updated");
  if (roomDelta?.type === "room_updated") {
    assert.equal(roomDelta.room.status, "GAME_RESULT");
    assert.equal(roomDelta.room.currentGameId, "g1");
  }
});

test("players can leave an ended vNext game and roster projection is forced", async () => {
  const { state, authority } = createAuthority(1);
  const host = socketFor(state, "host");
  const player = socketFor(state, "p0");
  enterReview(authority);
  const ended = authority.handleMutation(host, envelope("host", 1, "advanceReviewedQuestion", {
    presenterPlayerId: "host",
    expectedQuestionIndex: 0,
  }), Date.now());
  await authority.forceCheckpoint(ended.forceCheckpoint ?? "game-end", true);

  const left = authority.handleMutation(player, envelope("p0", 1, "leaveRoom", { roomId: "r1", playerId: "p0" }), Date.now() + 1);
  assert.equal(left.error, undefined);
  assert.equal(left.forceCheckpoint, "projection");
  assert.deepEqual(authority.getAggregate()?.players.map((item) => item.id), ["host"]);
  assert.deepEqual(authority.getAggregate()?.gameParticipants?.map((item) => item.id), ["p0"]);
  await authority.forceCheckpoint(left.forceCheckpoint!);

  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  assert.deepEqual(restored.getAggregate()?.players.map((item) => item.id), ["host"]);
  assert.deepEqual(restored.query("getLeaderboardForGameSession", ["g1"]).map((entry: { playerId: string; nickname: string }) => [entry.playerId, entry.nickname]), [["p0", "P0"]]);
});

test("ended room mutations ignore a stale question index", () => {
  const { state, authority } = createAuthority(1, fakeD1, 2);
  const host = socketFor(state, "host");
  const player = socketFor(state, "p0");
  const now = Date.now();
  enterReview(authority);
  const advanced = authority.handleMutation(host, envelope("host", 1, "advanceReviewedQuestion", {
    presenterPlayerId: "host",
    expectedQuestionIndex: 0,
  }), now);
  assert.equal(advanced.error, undefined);
  enterReview(authority);
  const ended = authority.handleMutation(host, {
    ...envelope("host", 2, "advanceReviewedQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 1 }),
    questionIndex: 1,
  }, now + 1);
  assert.equal(ended.error, undefined);

  const left = authority.handleMutation(player, envelope("p0", 1, "leaveRoom", { roomId: "r1", playerId: "p0" }), now + 2);
  assert.equal(left.error, undefined);
  assert.deepEqual(authority.getAggregate()?.players.map((item) => item.id), ["host"]);

  const returned = authority.handleMutation(host, envelope("host", 3, "returnRoomToLobby", { roomId: "r1", hostPlayerId: "host" }), now + 3);
  assert.equal(returned.error, undefined);
  assert.equal(authority.getAggregate()?.room?.status, "LOBBY");
});

test("game result snapshot and final projection retain labels saved before question changes", async () => {
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const d1 = {
    prepare(sql: string) { return { bind(...bindings: unknown[]) { const statement = { sql, bindings }; statements.push(statement); return statement; } }; },
    async batch() { return []; },
  } as unknown as D1Database;
  const { state, authority } = createAuthority(1, d1, 2);
  const host = socketFor(state, "host");
  const now = Date.now();
  enterReview(authority);

  authority.handleMutation(host, envelope("host", 1, "updateQuestionLabel", {
    presenterPlayerId: "host",
    questionId: "q1",
    labelText: "第一题答案",
    source: "manual",
  }), now);
  const advanced = authority.handleMutation(host, envelope("host", 2, "advanceReviewedQuestion", {
    presenterPlayerId: "host",
    expectedQuestionIndex: 0,
  }), now + 1);
  await authority.forceCheckpoint(advanced.forceCheckpoint ?? "phase-boundary", true);
  enterReview(authority);
  authority.handleMutation(host, {
    ...envelope("host", 3, "updateQuestionLabel", {
      presenterPlayerId: "host",
      questionId: "q2",
      labelText: "第二题答案",
      source: "manual",
    }),
    questionIndex: 1,
  }, now + 2);
  const ended = authority.handleMutation(host, {
    ...envelope("host", 4, "advanceReviewedQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 1 }),
    questionIndex: 1,
  }, now + 3);

  const snapshotDelta = ended.publicDeltas.find((delta) => delta.type === "game_result_snapshot");
  assert.equal(snapshotDelta?.type, "game_result_snapshot");
  if (snapshotDelta?.type === "game_result_snapshot") {
    assert.deepEqual(snapshotDelta.snapshot.questionSet?.questions?.map((question) => question.labelText), ["第一题答案", "第二题答案"]);
  }

  await authority.forceCheckpoint(ended.forceCheckpoint ?? "game-end", true);
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, d1);
  await restored.restoreFromStorage();
  const restoredSnapshot = restored.query("getGameResultSnapshot", []) as { questionSet: QuestionSet | null };
  assert.deepEqual(restoredSnapshot.questionSet?.questions?.map((question) => question.labelText), ["第一题答案", "第二题答案"]);
  await authority.flushFinalProjection();
  const labelUpdates = statements.filter((statement) => /UPDATE questions SET label_text/.test(statement.sql));
  assert.deepEqual(labelUpdates.map((statement) => [statement.bindings[0], statement.bindings[5]]), [["第一题答案", "q1"], ["第二题答案", "q2"]]);
});

test("manifest projection skips clean games and merges a concurrent label into one revisioned row", async () => {
  const clean = createSqliteProjectionAuthority(1, 1);
  clean.authority.getAggregate()!.questionSetManifestVersion = 1;
  clean.d1.db.prepare("INSERT INTO question_sets(id,manifest_version,manifest_revision,manifest_json) VALUES(?,?,?,?)").run(
    "set1",
    1,
    0,
    encodeQuestionSetManifest(clean.authority.getAggregate()!.questions),
  );
  enterReview(clean.authority);
  const cleanEnd = clean.authority.handleMutation(socketFor(clean.state, "host"), envelope("host", 1, "advanceReviewedQuestion", {
    presenterPlayerId: "host",
    expectedQuestionIndex: 0,
  }), Date.now());
  await clean.authority.forceCheckpoint(cleanEnd.forceCheckpoint ?? "game-end", true);
  await clean.authority.flushFinalProjection();
  assert.equal(clean.d1.db.prepare("SELECT manifest_revision FROM question_sets WHERE id='set1'").get().manifest_revision, 0);

  const concurrent = createSqliteProjectionAuthority(1, 2);
  const aggregate = concurrent.authority.getAggregate()!;
  aggregate.questionSetManifestVersion = 1;
  concurrent.d1.db.prepare("INSERT INTO question_sets(id,manifest_version,manifest_revision,manifest_json) VALUES(?,?,?,?)").run(
    "set1",
    1,
    0,
    encodeQuestionSetManifest(aggregate.questions),
  );
  const host = socketFor(concurrent.state, "host");
  enterReview(concurrent.authority);
  concurrent.authority.handleMutation(host, envelope("host", 1, "updateQuestionLabel", {
    presenterPlayerId: "host",
    questionId: "q1",
    labelText: "房间一答案",
    source: "manual",
  }), Date.now());
  assert.deepEqual(aggregate.dirtyQuestionLabelIds, ["q1"]);
  const ended = concurrent.authority.handleMutation(host, envelope("host", 2, "endCurrentGameEarly", {
    presenterPlayerId: "host",
    gameSessionId: "g1",
  }), Date.now() + 1);
  await concurrent.authority.forceCheckpoint(ended.forceCheckpoint ?? "game-end", true);
  const pendingProjection = concurrent.state.storage.sql.db.prepare("SELECT payload_json FROM authority_vnext_projection_outbox WHERE id=1").get();
  const pendingGame = JSON.parse(String(pendingProjection.payload_json)).games[0];
  assert.equal(pendingGame.questionSetManifestVersion, 1);
  assert.deepEqual(pendingGame.dirtyQuestionLabelIds, ["q1"]);

  const externalQuestions = structuredClone(aggregate.questionSet!.questions!);
  externalQuestions[1] = {
    ...externalQuestions[1],
    labelText: "房间二答案",
    labelSource: "manual",
    labelUpdatedByPlayerId: "other-host",
    labelUpdatedAt: new Date().toISOString(),
  };
  concurrent.d1.db.prepare("UPDATE question_sets SET manifest_json=?,manifest_revision=1 WHERE id='set1'")
    .run(encodeQuestionSetManifest(externalQuestions));

  await concurrent.authority.flushFinalProjection();
  const stored = concurrent.d1.db.prepare("SELECT id,manifest_version,manifest_revision,manifest_json FROM question_sets WHERE id='set1'").get() as Pick<DbQuestionSet, "id" | "manifest_version" | "manifest_revision" | "manifest_json">;
  const questions = decodeQuestionSetManifest(stored)!;
  assert.equal(stored.manifest_revision, 2);
  assert.deepEqual(questions.map((question) => question.label_text), ["房间一答案", "房间二答案"]);
  assert.deepEqual(concurrent.d1.db.prepare("SELECT label_text FROM questions ORDER BY id").all().map((row) => row.label_text), [null, null]);
});

test("manifest projection is idempotent when its later D1 batch fails and the outbox retries", async () => {
  const created = createSqliteProjectionAuthority(1, 2);
  const aggregate = created.authority.getAggregate()!;
  aggregate.questionSetManifestVersion = 1;
  created.d1.db.prepare("INSERT INTO question_sets(id,manifest_version,manifest_revision,manifest_json) VALUES(?,?,?,?)").run(
    "set1",
    1,
    0,
    encodeQuestionSetManifest(aggregate.questions),
  );
  const host = socketFor(created.state, "host");
  enterReview(created.authority);
  created.authority.handleMutation(host, envelope("host", 1, "updateQuestionLabel", {
    presenterPlayerId: "host",
    questionId: "q1",
    labelText: "只写一次",
    source: "manual",
  }), Date.now());
  const advanced = created.authority.handleMutation(host, envelope("host", 2, "advanceReviewedQuestion", {
    presenterPlayerId: "host",
    expectedQuestionIndex: 0,
  }), Date.now() + 1);
  await created.authority.forceCheckpoint(advanced.forceCheckpoint ?? "phase-boundary", true);
  enterReview(created.authority);
  created.authority.handleMutation(host, {
    ...envelope("host", 3, "updateQuestionLabel", {
      presenterPlayerId: "host",
      questionId: "q2",
      labelText: "也只写一次",
      source: "manual",
    }),
    questionIndex: 1,
  }, Date.now() + 2);
  const ended = created.authority.handleMutation(host, {
    ...envelope("host", 4, "endCurrentGameEarly", { presenterPlayerId: "host", gameSessionId: "g1" }),
    questionIndex: 1,
  }, Date.now() + 3);
  await created.authority.forceCheckpoint(ended.forceCheckpoint ?? "game-end", true);

  created.d1.failNextBatch = true;
  assert.equal(await created.authority.flushFinalProjection(), false);
  assert.equal(created.d1.db.prepare("SELECT manifest_revision FROM question_sets WHERE id='set1'").get().manifest_revision, 1);
  assert.equal(created.authority.hasPendingFinalProjection(), true);

  assert.equal(await created.authority.flushFinalProjection(), true);
  const stored = created.d1.db.prepare("SELECT id,manifest_version,manifest_revision,manifest_json FROM question_sets WHERE id='set1'").get() as Pick<DbQuestionSet, "id" | "manifest_version" | "manifest_revision" | "manifest_json">;
  assert.equal(stored.manifest_revision, 1, "retry must not rewrite an already-merged manifest");
  assert.deepEqual(decodeQuestionSetManifest(stored)?.map((question) => question.label_text), ["只写一次", "也只写一次"]);
  assert.equal(created.authority.hasPendingFinalProjection(), false);
});

test("manifest projection keeps the first stored label when another room conflicts on the same question", async () => {
  const created = createSqliteProjectionAuthority(1, 1);
  const aggregate = created.authority.getAggregate()!;
  aggregate.questionSetManifestVersion = 1;
  created.d1.db.prepare("INSERT INTO question_sets(id,manifest_version,manifest_revision,manifest_json) VALUES(?,?,?,?)").run(
    "set1", 1, 0, encodeQuestionSetManifest(aggregate.questions),
  );
  const host = socketFor(created.state, "host");
  enterReview(created.authority);
  created.authority.handleMutation(host, envelope("host", 1, "updateQuestionLabel", {
    presenterPlayerId: "host",
    questionId: "q1",
    labelText: "较晚答案",
    source: "manual",
  }), Date.now());
  const ended = created.authority.handleMutation(host, envelope("host", 2, "endCurrentGameEarly", {
    presenterPlayerId: "host",
    gameSessionId: "g1",
  }), Date.now() + 1);
  await created.authority.forceCheckpoint(ended.forceCheckpoint ?? "game-end", true);

  const firstStored = aggregate.questionSet!.questions!.map((question) => ({
    ...question,
    labelText: "先写答案",
    labelSource: "manual" as const,
    labelUpdatedByPlayerId: "other-host",
    labelUpdatedAt: "2026-07-31T00:00:00.000Z",
  }));
  created.d1.db.prepare("UPDATE question_sets SET manifest_json=?,manifest_revision=1 WHERE id='set1'")
    .run(encodeQuestionSetManifest(firstStored));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    assert.equal(await created.authority.flushFinalProjection(), true);
  } finally {
    console.warn = originalWarn;
  }

  const stored = created.d1.db.prepare("SELECT id,manifest_version,manifest_revision,manifest_json FROM question_sets WHERE id='set1'").get() as Pick<DbQuestionSet, "id" | "manifest_version" | "manifest_revision" | "manifest_json">;
  assert.equal(stored.manifest_revision, 1);
  assert.equal(decodeQuestionSetManifest(stored)?.[0]?.label_text, "先写答案");
  assert.ok(warnings.some((message) => message.includes('"event":"question_manifest_label_conflict"')));
});

test("legacy active aggregates conservatively recover labeled manifest questions when the dirty list is absent", async () => {
  const created = createSqliteProjectionAuthority(1, 1);
  const aggregate = created.authority.getAggregate()!;
  aggregate.questionSetManifestVersion = 1;
  enterReview(created.authority);
  created.authority.handleMutation(socketFor(created.state, "host"), envelope("host", 1, "updateQuestionLabel", {
    presenterPlayerId: "host",
    questionId: "q1",
    labelText: "恢复答案",
    source: "manual",
  }), Date.now());
  // Older builds shallow-copied this array, so the nominal initial snapshot
  // could already contain the same label and cannot be used as a diff base.
  aggregate.questionSet!.questions![0]!.labelText = "恢复答案";
  await created.authority.forceCheckpoint("phase-boundary");

  const row = created.state.storage.sql.db.prepare("SELECT state_json FROM authority_vnext_active_game WHERE id=1").get() as { state_json: string };
  const persisted = JSON.parse(row.state_json) as Record<string, unknown>;
  delete persisted.dirtyQuestionLabelIds;
  created.state.storage.sql.db.prepare("UPDATE authority_vnext_active_game SET state_json=? WHERE id=1").run(JSON.stringify(persisted));

  const restored = new RoomAuthorityVNext(created.state as unknown as DurableObjectState, created.d1 as unknown as D1Database);
  await restored.restoreFromStorage();
  assert.deepEqual(restored.getAggregate()?.dirtyQuestionLabelIds, ["q1"]);
});

test("ended host leave projects host transfer and the final player dissolves the room", async () => {
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const d1 = {
    prepare(sql: string) { return { bind(...bindings: unknown[]) { const statement = { sql, bindings }; statements.push(statement); return statement; } }; },
    async batch() { return []; },
  } as unknown as D1Database;
  const { state, authority } = createAuthority(1, d1);
  const host = socketFor(state, "host");
  const player = socketFor(state, "p0");
  enterReview(authority);
  const ended = authority.handleMutation(host, envelope("host", 1, "advanceReviewedQuestion", {
    presenterPlayerId: "host",
    expectedQuestionIndex: 0,
  }), Date.now());
  await authority.forceCheckpoint(ended.forceCheckpoint ?? "game-end", true);

  const hostLeft = authority.handleMutation(host, envelope("host", 2, "leaveRoom", { roomId: "r1", playerId: "host" }), Date.now() + 1);
  assert.equal(hostLeft.forceCheckpoint, "projection");
  assert.equal(authority.getAggregate()?.room?.hostPlayerId, "p0");
  await authority.forceCheckpoint(hostLeft.forceCheckpoint!);
  await authority.flushFinalProjection();
  const roomUpdate = statements.find((statement) => /UPDATE rooms SET host_player_id/.test(statement.sql));
  assert.equal(roomUpdate?.bindings[0], "p0");

  statements.length = 0;
  const finalLeft = authority.handleMutation(player, envelope("p0", 1, "leaveRoom", { roomId: "r1", playerId: "p0" }), Date.now() + 2);
  assert.equal(finalLeft.forceCheckpoint, "game-end");
  assert.equal(finalLeft.data, null);
  assert.equal(authority.getAggregate()?.dissolved, true);
  assert.equal(authority.getAggregate()?.room, undefined);
  await authority.forceCheckpoint(finalLeft.forceCheckpoint!);
  await authority.flushFinalProjection();
  assert.ok(statements.some((statement) => /DELETE FROM rooms WHERE id/.test(statement.sql)));
});

test("presenter UI reveals answers and enables judging immediately after the stability window", () => {
  const answer = { submittedAt: new Date(1_000).toISOString(), serverReceivedAt: new Date(1_000).toISOString() };
  assert.equal(getBuzzerAnswerStabilityDelayMs(answer, 3_999), 1);
  assert.equal(isBuzzerAnswerReadyForJudging(answer, 3_999), false);
  assert.equal(getBuzzerAnswerStabilityDelayMs(answer, 4_000), 0);
  assert.equal(isBuzzerAnswerReadyForJudging(answer, 4_000), true);

  const source = readFileSync(new URL("../src/components/ImageRevealGame.tsx", import.meta.url), "utf8");
  assert.match(source, /const currentBuzzerAnswer =\s*firstPendingBuzzerAnswer && isBuzzerAnswerReadyForJudging/);
  assert.match(source, /currentBuzzerAnswer &&\s*isBuzzerAnswerReadyForJudging\(currentBuzzerAnswer, getEstimatedServerNowMs\(\)\)/);
  assert.match(source, /const isAnswerRevealed = Boolean\(answer && canRevealAnswer\(answer\)\);/);
  assert.match(source, /答案确认中/);
  assert.match(source, /setTimeout\(\(\) => setBuzzerQueueClockTick/);
  assert.match(source, /nextReadyAtMs - nowMs/);
});

test("countdown is derived from absolute server time and catches up after delayed UI ticks", () => {
  const roundStartedAt = new Date(1_000).toISOString();
  assert.equal(getRemainingSeconds(roundStartedAt, 45, 1_000), 45);
  assert.equal(getRemainingSeconds(roundStartedAt, 45, 11_000), 35);
  assert.equal(getRemainingSeconds(roundStartedAt, 45, 46_000), 0);
  assert.equal(getRemainingSeconds(roundStartedAt, 45, 70_000), 0);
});

test("recovery snapshots use generation time and cannot rewind the client clock", () => {
  const { authority } = createAuthority(1);
  const aggregate = authority.getAggregate()!;
  const persistedRoundStart = new Date(1_000).toISOString();
  aggregate.gameSession!.roundStartedAt = persistedRoundStart;
  aggregate.gameSession!.serverNow = persistedRoundStart;

  const beforeQuery = Date.now();
  const snapshot = authority.query("getGameBootstrapSnapshot", [aggregate.gameId]) as {
    gameSession: GameSession;
    roundSnapshot: { gameSession: GameSession };
  };
  const snapshotServerNowMs = new Date(snapshot.gameSession.serverNow ?? "").getTime();

  assert.ok(snapshotServerNowMs >= beforeQuery);
  assert.equal(snapshot.roundSnapshot.gameSession.serverNow, snapshot.gameSession.serverNow);
  assert.equal(snapshot.gameSession.roundStartedAt, persistedRoundStart);
  assert.equal(shouldAcceptServerClock(snapshotServerNowMs, snapshotServerNowMs - 60_000), false);
  assert.equal(shouldAcceptServerClock(snapshotServerNowMs, snapshotServerNowMs + 1), true);
  assert.equal(getRemainingSeconds(snapshot.gameSession.roundStartedAt, 45, snapshotServerNowMs), 0);
});

test("fresh snapshot clock does not cause same-round authoritative deltas to be discarded", () => {
  const { authority } = createAuthority(1);
  const current = structuredClone(authority.getAggregate()!.gameSession!);
  current.roundStartedAt = new Date(10_000).toISOString();
  current.serverNow = new Date(70_000).toISOString();

  const settled = { ...structuredClone(current), roundStartedAt: null, serverNow: new Date(10_000).toISOString() };
  assert.equal(isGameSessionPositionStale(settled, current), false);

  const sameRoundDelta = { ...structuredClone(current), serverNow: new Date(10_000).toISOString() };
  assert.equal(isGameSessionPositionStale(sameRoundDelta, current), false);

  const olderRound = { ...structuredClone(current), currentRevealRound: current.currentRevealRound - 1 };
  assert.equal(isGameSessionPositionStale(olderRound, current), true);
});

test("leaderboard and final projection include participants but exclude presenter and spectators", async () => {
  const projectionBatches: Array<Array<{ sql: string; bindings: unknown[] }>> = [];
  const projectionD1 = {
    prepare(sql: string) {
      return { sql, bindings: [] as unknown[], bind(...bindings: unknown[]) { this.bindings = bindings; return this; } };
    },
    async batch(statements: Array<{ sql: string; bindings: unknown[] }>) {
      projectionBatches.push(statements);
      return [];
    },
  } as unknown as D1Database;
  const state = new FakeState();
  state.storage.sql.db.exec(`
    CREATE TABLE authority_vnext_active_game (id INTEGER PRIMARY KEY CHECK(id=1),room_id TEXT NOT NULL,game_id TEXT NOT NULL,authority_version INTEGER NOT NULL,schema_version INTEGER NOT NULL,cutover_state TEXT NOT NULL,state_version INTEGER NOT NULL,state_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE authority_vnext_question_archive (game_id TEXT NOT NULL,question_index INTEGER NOT NULL,checkpoint_version INTEGER NOT NULL,state_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(game_id,question_index));
    CREATE TABLE authority_vnext_projection_outbox (id INTEGER PRIMARY KEY CHECK(id=1),payload_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
  `);
  const authority = new RoomAuthorityVNext(state as unknown as DurableObjectState, projectionD1);
  const start = bootstrap(1);
  const spectator: Player = { id: "spectator", roomId: "r1", nickname: "Watcher", isHost: false, role: "SPECTATOR", joinedAt: 2 };
  start.players.push(spectator);
  start.room.players = start.players;
  authority.beginStart("r1", "g1", { startRequestId: "g1" });
  authority.activateStart(start);

  assert.deepEqual(authority.getAggregate()?.scores.map((score) => score.playerId), ["p0"]);
  assert.deepEqual(authority.getAggregate()?.gameParticipants?.map((player) => player.id), ["p0"]);

  // Old vNext rows may already contain these invalid zero-score entries; result generation must sanitize them.
  authority.getAggregate()!.scores.push(
    { id: "g1:host", gameSessionId: "g1", playerId: "host", score: 0, correctCount: 0 },
    { id: "g1:spectator", gameSessionId: "g1", playerId: "spectator", score: 0, correctCount: 0 },
  );
  authority.getAggregate()!.gameParticipants!.push(
    { ...start.players[0], role: "PLAYER" },
    { ...spectator, role: "SPECTATOR" },
  );
  authority.getAggregate()!.questionResults.push(
    { id: "g1:0:host", gameSessionId: "g1", questionIndex: 0, playerId: "host", scoredRound: 1, scoreAwarded: 5, judgedByPlayerId: "host", judgedAt: new Date().toISOString() },
    { id: "g1:0:spectator", gameSessionId: "g1", questionIndex: 0, playerId: "spectator", scoredRound: 1, scoreAwarded: 5, judgedByPlayerId: "host", judgedAt: new Date().toISOString() },
  );
  assert.deepEqual(authority.query("getPlayerScores", ["g1"]).map((score: { playerId: string }) => score.playerId), ["p0"]);
  assert.deepEqual(authority.query("getQuestionResultsForGameSession", ["g1"]), []);
  assert.deepEqual(authority.getSnapshot().questionResults, []);
  enterReview(authority);
  const ended = authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "advanceReviewedQuestion", {
    presenterPlayerId: "host",
    expectedQuestionIndex: 0,
  }), Date.now());
  const resultDelta = ended.publicDeltas.find((delta) => delta.type === "game_result_snapshot");
  assert.equal(resultDelta?.type, "game_result_snapshot");
  if (resultDelta?.type === "game_result_snapshot") {
    assert.deepEqual(resultDelta.snapshot.leaderboard.map((entry) => entry.playerId), ["p0"]);
    assert.deepEqual(resultDelta.snapshot.questionScores, []);
  }

  await authority.forceCheckpoint("game-end", true);
  await authority.flushFinalProjection();
  const projected = projectionBatches.flat();
  const archiveInsert = projected.find((statement) => /INSERT INTO game_result_archives/.test(statement.sql));
  assert.ok(archiveInsert);
  const archive = JSON.parse(String(archiveInsert.bindings[5])) as { leaderboard: Array<{ playerId: string }>; questionScores: unknown[] };
  assert.deepEqual(archive.leaderboard.map((entry) => entry.playerId), ["p0"]);
  assert.deepEqual(archive.questionScores, []);
  assert.equal(projected.some((statement) => /INSERT INTO (game_participants|player_scores|question_results)/.test(statement.sql)), false);
});

test("TEAM_BATTLE skip waits for presenter confirmation before advancing the turn", () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "GUESS_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    voteDeadlineAt: new Date(1000).toISOString(), revealVotes: {}, guessVotes: { p0: { type: "skip" } }, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  const host = socketFor(state, "host");
  authority.handleMutation(host, envelope("host", 1, "finalizeTeamBattleVote", teamVoteFallbackPayload(aggregate.gameSession!)), 1000);
  assert.equal(authority.getAggregate()?.gameSession?.teamBattleState?.phase, "TURN_RESULT");
  assert.equal(authority.getAggregate()?.gameSession?.teamBattleState?.turnNumber, 1);
  assert.equal(authority.getAggregate()?.gameSession?.currentRevealRound, 1);
  assert.equal(authority.getAggregate()?.gameSession?.teamBattleState?.activeTeam, "red");
  assert.equal(authority.getDeadline(), null);

  const playerAttempt = authority.handleMutation(socketFor(state, "p0"), envelope("p0", 1, "advanceTeamBattleTurn", {
    playerId: "p0",
    expectedTurnNumber: 1,
  }), 1500);
  assert.match(playerAttempt.error ?? "", /出题人/);

  authority.handleMutation(host, envelope("host", 2, "advanceTeamBattleTurn", {
    presenterPlayerId: "host",
    expectedTurnNumber: 0,
  }), 1600);
  assert.equal(authority.getAggregate()?.gameSession?.teamBattleState?.phase, "TURN_RESULT");

  authority.handleMutation(host, envelope("host", 3, "advanceTeamBattleTurn", {
    presenterPlayerId: "host",
    expectedTurnNumber: 1,
  }), 2000);
  assert.equal(authority.getAggregate()?.gameSession?.teamBattleState?.turnNumber, 2);
  assert.equal(authority.getAggregate()?.gameSession?.currentRevealRound, 2);
  assert.equal(authority.getAggregate()?.gameSession?.teamBattleState?.activeTeam, "blue");
});

test("TEAM_BATTLE turn result survives hibernation and waits after the acting team leaves", async () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "TURN_RESULT", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    voteDeadlineAt: null, revealVotes: {}, guessVotes: {}, previousTurnAction: { team: "red", type: "skip" }, pendingGuess: null, teamScores: { red: 0, blue: 0 }, message: "红队选择不猜。",
  };
  aggregate.deadline = null;
  authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 1, "advanceTeamBattleTurn", { presenterPlayerId: "host", expectedTurnNumber: 0 }),
    1000,
  );
  await authority.forceCheckpoint("phase-boundary");

  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  restored.handleMutation(
    socketFor(state, "p0"),
    envelope("p0", 1, "leaveRoom", { playerId: "p0" }),
    1500,
  );
  const waiting = restored.getAggregate()!.gameSession!.teamBattleState!;
  assert.equal(waiting.phase, "TURN_RESULT");
  assert.equal(waiting.activeTeam, "red");
  assert.deepEqual(waiting.previousTurnAction, { team: "red", type: "skip" });
  assert.equal(restored.getDeadline(), null);

  restored.handleMutation(
    socketFor(state, "host"),
    envelope("host", 2, "advanceTeamBattleTurn", { presenterPlayerId: "host", expectedTurnNumber: 1 }),
    2000,
  );
  assert.equal(restored.getAggregate()!.gameSession!.teamBattleState!.phase, "REVEAL_VOTE");
  assert.equal(restored.getAggregate()!.gameSession!.teamBattleState!.activeTeam, "blue");
  assert.equal(restored.getAggregate()!.gameSession!.teamBattleState!.turnNumber, 2);
  assert.ok(restored.getDeadline());
});

test("legacy journal recovery does not switch teams while TEAM_BATTLE waits on a turn result", () => {
  const storage = new StorageAdapter();
  const authority = new RoomGameAuthority(storage as unknown as DurableObjectStorage, fakeD1);
  authority.initializeSchema();
  const now = new Date(0).toISOString();
  const teamState = {
    teams: { red: ["p0"], blue: ["p1"] },
    initialTeams: { red: ["p0"], blue: ["p1"] },
    activeTeam: "red",
    phase: "TURN_RESULT",
    revealBlockCount: 45,
    revealLimit: 1,
    turnNumber: 1,
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    previousTurnAction: { team: "red", type: "skip" },
    pendingGuess: null,
    teamScores: { red: 0, blue: 0 },
  };
  storage.sql.db.prepare(
    "INSERT INTO authority_meta(room_id,hydrated_at,active_game_id,epoch,state_version) VALUES(?,?,?,?,?)",
  ).run("r1", now, "g1", "epoch-1", 0);
  storage.sql.db.prepare(
    "INSERT INTO rooms(id,room_code,host_player_id,game_status,current_presenter_player_id,current_game_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("r1", "ROOM01", "host", "PLAYING", "host", "g1", now, now);
  storage.sql.db.prepare(
    "INSERT INTO players(id,room_id,nickname,is_host,joined_at,last_seen_at,role) VALUES(?,?,?,?,?,?,?)",
  ).run("host", "r1", "Host", 1, now, now, "PLAYER");
  storage.sql.db.prepare(
    "INSERT INTO players(id,room_id,nickname,is_host,joined_at,last_seen_at,role) VALUES(?,?,?,?,?,?,?)",
  ).run("p1", "r1", "Blue", 0, now, now, "PLAYER");
  storage.sql.db.prepare(
    "INSERT INTO game_sessions(id,room_id,question_set_id,presenter_player_id,status,game_mode,team_battle_state,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("g1", "r1", "qs1", "host", "PLAYING", "TEAM_BATTLE", JSON.stringify(teamState), now);

  authority.beginMutation("r1", "advanceTeamBattleTurn", null, [{ gameSessionId: "g1" }]);
  authority.recoverIncompleteMutation("r1");

  const recoveredRow = storage.sql.db.prepare("SELECT team_battle_state FROM game_sessions WHERE id='g1'").get() as { team_battle_state: string };
  const recovered = JSON.parse(recoveredRow.team_battle_state) as typeof teamState;
  assert.deepEqual(recovered.teams.red, []);
  assert.deepEqual(recovered.teams.blue, ["p1"]);
  assert.equal(recovered.phase, "TURN_RESULT");
  assert.equal(recovered.activeTeam, "red");
  assert.deepEqual(recovered.previousTurnAction, { team: "red", type: "skip" });
  assert.equal(recovered.voteDeadlineAt, null);
});

test("TEAM_BATTLE presenter fallback settles only after the authoritative deadline", () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    voteDeadlineAt: new Date(1000).toISOString(), revealVotes: { p0: [4] }, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };

  const playerAttempt = authority.handleMutation(
    socketFor(state, "p0"),
    envelope("p0", 1, "finalizeTeamBattleVote", { playerId: "p0" }),
    1000,
  );
  assert.equal(playerAttempt.terminal, true);
  assert.match(playerAttempt.error ?? "", /出题人/);
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "REVEAL_VOTE");

  const host = socketFor(state, "host");
  const fallbackPayload = {
    presenterPlayerId: "host",
    expectedPhase: "REVEAL_VOTE",
    expectedTurnNumber: 1,
    expectedVoteDeadlineAt: new Date(1000).toISOString(),
  };
  const earlyAttempt = authority.handleMutation(
    host,
    envelope("host", 1, "finalizeTeamBattleVote", fallbackPayload),
    999,
  );
  assert.equal(earlyAttempt.error, undefined);
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "REVEAL_VOTE");

  const staleAttempt = authority.handleMutation(
    host,
    envelope("host", 2, "finalizeTeamBattleVote", { ...fallbackPayload, expectedTurnNumber: 0 }),
    1000,
  );
  assert.equal(staleAttempt.error, undefined);
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "REVEAL_VOTE");

  const settled = authority.handleMutation(
    host,
    envelope("host", 3, "finalizeTeamBattleVote", fallbackPayload),
    1000,
  );
  assert.equal(settled.error, undefined);
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "GUESS_VOTE");
  assert.deepEqual(aggregate.gameSession!.revealedBlocks, [4]);
});

test("TEAM_BATTLE Alarm and presenter fallback settle the same deadline only once in either order", async () => {
  const createScenario = () => {
    const created = createAuthority(2);
    const aggregate = created.authority.getAggregate()!;
    aggregate.gameSession!.gameMode = "TEAM_BATTLE";
    aggregate.gameSession!.teamBattleState = {
      teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
      voteDeadlineAt: new Date(1000).toISOString(), revealVotes: { p0: [4] }, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
    };
    aggregate.deadline = { kind: "team-vote", gameId: "g1", questionIndex: 0, phaseKey: "REVEAL_VOTE:1", runAtMs: 1000 };
    return { ...created, aggregate, fallbackPayload: teamVoteFallbackPayload(aggregate.gameSession!) };
  };

  const fallbackFirst = createScenario();
  fallbackFirst.authority.handleMutation(
    socketFor(fallbackFirst.state, "host"),
    envelope("host", 1, "finalizeTeamBattleVote", fallbackFirst.fallbackPayload),
    1000,
  );
  assert.equal(await fallbackFirst.authority.executeDueDeadline(1000), null);
  assert.deepEqual(fallbackFirst.aggregate.gameSession!.revealedBlocks, [4]);
  assert.equal(fallbackFirst.aggregate.gameSession!.teamBattleState!.phase, "GUESS_VOTE");

  const alarmFirst = createScenario();
  const alarmOutcome = await alarmFirst.authority.executeDueDeadline(1000);
  assert.ok(alarmOutcome);
  alarmFirst.authority.handleMutation(
    socketFor(alarmFirst.state, "host"),
    envelope("host", 1, "finalizeTeamBattleVote", alarmFirst.fallbackPayload),
    1001,
  );
  assert.deepEqual(alarmFirst.aggregate.gameSession!.revealedBlocks, [4]);
  assert.equal(alarmFirst.aggregate.gameSession!.teamBattleState!.phase, "GUESS_VOTE");
  assert.equal(alarmFirst.aggregate.gameSession!.teamBattleState!.turnNumber, 1);
});

test("TEAM_BATTLE reveal vote randomly selects within a highest-vote tie", () => {
  const { state, authority } = createAuthority(3, fakeD1, 1, () => 0);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0", "p1"], blue: ["p2"] }, initialTeams: { red: ["p0", "p1"], blue: ["p2"] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    voteDeadlineAt: new Date(1000).toISOString(), revealVotes: { p0: [0], p1: [1] }, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "finalizeTeamBattleVote", teamVoteFallbackPayload(aggregate.gameSession!)), 1000);
  assert.equal(aggregate.gameSession!.revealedBlocks.length, 1);
  assert.ok([0, 1].includes(aggregate.gameSession!.revealedBlocks[0]));
  assert.match(aggregate.gameSession!.teamBattleState!.message ?? "", /多个方块同票，随机选择/);
});

test("TEAM_BATTLE guess vote randomly selects within a highest-vote tie", () => {
  const { state, authority } = createAuthority(3, fakeD1, 1, () => 0);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0", "p1"], blue: ["p2"] }, initialTeams: { red: ["p0", "p1"], blue: ["p2"] }, activeTeam: "red", phase: "GUESS_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    voteDeadlineAt: new Date(1000).toISOString(), revealVotes: {}, guessVotes: { p0: { type: "skip" }, p1: { type: "guess", answerText: "答案" } }, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "finalizeTeamBattleVote", teamVoteFallbackPayload(aggregate.gameSession!)), 1000);
  assert.equal(aggregate.gameSession!.teamBattleState!.previousTurnAction?.type, "skip");
  assert.match(aggregate.gameSession!.teamBattleState!.message ?? "", /最高票选项票数相同，随机选择了不猜/);
});

test("TEAM_BATTLE new questions wait for one presenter block selection without an Alarm", async () => {
  const { state, authority } = createAuthority(2, fakeD1, 2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.revealedBlocks = Array.from({ length: 45 }, (_, index) => index);
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "REVIEW", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 13, guessVoteSeconds: 17, voteDeadlineAt: null, revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };

  const advanced = authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 1, "advanceReviewedQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0 }),
    1_000,
  );
  assert.equal(advanced.error, undefined);
  assert.equal(aggregate.gameSession!.teamBattleState?.phase, "PRESENTER_BLOCK");
  assert.deepEqual(aggregate.gameSession!.teamBattleState?.disabledBlocks, []);
  assert.equal(aggregate.gameSession!.teamBattleState?.voteDeadlineAt, null);
  assert.equal(authority.getDeadline(), null);
  assert.equal(await state.storage.getAlarm(), null);
});

test("TEAM_BATTLE only the presenter can complete an empty or portrait block selection", () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "PRESENTER_BLOCK", revealBlockCount: 45, disabledBlocks: [], revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 13, guessVoteSeconds: 17, voteDeadlineAt: null, revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };

  const rejected = authority.handleMutation(
    socketFor(state, "p0"),
    envelope("p0", 1, "completeTeamBattleBlockSelection", { presenterPlayerId: "p0", disabledBlocks: [], revealBlockCount: 45 }),
    1_000,
  );
  assert.match(rejected.error ?? "", /出题人/);
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "PRESENTER_BLOCK");
  assert.equal(authority.getDeadline(), null);

  const completed = authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 1, "completeTeamBattleBlockSelection", { presenterPlayerId: "host", disabledBlocks: [34, 0, 35, 34, -1], revealBlockCount: 35 }),
    2_000,
  );
  assert.equal(completed.error, undefined);
  assert.equal(completed.forceCheckpoint, "phase-boundary");
  assert.equal(completed.deadlineChanged, true);
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "REVEAL_VOTE");
  assert.equal(aggregate.gameSession!.teamBattleState.revealBlockCount, 35);
  assert.deepEqual(aggregate.gameSession!.teamBattleState.disabledBlocks, [0, 34]);
  assert.equal(aggregate.gameSession!.teamBattleState.voteDeadlineAt, new Date(15_000).toISOString());
  assert.equal(authority.getDeadline()?.runAtMs, 15_000);
});

test("TEAM_BATTLE disabled blocks cannot be voted and revealLimit shrinks to one selectable block", () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "PRESENTER_BLOCK", revealBlockCount: 45, disabledBlocks: [], revealLimit: 2, turnNumber: 1,
    revealVoteSeconds: 10, guessVoteSeconds: 20, voteDeadlineAt: null, revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  const disabledBlocks = Array.from({ length: 44 }, (_, index) => index);
  authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 1, "completeTeamBattleBlockSelection", { presenterPlayerId: "host", disabledBlocks, revealBlockCount: 45 }),
    1_000,
  );

  const player = socketFor(state, "p0");
  const blocked = authority.handleMutation(
    player,
    envelope("p0", 1, "submitTeamBattleRevealVote", { playerId: "p0", selectedBlocks: [0], revealBlockCount: 45 }),
    2_000,
  );
  assert.match(blocked.error ?? "", /数量不正确/);
  assert.deepEqual(aggregate.gameSession!.teamBattleState.revealVotes, {});

  const oneRemaining = authority.handleMutation(
    player,
    envelope("p0", 2, "submitTeamBattleRevealVote", { playerId: "p0", selectedBlocks: [44], revealBlockCount: 45 }),
    2_001,
  );
  assert.equal(oneRemaining.error, undefined);
  assert.deepEqual(aggregate.gameSession!.teamBattleState.revealVotes.p0, [44]);
  const deadline = authority.getDeadline()!.runAtMs;
  const finalized = authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 2, "finalizeTeamBattleVote", teamVoteFallbackPayload(aggregate.gameSession!)),
    deadline,
  );
  assert.equal(finalized.error, undefined);
  assert.deepEqual(aggregate.gameSession!.revealedBlocks, [44]);
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "GUESS_VOTE");
});

test("TEAM_BATTLE all-disabled questions keep alternating guess-only turns", () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "PRESENTER_BLOCK", revealBlockCount: 45, disabledBlocks: [], revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 10, guessVoteSeconds: 20, voteDeadlineAt: null, revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  const allBlocks = Array.from({ length: 45 }, (_, index) => index);
  authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 1, "completeTeamBattleBlockSelection", { presenterPlayerId: "host", disabledBlocks: allBlocks, revealBlockCount: 45 }),
    1_000,
  );
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "GUESS_VOTE");
  assert.equal(aggregate.gameSession!.teamBattleState.activeTeam, "red");

  authority.handleMutation(
    socketFor(state, "p0"),
    envelope("p0", 1, "submitTeamBattleGuessVote", { playerId: "p0", vote: { type: "skip" } }),
    2_000,
  );
  authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 2, "finalizeTeamBattleVote", teamVoteFallbackPayload(aggregate.gameSession!)),
    authority.getDeadline()!.runAtMs,
  );
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "TURN_RESULT");
  assert.equal(aggregate.gameSession!.teamBattleState.activeTeam, "red");
  assert.equal(authority.getDeadline(), null);
  authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 3, "advanceTeamBattleTurn", { presenterPlayerId: "host", expectedTurnNumber: 1 }),
    30_000,
  );
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "GUESS_VOTE");
  assert.equal(aggregate.gameSession!.teamBattleState.activeTeam, "blue");

  authority.handleMutation(
    socketFor(state, "p1"),
    envelope("p1", 1, "submitTeamBattleGuessVote", { playerId: "p1", vote: { type: "guess", answerText: "错误答案" } }),
    authority.getDeadline()!.runAtMs - 1,
  );
  authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 4, "finalizeTeamBattleVote", teamVoteFallbackPayload(aggregate.gameSession!)),
    authority.getDeadline()!.runAtMs,
  );
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "JUDGING");
  const judged = authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 5, "judgeTeamBattleGuess", { presenterPlayerId: "host", isCorrect: false }),
    50_000,
  );
  assert.equal(judged.error, undefined);
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "TURN_RESULT");
  assert.equal(aggregate.gameSession!.teamBattleState.activeTeam, "blue");
  assert.equal(authority.getDeadline(), null);
  authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 6, "advanceTeamBattleTurn", { presenterPlayerId: "host", expectedTurnNumber: 2 }),
    60_000,
  );
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "GUESS_VOTE");
  assert.equal(aggregate.gameSession!.teamBattleState.activeTeam, "red");
  assert.deepEqual(aggregate.gameSession!.revealedBlocks, []);
});

test("TEAM_BATTLE presenter block phase and legacy states survive hibernation compatibly", async () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "PRESENTER_BLOCK", revealBlockCount: 45, disabledBlocks: [], revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 10, guessVoteSeconds: 20, voteDeadlineAt: null, revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  aggregate.deadline = null;
  authority.handleMutation(null, envelope("p0", 1, "joinRoom", { nickname: "P0", role: "PLAYER" }), 1_000);
  await authority.forceCheckpoint("phase-boundary");

  state.sockets.length = 0;
  const restoredBlock = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restoredBlock.restoreFromStorage();
  assert.equal(restoredBlock.getAggregate()?.gameSession?.teamBattleState?.phase, "PRESENTER_BLOCK");
  assert.equal(restoredBlock.getAggregate()?.gameSession?.teamBattleState?.voteDeadlineAt, null);
  assert.equal(restoredBlock.getDeadline(), null);
  assert.equal(await state.storage.getAlarm(), null);

  const restoredAggregate = restoredBlock.getAggregate()!;
  restoredAggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 10, guessVoteSeconds: 20, voteDeadlineAt: new Date(12_000).toISOString(), revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  restoredAggregate.deadline = { kind: "team-vote", gameId: "g1", questionIndex: 0, phaseKey: "REVEAL_VOTE:1", runAtMs: 12_000 };
  restoredBlock.handleMutation(null, envelope("p1", 1, "joinRoom", { nickname: "P1", role: "PLAYER" }), 2_000);
  await restoredBlock.forceCheckpoint("phase-boundary");

  const restoredLegacy = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restoredLegacy.restoreFromStorage();
  assert.equal(restoredLegacy.getAggregate()?.gameSession?.teamBattleState?.phase, "REVEAL_VOTE");
  assert.equal(restoredLegacy.getAggregate()?.gameSession?.teamBattleState?.disabledBlocks, undefined);
  assert.equal(restoredLegacy.getDeadline()?.runAtMs, 12_000);
});

test("manual TEAM_BATTLE join records the chosen team for the next question only", () => {
  const { authority } = createAuthority(2, fakeD1, 2);
  const aggregate = authority.getAggregate()!;
  aggregate.room!.teamAssignmentMode = "MANUAL";
  aggregate.room!.teamAssignments = { p0: "red", p1: "blue" };
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.eligiblePlayerIds = ["p0", "p1"];
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] },
    initialTeams: { red: ["p0"], blue: ["p1"] },
    activeTeam: "red",
    phase: "REVIEW",
    revealBlockCount: 45,
    revealLimit: 1,
    turnNumber: 1,
    revealVotes: {},
    guessVotes: {},
    teamScores: { red: 0, blue: 0 },
  };
  enterReview(authority);

  const rejected = authority.handleMutation(null, envelope("late", 1, "joinRoom", { nickname: "Late", role: "PLAYER" }), Date.now());
  assert.match(rejected.error ?? "", /请先选择加入红队或蓝队/);
  assert.equal(aggregate.players.some((player) => player.id === "late"), false);

  const joined = authority.handleMutation(null, envelope("late", 2, "joinRoom", { nickname: "Late", role: "PLAYER", team: "blue" }), Date.now() + 1);
  assert.equal(joined.error, undefined);
  assert.deepEqual(aggregate.gameSession.teamBattleState.teams, { red: ["p0"], blue: ["p1"] });
  assert.deepEqual(aggregate.gameSession.teamBattleState.initialTeams, { red: ["p0"], blue: ["p1", "late"] });
  assert.equal(aggregate.room.teamAssignments?.late, "blue");

  const advanced = authority.handleMutation(null, envelope("host", 1, "advanceReviewedQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0 }), Date.now() + 1);
  assert.equal(advanced.error, undefined);
  assert.equal(aggregate.gameSession.currentQuestionIndex, 1);
  assert.deepEqual(aggregate.gameSession.teamBattleState?.teams, { red: ["p0"], blue: ["p1", "late"] });
});

test("cancel after a scored question projects only the lobby handoff", async () => {
  const { state, authority, d1 } = createSqliteProjectionAuthority(2, 2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 15, guessVoteSeconds: 50, voteDeadlineAt: null, revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 1, blue: 0 },
  };
  aggregate.scores.find((score) => score.playerId === "p0")!.score = 5;
  aggregate.scores.find((score) => score.playerId === "p0")!.correctCount = 1;
  aggregate.questionResults = [{ id: "g1:0:p0", gameSessionId: "g1", questionIndex: 0, playerId: "p0", scoredRound: 1, scoreAwarded: 5, judgedByPlayerId: "host", judgedAt: new Date().toISOString() }];

  const reviewed = authority.handleMutation(null, envelope("host", 1, "revealTeamBattleAnswer", { presenterPlayerId: "host" }), Date.now());
  await authority.forceCheckpoint(reviewed.forceCheckpoint!);
  const advanced = authority.handleMutation(null, envelope("host", 2, "advanceReviewedQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0 }), Date.now() + 1);
  await authority.forceCheckpoint(advanced.forceCheckpoint!, advanced.archiveQuestion);
  assert.equal(state.storage.sql.db.prepare("SELECT COUNT(*) count FROM authority_vnext_question_archive WHERE game_id='g1'").get().count, 1);
  assert.equal(authority.getAggregate()?.gameSession?.currentQuestionIndex, 1);
  const blockCompleted = authority.handleMutation(null, {
    ...envelope("host", 3, "completeTeamBattleBlockSelection", { presenterPlayerId: "host", disabledBlocks: [], revealBlockCount: 45 }),
    questionIndex: 1,
  }, Date.now() + 2);
  await authority.forceCheckpoint(blockCompleted.forceCheckpoint!);
  const alarmAt = authority.getDeadline()!.runAtMs;
  await state.storage.setAlarm(alarmAt);

  const cancelAction = { ...envelope("host", 4, "cancelCurrentRound", { roomId: "r1", hostPlayerId: "host" }), questionIndex: 1 };
  const canceled = authority.handleMutation(
    null,
    cancelAction,
    Date.now() + 2,
  );
  state.storage.sql.failOn = "authority_vnext_active_game";
  await assert.rejects(authority.forceCheckpoint(canceled.forceCheckpoint!), /injected migration failure/);
  assert.equal(state.storage.sql.db.prepare("SELECT cutover_state FROM authority_vnext_active_game WHERE id=1").get().cutover_state, "active");
  assert.equal(await state.storage.getAlarm(), alarmAt);

  authority.resetAfterFailedTransition();
  state.storage.sql.failOn = "";
  await authority.restoreFromStorage();
  assert.equal(authority.getAggregate()?.cutoverState, "active");
  const retried = authority.handleMutation(null, cancelAction, Date.now() + 3);
  await authority.forceCheckpoint(retried.forceCheckpoint!);

  const outbox = state.storage.sql.db.prepare("SELECT payload_json FROM authority_vnext_projection_outbox WHERE id=1").get() as { payload_json: string };
  const payload = JSON.parse(outbox.payload_json) as { games: Array<{ archive?: unknown; room?: Room }> };
  assert.equal(payload.games[0]?.archive, undefined);
  assert.equal(payload.games[0]?.room?.status, "LOBBY");

  assert.equal(await authority.flushFinalProjection(), true);
  assert.equal(d1.db.prepare("SELECT COUNT(*) count FROM game_result_archives").get().count, 0);
  assert.equal(d1.db.prepare("SELECT game_status FROM rooms WHERE id='r1'").get().game_status, "LOBBY");
});

test("HTTP and WebSocket force checkpoints both discard failed provisional state", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  const guardedCheckpointPattern = /try\s*{\s*receipt = await this\.authorityVNext\.forceCheckpoint\([^;]+;\s*}\s*catch \(error\) {\s*this\.authorityVNext\.resetAfterFailedTransition\(\);/g;
  assert.equal([...worker.matchAll(guardedCheckpointPattern)].length, 2);
});

test("Alarm wake restores vNext without rescheduling the Alarm that is already executing", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /handleAlarm[\s\S]{0,700}restoreVNextAuthority\(\{ reconcileAlarm: false }\)/);
});

test("TEAM_BATTLE shortens to five seconds after all submit without extending on edits", () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0", "p1"], blue: [] }, initialTeams: { red: ["p0", "p1"], blue: [] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 15, guessVoteSeconds: 50, voteDeadlineAt: new Date(16_000).toISOString(), revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  aggregate.deadline = { kind: "team-vote", gameId: "g1", questionIndex: 0, phaseKey: "REVEAL_VOTE:1", runAtMs: 16_000 };
  const p0 = socketFor(state, "p0");
  const p1 = socketFor(state, "p1");

  const partial = authority.handleMutation(p0, envelope("p0", 1, "submitTeamBattleRevealVote", { playerId: "p0", selectedBlocks: [0], revealBlockCount: 45 }), 1_000);
  assert.equal(partial.deadlineChanged, false);
  assert.equal(authority.getDeadline()?.runAtMs, 16_000);
  const completed = authority.handleMutation(p1, envelope("p1", 1, "submitTeamBattleRevealVote", { playerId: "p1", selectedBlocks: [1], revealBlockCount: 45 }), 2_000);
  assert.equal(completed.deadlineChanged, true);
  assert.equal(completed.forceCheckpoint, "phase-boundary");
  assert.equal(aggregate.gameSession!.teamBattleState.voteDeadlineAt, new Date(7_000).toISOString());
  assert.equal(authority.getDeadline()?.runAtMs, 7_000);

  const edited = authority.handleMutation(p0, envelope("p0", 2, "submitTeamBattleRevealVote", { playerId: "p0", selectedBlocks: [2], revealBlockCount: 45 }), 6_999);
  assert.equal(edited.error, undefined);
  assert.equal(edited.deadlineChanged, false);
  assert.equal(edited.forceCheckpoint, undefined);
  assert.equal(authority.getDeadline()?.runAtMs, 7_000);
  assert.deepEqual(aggregate.gameSession!.teamBattleState.revealVotes.p0, [2]);
  const late = authority.handleMutation(p0, envelope("p0", 3, "submitTeamBattleRevealVote", { playerId: "p0", selectedBlocks: [3], revealBlockCount: 45 }), 7_000);
  assert.equal(late.terminal, true);
  assert.match(late.error ?? "", /时间已结束/);
  assert.deepEqual(aggregate.gameSession!.teamBattleState.revealVotes.p0, [2]);
});

test("TEAM_BATTLE all-submitted grace never extends a guess deadline with five seconds or less remaining", () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0", "p1"], blue: [] }, initialTeams: { red: ["p0", "p1"], blue: [] }, activeTeam: "red", phase: "GUESS_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 15, guessVoteSeconds: 50, voteDeadlineAt: new Date(6_000).toISOString(), revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  aggregate.deadline = { kind: "team-vote", gameId: "g1", questionIndex: 0, phaseKey: "GUESS_VOTE:1", runAtMs: 6_000 };
  authority.handleMutation(socketFor(state, "p0"), envelope("p0", 1, "submitTeamBattleGuessVote", { playerId: "p0", vote: { type: "skip" } }), 1_000);
  const completed = authority.handleMutation(socketFor(state, "p1"), envelope("p1", 1, "submitTeamBattleGuessVote", { playerId: "p1", vote: { type: "guess", answerText: "答案" } }), 2_000);
  assert.equal(completed.deadlineChanged, false);
  assert.equal(completed.forceCheckpoint, undefined);
  assert.equal(authority.getDeadline()?.runAtMs, 6_000);
  assert.equal(aggregate.gameSession!.teamBattleState.voteDeadlineAt, new Date(6_000).toISOString());
});

test("TEAM_BATTLE 50-player submission burst requests exactly one deadline reschedule", () => {
  const { state, authority } = createAuthority(50);
  const aggregate = authority.getAggregate()!;
  const members = Array.from({ length: 50 }, (_, index) => `p${index}`);
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: members, blue: [] }, initialTeams: { red: members, blue: [] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 60, guessVoteSeconds: 60, voteDeadlineAt: new Date(60_000).toISOString(), revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  aggregate.deadline = { kind: "team-vote", gameId: "g1", questionIndex: 0, phaseKey: "REVEAL_VOTE:1", runAtMs: 60_000 };

  const initialOutcomes = members.map((playerId, index) => authority.handleMutation(
    socketFor(state, playerId),
    envelope(playerId, 1, "submitTeamBattleRevealVote", { playerId, selectedBlocks: [0], revealBlockCount: 45 }),
    1_000 + index,
  ));
  assert.equal(initialOutcomes.filter((outcome) => outcome.deadlineChanged).length, 1);
  assert.equal(initialOutcomes.filter((outcome) => outcome.forceCheckpoint === "phase-boundary").length, 1);
  assert.equal(authority.getDeadline()?.runAtMs, 6_049);

  const editChanges = members.map((playerId, index) => authority.handleMutation(
    state.sockets[index] as unknown as WebSocket,
    envelope(playerId, 2, "submitTeamBattleRevealVote", { playerId, selectedBlocks: [1], revealBlockCount: 45 }),
    2_000 + index,
  ).deadlineChanged);
  assert.equal(editChanges.filter(Boolean).length, 0);
  assert.equal(authority.getDeadline()?.runAtMs, 6_049);
});

test("TEAM_BATTLE partial reveal votes count only submissions and start the configured guess deadline", () => {
  const { state, authority } = createAuthority(3, fakeD1, 1, () => 0);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0", "p1"], blue: ["p2"] }, initialTeams: { red: ["p0", "p1"], blue: ["p2"] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 3, guessVoteSeconds: 7, voteDeadlineAt: new Date(1_000).toISOString(), revealVotes: { p0: [5] }, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  aggregate.deadline = { kind: "team-vote", gameId: "g1", questionIndex: 0, phaseKey: "REVEAL_VOTE:1", runAtMs: 1_000 };

  authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "finalizeTeamBattleVote", teamVoteFallbackPayload(aggregate.gameSession!)), 1_000);
  assert.deepEqual(aggregate.gameSession!.revealedBlocks, [5]);
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "GUESS_VOTE");
  assert.equal(aggregate.gameSession!.teamBattleState.voteDeadlineAt, new Date(8_000).toISOString());
  assert.equal(authority.getDeadline()?.runAtMs, 8_000);
});

test("TEAM_BATTLE zero votes randomize reveal and treat guess as skip with fresh fixed deadlines", () => {
  const { state, authority } = createAuthority(2, fakeD1, 1, () => 0);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 3, guessVoteSeconds: 7, voteDeadlineAt: new Date(1_000).toISOString(), revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  aggregate.deadline = { kind: "team-vote", gameId: "g1", questionIndex: 0, phaseKey: "REVEAL_VOTE:1", runAtMs: 1_000 };
  const host = socketFor(state, "host");

  authority.handleMutation(host, envelope("host", 1, "finalizeTeamBattleVote", teamVoteFallbackPayload(aggregate.gameSession!)), 1_000);
  assert.equal(aggregate.gameSession!.revealedBlocks.length, 1);
  assert.match(aggregate.gameSession!.teamBattleState.message ?? "", /多个方块同票，随机选择/);
  assert.equal(authority.getDeadline()?.runAtMs, 8_000);

  authority.handleMutation(host, envelope("host", 2, "finalizeTeamBattleVote", teamVoteFallbackPayload(aggregate.gameSession!)), 8_000);
  const teamState = aggregate.gameSession!.teamBattleState;
  assert.equal(teamState.phase, "TURN_RESULT");
  assert.equal(teamState.activeTeam, "red");
  assert.equal(teamState.previousTurnAction?.type, "skip");
  assert.match(teamState.message ?? "", /无人提交，视为不猜/);
  assert.equal(teamState.voteDeadlineAt, null);
  assert.equal(authority.getDeadline(), null);
  authority.handleMutation(host, envelope("host", 3, "advanceTeamBattleTurn", {
    presenterPlayerId: "host",
    expectedTurnNumber: 1,
  }), 9_000);
  assert.equal(teamState.phase, "REVEAL_VOTE");
  assert.equal(teamState.activeTeam, "blue");
  assert.equal(teamState.voteDeadlineAt, new Date(12_000).toISOString());
  assert.equal(authority.getDeadline()?.runAtMs, 12_000);
});

test("TEAM_BATTLE shortened deadline survives checkpoint and hibernation restore", async () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 15, guessVoteSeconds: 50, voteDeadlineAt: new Date(16_000).toISOString(), revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  aggregate.deadline = { kind: "team-vote", gameId: "g1", questionIndex: 0, phaseKey: "REVEAL_VOTE:1", runAtMs: 16_000 };
  const submitted = authority.handleMutation(
    socketFor(state, "p0"),
    envelope("p0", 1, "submitTeamBattleRevealVote", { playerId: "p0", selectedBlocks: [0], revealBlockCount: 45 }),
    1_000,
  );
  assert.equal(submitted.error, undefined);
  await authority.forceCheckpoint("phase-boundary");
  await state.storage.setAlarm(16_000);

  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  assert.equal(restored.getDeadline()?.runAtMs, 6_000);
  assert.equal(restored.getAggregate()?.gameSession?.teamBattleState?.voteDeadlineAt, new Date(6_000).toISOString());
  assert.equal(restored.hasPendingDeadlineRepair(), true, "a restored deadline must verify and repair the physical Alarm once");
  assert.equal(await state.storage.getAlarm(), 16_000, "authority restore must not mutate the Alarm outside the Room DO wrapper");
});

test("legacy active TEAM_BATTLE state without a deadline receives defaults once on restore", async () => {
  const { state, authority } = createAuthority(2);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: ["p1"] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    voteDeadlineAt: null, revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  aggregate.deadline = null;
  const submitted = authority.handleMutation(
    socketFor(state, "p0"),
    envelope("p0", 1, "submitTeamBattleRevealVote", { playerId: "p0", selectedBlocks: [4], revealBlockCount: 45 }),
    1_000,
  );
  assert.equal(submitted.error, undefined);
  await authority.forceCheckpoint("phase-boundary");

  const beforeRestore = Date.now();
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  const restoredState = restored.getAggregate()!.gameSession!.teamBattleState!;
  const runAtMs = restored.getDeadline()!.runAtMs;
  assert.equal(restoredState.revealVoteSeconds, 25);
  assert.equal(restoredState.guessVoteSeconds, 50);
  assert.deepEqual(restoredState.revealVotes.p0, [4]);
  assert.ok(runAtMs >= beforeRestore + 25_000 && runAtMs <= Date.now() + 25_000);
  assert.equal(new Date(restoredState.voteDeadlineAt!).getTime(), runAtMs);
  assert.equal(restored.hasPendingDeadlineRepair(), true, "Room DO must reconcile the repaired deadline to one Alarm");
  assert.equal(restored.hasPendingDeadlineRepair(), true, "a failed Alarm reconcile must leave the repair pending");
  restored.acknowledgeDeadlineRepair();
  assert.equal(restored.hasPendingDeadlineRepair(), false, "only a successful Alarm reconcile may acknowledge the repair");
});

test("TEAM_BATTLE member leave shortens a now-complete vote or resets when the active team becomes empty", async () => {
  const { state, authority } = createAuthority(3);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0", "p1"], blue: ["p2"] }, initialTeams: { red: ["p0", "p1"], blue: ["p2"] }, activeTeam: "red", phase: "REVEAL_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 3, guessVoteSeconds: 7, voteDeadlineAt: new Date(20_000).toISOString(), revealVotes: { p0: [0], p1: [1] }, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  aggregate.deadline = { kind: "team-vote", gameId: "g1", questionIndex: 0, phaseKey: "REVEAL_VOTE:1", runAtMs: 20_000 };

  const p1Left = authority.handleMutation(socketFor(state, "p1"), envelope("p1", 1, "leaveRoom", { playerId: "p1" }), 5_000);
  assert.equal(p1Left.error, undefined);
  assert.equal(p1Left.forceCheckpoint, "phase-boundary");
  assert.equal(aggregate.gameSession!.teamBattleState.voteDeadlineAt, new Date(10_000).toISOString());
  assert.equal(authority.getDeadline()?.runAtMs, 10_000);
  assert.equal(aggregate.gameSession!.teamBattleState.revealVotes.p1, undefined);

  const p0Left = authority.handleMutation(socketFor(state, "p0"), envelope("p0", 1, "leaveRoom", { playerId: "p0" }), 6_000);
  assert.equal(p0Left.error, undefined);
  assert.equal(aggregate.gameSession!.teamBattleState.activeTeam, "blue");
  assert.equal(aggregate.gameSession!.teamBattleState.voteDeadlineAt, new Date(9_000).toISOString());
  assert.equal(authority.getDeadline()?.runAtMs, 9_000);
  assert.deepEqual(aggregate.gameSession!.teamBattleState.revealVotes, {});

  const p2Left = authority.handleMutation(socketFor(state, "p2"), envelope("p2", 1, "leaveRoom", { playerId: "p2" }), 7_000);
  assert.equal(p2Left.error, undefined);
  assert.equal(aggregate.gameSession!.teamBattleState.voteDeadlineAt, null);
  assert.equal(authority.getDeadline(), null);
  assert.match(aggregate.gameSession!.teamBattleState.message ?? "", /双方都没有在线队员/);
  await authority.forceCheckpoint("phase-boundary");
  const restored = new RoomAuthorityVNext(state as unknown as DurableObjectState, fakeD1);
  await restored.restoreFromStorage();
  assert.equal(restored.getDeadline(), null, "empty teams must remain paused after hibernation");
  assert.equal(restored.getAggregate()?.gameSession?.teamBattleState?.voteDeadlineAt, null);
  assert.equal(restored.hasPendingDeadlineRepair(), false, "empty teams must not schedule a repaired Alarm");
});

test("legacy TEAM_BATTLE member leave uses the same all-submitted grace", () => {
  const state = {
    teams: { red: ["p0", "p1"], blue: ["p2"] }, initialTeams: { red: ["p0", "p1"], blue: ["p2"] }, activeTeam: "red" as const, phase: "REVEAL_VOTE" as const, revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 15, guessVoteSeconds: 50, voteDeadlineAt: new Date(20_000).toISOString(), revealVotes: { p0: [0] }, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  const next = removePlayerFromTeamBattleState(state, "p1", 5_000);
  assert.deepEqual(next.teams.red, ["p0"]);
  assert.equal(next.voteDeadlineAt, new Date(10_000).toISOString());
});

test("TEAM_BATTLE skip keeps the only non-empty team and does not create an empty-team Alarm loop", () => {
  const { state, authority } = createAuthority(1);
  const aggregate = authority.getAggregate()!;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.teamBattleState = {
    teams: { red: ["p0"], blue: [] }, initialTeams: { red: ["p0"], blue: [] }, activeTeam: "red", phase: "GUESS_VOTE", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 3, guessVoteSeconds: 7, voteDeadlineAt: new Date(1_000).toISOString(), revealVotes: {}, guessVotes: { p0: { type: "skip" } }, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  aggregate.deadline = { kind: "team-vote", gameId: "g1", questionIndex: 0, phaseKey: "GUESS_VOTE:1", runAtMs: 1_000 };

  authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "finalizeTeamBattleVote", teamVoteFallbackPayload(aggregate.gameSession!)), 1_000);
  assert.equal(aggregate.gameSession!.teamBattleState.activeTeam, "red");
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "TURN_RESULT");
  assert.equal(authority.getDeadline(), null);
  authority.handleMutation(socketFor(state, "host"), envelope("host", 2, "advanceTeamBattleTurn", {
    presenterPlayerId: "host",
    expectedTurnNumber: 1,
  }), 2_000);
  assert.equal(aggregate.gameSession!.teamBattleState.activeTeam, "red");
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "REVEAL_VOTE");
  assert.equal(authority.getDeadline()?.runAtMs, 5_000);
});

test("TEAM_BATTLE remains paused when an empty roster advances from REVIEW", () => {
  const { state, authority } = createAuthority(2, fakeD1, 2);
  const aggregate = authority.getAggregate()!;
  aggregate.players = aggregate.players.filter((player) => player.id === "host");
  aggregate.room!.players = aggregate.players;
  aggregate.gameSession!.gameMode = "TEAM_BATTLE";
  aggregate.gameSession!.revealedBlocks = Array.from({ length: 45 }, (_, index) => index);
  aggregate.gameSession!.teamBattleState = {
    teams: { red: [], blue: [] }, initialTeams: { red: ["p0"], blue: ["p1"] }, activeTeam: "red", phase: "REVIEW", revealBlockCount: 45, revealLimit: 1, turnNumber: 1,
    revealVoteSeconds: 3, guessVoteSeconds: 7, voteDeadlineAt: null, revealVotes: {}, guessVotes: {}, previousTurnAction: null, pendingGuess: null, teamScores: { red: 0, blue: 0 },
  };
  aggregate.deadline = null;

  const advanced = authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 1, "advanceReviewedQuestion", { presenterPlayerId: "host", expectedQuestionIndex: 0 }),
    10_000,
  );
  assert.equal(advanced.error, undefined);
  assert.equal(aggregate.gameSession!.currentQuestionIndex, 1);
  assert.equal(aggregate.gameSession!.teamBattleState.phase, "PRESENTER_BLOCK");
  assert.equal(aggregate.gameSession!.teamBattleState.voteDeadlineAt, null);
  assert.equal(authority.getDeadline(), null);
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

test("final projection uses a dissolved tombstone and versioned roster projection", async () => {
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
  assert.equal(authority.hasPendingRoomHandoff(), true);
  assert.equal(await authority.flushRoomHandoff(), false);
  assert.equal((authority.query("getRoomWithPlayers", []) as Room).status, "LOBBY");
  const joined = authority.handleMutation(null, envelope("late", 1, "joinRoom", { nickname: "Late", role: "PLAYER" }), Date.now() + 1);
  assert.equal(joined.error, undefined);
  assert.equal(joined.forceCheckpoint, "projection");
  await authority.forceCheckpoint(joined.forceCheckpoint);
  assert.equal(authority.canStartAnotherGame(), true);
  assert.equal(state.storage.sql.db.prepare("SELECT COUNT(*) count FROM authority_vnext_projection_outbox").get().count, 1);
  shouldFail = false;
  assert.equal(await authority.flushRoomHandoff(), true);
  assert.equal(authority.hasPendingRoomHandoff(), false);
  assert.equal(state.storage.sql.db.prepare("SELECT COUNT(*) count FROM authority_vnext_projection_outbox").get().count, 0);
});

test("an ended event-age checkpoint cannot recreate a flushed lobby handoff and overwrite the next setup", async () => {
  const { state, authority, d1 } = createSqliteProjectionAuthority(1);
  const returned = authority.handleMutation(
    socketFor(state, "host"),
    envelope("host", 1, "returnRoomToLobby", { hostPlayerId: "host" }),
    Date.now(),
  );
  await authority.forceCheckpoint(returned.forceCheckpoint ?? "projection");
  assert.equal(await authority.flushFinalProjection(), true);
  assert.equal(authority.hasPendingFinalProjection(), false);
  assert.equal(d1.db.prepare("SELECT game_status FROM rooms WHERE id='r1'").get().game_status, "LOBBY");

  const staleAction = envelope("p0", 1, "submitAnswer", { playerId: "p0", answerText: "stale" });
  staleAction.questionIndex = 99;
  const rejected = authority.handleMutation(null, staleAction, Date.now() + 11_000);
  assert.equal(rejected.terminal, true);
  await authority.maybeCheckpoint("event-age");
  assert.equal(authority.hasPendingFinalProjection(), false);

  d1.db.prepare("UPDATE rooms SET game_status='QUESTION_SETUP' WHERE id='r1'").run();
  await authority.flushFinalProjection();

  assert.equal(
    d1.db.prepare("SELECT game_status FROM rooms WHERE id='r1'").get().game_status,
    "QUESTION_SETUP",
    "a generic ended checkpoint must not recreate and later flush a stale LOBBY handoff",
  );
});

test("an in-flight projection cannot erase a newer lobby roster payload", async () => {
  let releaseBatch!: () => void;
  let markBatchEntered!: () => void;
  const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
  const batchEntered = new Promise<void>((resolve) => { markBatchEntered = resolve; });
  let batchCalls = 0;
  const d1 = {
    prepare(sql: string) { return { bind(...bindings: unknown[]) { return { sql, bindings }; } }; },
    async batch() {
      batchCalls += 1;
      if (batchCalls === 1) {
        markBatchEntered();
        await batchGate;
      }
      return [];
    },
  } as unknown as D1Database;
  const { state, authority } = createAuthority(1, d1);
  const outcome = authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "returnRoomToLobby", { hostPlayerId: "host" }), Date.now());
  await authority.forceCheckpoint(outcome.forceCheckpoint ?? "projection");

  const firstFlush = authority.flushFinalProjection();
  const coalescedFlush = authority.flushFinalProjection();
  await batchEntered;
  assert.equal(batchCalls, 1, "concurrent flush calls must share one D1 batch");
  const joined = authority.handleMutation(null, envelope("late", 1, "joinRoom", { nickname: "Late", role: "PLAYER" }), Date.now() + 1);
  await authority.forceCheckpoint(joined.forceCheckpoint ?? "projection");
  releaseBatch();
  assert.equal(await firstFlush, false);
  assert.equal(await coalescedFlush, false);
  const pending = state.storage.sql.db.prepare("SELECT payload_json FROM authority_vnext_projection_outbox WHERE id=1").get() as { payload_json: string };
  assert.match(pending.payload_json, /\"id\":\"late\"/);

  assert.equal(await authority.flushRoomHandoff(), true);
  assert.equal(batchCalls, 2);
});

test("legacy projection outbox without a projection version still writes normalized result tables", async () => {
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const d1 = {
    prepare(sql: string) { return { bind(...bindings: unknown[]) { const statement = { sql, bindings }; statements.push(statement); return statement; } }; },
    async batch() { return []; },
  } as unknown as D1Database;
  const { state, authority } = createAuthority(1, d1);
  const start = bootstrap(1);
  const completedAt = new Date().toISOString();
  const legacyPayload = {
    games: [{
      roomId: start.room.id,
      dissolved: false,
      room: { ...start.room, status: "GAME_RESULT" },
      players: start.players,
      questions: start.questions,
      gameSession: { ...start.gameSession, status: "GAME_RESULT", endedAt: completedAt, completedNormallyAt: completedAt },
      participants: [start.players[1]],
      scores: [{ id: "g1:p0", gameSessionId: "g1", playerId: "p0", score: 5, correctCount: 1 }],
      questionResults: [{
        id: "g1:0:p0",
        gameSessionId: "g1",
        questionIndex: 0,
        playerId: "p0",
        scoredRound: 1,
        scoreAwarded: 5,
        judgedByPlayerId: "host",
        judgedAt: completedAt,
      }],
    }],
  };
  state.storage.sql.db.prepare(`INSERT INTO authority_vnext_projection_outbox(id,payload_json,attempts,updated_at)
    VALUES(1,?,0,?)`).run(JSON.stringify(legacyPayload), Date.now());

  assert.equal(await authority.flushFinalProjection(), true);
  assert.ok(statements.some((statement) => /INSERT INTO game_participants/.test(statement.sql)));
  assert.ok(statements.some((statement) => /INSERT INTO player_scores/.test(statement.sql)));
  assert.ok(statements.some((statement) => /INSERT INTO question_results/.test(statement.sql)));
  assert.equal(statements.some((statement) => /INSERT INTO game_result_archives/.test(statement.sql)), false);
});

test("v3 roster reconciliation writes zero player rows when all 50 members are unchanged", async () => {
  const { state, authority, d1 } = createSqliteProjectionAuthority(49);
  const outcome = authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "returnRoomToLobby", { hostPlayerId: "host" }), Date.now());
  await authority.forceCheckpoint(outcome.forceCheckpoint ?? "projection");
  const outbox = state.storage.sql.db.prepare("SELECT payload_json FROM authority_vnext_projection_outbox WHERE id=1").get() as { payload_json: string };
  const payload = JSON.parse(outbox.payload_json) as { games: Array<{ projectionVersion?: number; rosterStrategy?: string }> };
  assert.equal(payload.games[0]?.projectionVersion, 3);
  assert.equal(payload.games[0]?.rosterStrategy, "reconcile");

  assert.equal(await authority.flushFinalProjection(), true);
  assert.equal(d1.db.prepare("SELECT COUNT(*) count FROM player_write_audit").get().count, 0);
  assert.equal(d1.db.prepare("SELECT COUNT(*) count FROM players WHERE room_id='r1'").get().count, 50);

  state.storage.sql.db.prepare("INSERT INTO authority_vnext_projection_outbox(id,payload_json,attempts,updated_at) VALUES(1,?,0,?)").run(outbox.payload_json, Date.now());
  assert.equal(await authority.flushFinalProjection(), true);
  assert.equal(d1.db.prepare("SELECT COUNT(*) count FROM player_write_audit").get().count, 0, "replayed reconciliation must be write-idempotent");
});

test("v2 aggregate projection outbox keeps its legacy full roster replacement semantics", async () => {
  const { state, authority, d1 } = createSqliteProjectionAuthority(2);
  const outcome = authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "returnRoomToLobby", { hostPlayerId: "host" }), Date.now());
  await authority.forceCheckpoint(outcome.forceCheckpoint ?? "projection");
  const outbox = state.storage.sql.db.prepare("SELECT payload_json FROM authority_vnext_projection_outbox WHERE id=1").get() as { payload_json: string };
  const payload = JSON.parse(outbox.payload_json) as { games: Array<{ projectionVersion?: number; rosterStrategy?: string }> };
  payload.games[0]!.projectionVersion = 2;
  delete payload.games[0]!.rosterStrategy;
  state.storage.sql.db.prepare("UPDATE authority_vnext_projection_outbox SET payload_json=? WHERE id=1").run(JSON.stringify(payload));

  assert.equal(await authority.flushFinalProjection(), true);
  assert.deepEqual(
    d1.db.prepare("SELECT kind,COUNT(*) count FROM player_write_audit GROUP BY kind ORDER BY kind").all().map((row) => ({ ...row })),
    [{ kind: "delete", count: 3 }, { kind: "insert", count: 3 }],
  );
});

test("v3 roster reconciliation writes only changed members and safely supports nickname swaps", async () => {
  const { state, authority, d1 } = createSqliteProjectionAuthority(2);
  const p0 = socketFor(state, "p0");
  const p1 = socketFor(state, "p1");
  authority.handleMutation(p0, envelope("p0", 1, "joinRoom", { nickname: "P1", role: "PLAYER" }), Date.now());
  authority.handleMutation(p1, envelope("p1", 1, "joinRoom", { nickname: "P0", role: "PLAYER" }), Date.now() + 1);
  const outcome = authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "returnRoomToLobby", { hostPlayerId: "host" }), Date.now() + 2);
  await authority.forceCheckpoint(outcome.forceCheckpoint ?? "projection");

  assert.equal(await authority.flushFinalProjection(), true);
  assert.deepEqual(
    d1.db.prepare("SELECT id,nickname FROM players WHERE id IN ('p0','p1') ORDER BY id").all().map((row) => ({ ...row })),
    [{ id: "p0", nickname: "P1" }, { id: "p1", nickname: "P0" }],
  );
  assert.deepEqual(
    d1.db.prepare("SELECT kind,COUNT(*) count FROM player_write_audit GROUP BY kind ORDER BY kind").all().map((row) => ({ ...row })),
    [{ kind: "delete", count: 2 }, { kind: "insert", count: 2 }],
  );
  assert.equal(d1.db.prepare("SELECT COUNT(*) count FROM player_write_audit WHERE player_id='host'").get().count, 0);
});

test("v3 roster reconciliation preserves leave, host transfer, and role changes", async () => {
  const { state, authority, d1 } = createSqliteProjectionAuthority(2);
  authority.handleMutation(socketFor(state, "host"), envelope("host", 1, "leaveRoom", { playerId: "host" }), Date.now());
  authority.handleMutation(socketFor(state, "p0"), envelope("p0", 1, "updatePlayerRole", { targetPlayerId: "p1", role: "SPECTATOR" }), Date.now() + 1);
  const outcome = authority.handleMutation(socketFor(state, "p0"), envelope("p0", 2, "returnRoomToLobby", { hostPlayerId: "p0" }), Date.now() + 2);
  await authority.forceCheckpoint(outcome.forceCheckpoint ?? "projection");

  assert.equal(await authority.flushFinalProjection(), true);
  assert.deepEqual(
    d1.db.prepare("SELECT id,is_host,role FROM players ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: "p0", is_host: 1, role: "PLAYER" },
      { id: "p1", is_host: 0, role: "SPECTATOR" },
    ],
  );
  assert.deepEqual(
    d1.db.prepare("SELECT kind,COUNT(*) count FROM player_write_audit GROUP BY kind ORDER BY kind").all().map((row) => ({ ...row })),
    [{ kind: "delete", count: 3 }, { kind: "insert", count: 2 }],
  );
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
  const archiveInsert = statements.find((statement) => /INSERT INTO game_result_archives/.test(statement.sql));
  assert.ok(archiveInsert);
  const archive = JSON.parse(String(archiveInsert.bindings[5])) as { leaderboard: Array<{ playerId: string }>; questionScores: Array<{ playerId: string }> };
  assert.deepEqual(archive.leaderboard.map((entry) => entry.playerId).sort(), ["p0", "p1"]);
  assert.deepEqual([...new Set(archive.questionScores.map((score) => score.playerId))].sort(), ["p0", "p1"]);
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

test("WebSocket projection boundaries flush the D1 aggregate outbox", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /outcome\.forceCheckpoint === "game-end" \|\| outcome\.forceCheckpoint === "projection"[\s\S]{0,160}flushFinalProjection/);
  assert.match(worker, /aggregate\?\.room\?\.status !== "LOBBY" \|\| this\.authorityVNext\.hasPendingRoomHandoff\(\)/);
  assert.match(worker, /aggregate\.room\?\.status !== "LOBBY" \|\| this\.authorityVNext\.hasPendingRoomHandoff\(\)/);
  assert.equal(
    worker.match(/questionSetManifestVersion: hidden\.questionSetManifestVersion === 1 \? 1 : null/g)?.length,
    3,
    "HTTP, recovery, and WebSocket starts must all preserve manifest storage routing",
  );
});

test("WebSocket proxy preserves player identity for targeted vNext deltas", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /url\.searchParams\.get\("playerId"\)/);
  assert.match(worker, /roomObjectUrl\.searchParams\.set\("playerId", playerId\)/);
});

test("WebSocket snapshot reads stay inside the message event lifetime", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  for (const readName of ["Round", "Bootstrap", "GameResult"]) {
    assert.match(worker, new RegExp(`await this\\.tryHandleWebSocket${readName}SnapshotRead\\(socket, message\\)`));
    assert.match(worker, new RegExp(`await this\\.handle${readName}SnapshotRead\\(socket, gameSessionId, payload\\.clientActionId\\)`));
    assert.doesNotMatch(worker, new RegExp(`void this\\.handle${readName}SnapshotRead\\(`));
  }
});

test("answer text is targeted to current spectators without entering the public stream", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /player\.role === "SPECTATOR"/);
  assert.match(worker, /outcome\.spectatorDeltas/);
});

test("HTTP room RPC failures emit structured diagnostics", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /logGameRpcError\(\{ transport: "http", name: rpcName, args: rpcArgs, topic: localTopic/);
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
    if (finalSnapshot?.type === "game_result_snapshot") finalSnapshotResultCount = finalSnapshot.snapshot.questionScores.length;
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
  const archiveInsert = finalProjectionStatements.find((statement) => /INSERT INTO game_result_archives/.test(statement.sql));
  assert.ok(archiveInsert);
  const archiveJson = String(archiveInsert.bindings[5]);
  const archive = JSON.parse(archiveJson) as { version: number; leaderboard: unknown[]; questionScores: unknown[] };
  assert.equal(archive.version, 1);
  assert.equal(archive.leaderboard.length, 50);
  assert.equal(archive.questionScores.length, 1500);
  assert.ok(Buffer.byteLength(archiveJson) < 512 * 1024);
  assert.doesNotMatch(archiveJson, /answer-\d+/);
  assert.ok(finalProjectionStatements.some((statement) => /INSERT OR IGNORE INTO completed_question_set_plays/.test(statement.sql)));
  assert.equal(finalProjectionStatements.some((statement) => /INSERT INTO (game_participants|player_scores|question_results)/.test(statement.sql)), false);
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

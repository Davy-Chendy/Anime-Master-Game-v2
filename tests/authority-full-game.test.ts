import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  RoomAuthorityVNext,
  type VNextMutationEnvelope,
  type VNextMutationOutcome,
  type VNextSocketAttachment,
} from "../worker/roomAuthorityVNext";
import type {
  GameMode,
  GameSession,
  Player,
  PlayerScore,
  Question,
  QuestionSet,
  Room,
  TeamBattleState,
} from "../src/types/game";

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
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
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
  id = { toString: () => "full-game-room" };
  getWebSockets() { return this.sockets as unknown as WebSocket[]; }
  waitUntil() {}
}

const fakeD1 = {
  prepare() { return { bind() { return this; } }; },
  async batch() { return []; },
} as unknown as D1Database;

type PublicView = {
  status: GameSession["status"];
  questionIndex: number;
  revealRound: number;
  revealedBlocks: number[];
  roundStartedAt: string | null;
  scores: Record<string, number>;
};

type SimulatedClient = {
  id: string;
  socket: WebSocket;
  nextSeq: number;
  publicEvents: unknown[];
  privateEvents: unknown[];
  view: PublicView;
};

type SimulatorOptions = {
  mode: GameMode;
  playerCount?: number;
  spectatorCount?: number;
  questionCount?: number;
  random?: () => number;
};

const ALL_BLOCKS = Array.from({ length: 45 }, (_, index) => index);

function initialTeamState(players: Player[], questionIndex = 0): TeamBattleState {
  const ids = players.filter((player) => player.role === "PLAYER" && player.id !== "host").map((player) => player.id);
  const teams = { red: ids.filter((_, index) => index % 2 === 0), blue: ids.filter((_, index) => index % 2 === 1) };
  const preferred = questionIndex % 2 === 0 ? "red" : "blue";
  return {
    teams,
    initialTeams: structuredClone(teams),
    teamMemberNames: Object.fromEntries(players.map((player) => [player.id, player.nickname])),
    activeTeam: teams[preferred].length ? preferred : preferred === "red" ? "blue" : "red",
    phase: "REVEAL_VOTE",
    revealBlockCount: 45,
    revealLimit: 1,
    turnNumber: 1,
    revealVoteSeconds: 15,
    guessVoteSeconds: 50,
    voteDeadlineAt: new Date(1_015_000).toISOString(),
    revealVotes: {},
    guessVotes: {},
    previousTurnAction: null,
    pendingGuess: null,
    teamScores: { red: 0, blue: 0 },
  };
}

function makeBootstrap(options: Required<Pick<SimulatorOptions, "mode" | "playerCount" | "spectatorCount" | "questionCount">>) {
  const players: Player[] = [
    { id: "host", roomId: "r1", nickname: "Host", isHost: true, role: "PLAYER", joinedAt: 0 },
    ...Array.from({ length: options.playerCount }, (_, index) => ({ id: `p${index}`, roomId: "r1", nickname: `P${index}`, isHost: false, role: "PLAYER" as const, joinedAt: index + 1 })),
    ...Array.from({ length: options.spectatorCount }, (_, index) => ({ id: `s${index}`, roomId: "r1", nickname: `S${index}`, isHost: false, role: "SPECTATOR" as const, joinedAt: options.playerCount + index + 1 })),
  ];
  const room: Room = { id: "r1", code: "ROOM01", hostPlayerId: "host", players, status: "PLAYING", currentPresenterPlayerId: "host", currentGameId: "g1", createdAt: 0 };
  const questions: Question[] = Array.from({ length: options.questionCount }, (_, index) => ({ id: `q${index + 1}`, questionSetId: "set1", imageUrl: `https://example.com/${index + 1}.webp`, orderIndex: index, createdAt: new Date(0).toISOString() }));
  const questionSet: QuestionSet = { id: "set1", title: "Full game", createdByPlayerId: "host", source: "uploaded", isPublic: false, imageCount: questions.length, ratingAvg: 0, ratingCount: 0, playCount: 0, createdAt: new Date(0).toISOString(), questions };
  const eligiblePlayerIds = players.filter((player) => player.role === "PLAYER" && player.id !== "host").map((player) => player.id);
  const gameSession: GameSession = {
    id: "g1",
    roomId: "r1",
    questionSetId: "set1",
    presenterPlayerId: "host",
    status: "PLAYING",
    gameMode: options.mode,
    currentQuestionIndex: 0,
    currentRevealRound: 1,
    revealedBlocks: [],
    maxRevealRounds: 3,
    roundSeconds: 45,
    roundScores: [5, 3, 1],
    eligiblePlayerIds,
    roundStartedAt: null,
    teamBattleState: options.mode === "TEAM_BATTLE" ? initialTeamState(players) : null,
    createdAt: new Date(0).toISOString(),
  };
  return { room, players, questionSet, questions, gameSession };
}

class FullGameSimulator {
  readonly state = new FakeState();
  authority: RoomAuthorityVNext;
  readonly clients = new Map<string, SimulatedClient>();
  readonly trace: string[] = [];
  private readonly random: () => number;
  private readonly lastEnvelopeByActor = new Map<string, VNextMutationEnvelope>();
  private nowMs = 1_000_000;

  constructor(options: SimulatorOptions) {
    const normalized = {
      mode: options.mode,
      playerCount: options.playerCount ?? 6,
      spectatorCount: options.spectatorCount ?? 1,
      questionCount: options.questionCount ?? 3,
    };
    this.state.storage.sql.db.exec(`
      CREATE TABLE authority_vnext_active_game (id INTEGER PRIMARY KEY CHECK(id=1),room_id TEXT NOT NULL,game_id TEXT NOT NULL,authority_version INTEGER NOT NULL,schema_version INTEGER NOT NULL,cutover_state TEXT NOT NULL,state_version INTEGER NOT NULL,state_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE authority_vnext_question_archive (game_id TEXT NOT NULL,question_index INTEGER NOT NULL,checkpoint_version INTEGER NOT NULL,state_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(game_id,question_index));
      CREATE TABLE authority_vnext_projection_outbox (id INTEGER PRIMARY KEY CHECK(id=1),payload_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
    `);
    this.random = options.random ?? (() => 0);
    this.authority = new RoomAuthorityVNext(this.state as unknown as DurableObjectState, fakeD1, this.random);
    this.authority.beginStart("r1", "g1", { startRequestId: "g1" });
    this.authority.activateStart(makeBootstrap(normalized));
    for (const player of this.aggregate.players) this.connect(player.id);
  }

  get aggregate() {
    const aggregate = this.authority.getAggregate();
    if (!aggregate?.gameSession) throw new Error("Simulation has no game session");
    return aggregate;
  }

  get session() { return this.aggregate.gameSession!; }

  advanceTime(ms: number) { this.nowMs += ms; }

  private snapshotView(): PublicView {
    return {
      status: this.session.status,
      questionIndex: this.session.currentQuestionIndex,
      revealRound: this.session.currentRevealRound,
      revealedBlocks: [...this.session.revealedBlocks],
      roundStartedAt: this.session.roundStartedAt ?? null,
      scores: Object.fromEntries(this.aggregate.scores.map((score) => [score.playerId, score.score])),
    };
  }

  connect(playerId: string) {
    const socket = new FakeSocket();
    const attachment: VNextSocketAttachment = { attachmentVersion: 1, topic: "room:r1", playerId, pending: [], serializedBytes: 0 };
    socket.serializeAttachment(attachment);
    this.state.sockets.push(socket);
    const client: SimulatedClient = { id: playerId, socket: socket as unknown as WebSocket, nextSeq: 1, publicEvents: [], privateEvents: [], view: this.snapshotView() };
    this.clients.set(playerId, client);
    return client;
  }

  private updateView(client: SimulatedClient, delta: unknown) {
    if (!delta || typeof delta !== "object") return;
    const value = delta as { type?: string; gameSession?: GameSession; snapshot?: { gameSession?: GameSession; scores?: PlayerScore[] }; scores?: PlayerScore[] };
    const session = value.gameSession ?? value.snapshot?.gameSession;
    if (session) {
      client.view.status = session.status;
      client.view.questionIndex = session.currentQuestionIndex;
      client.view.revealRound = session.currentRevealRound;
      client.view.revealedBlocks = [...session.revealedBlocks];
      client.view.roundStartedAt = session.roundStartedAt ?? null;
    }
    for (const score of value.scores ?? value.snapshot?.scores ?? []) client.view.scores[score.playerId] = score.score;
  }

  private deliver(outcome: VNextMutationOutcome) {
    for (const delta of outcome.publicDeltas) {
      for (const client of this.clients.values()) {
        client.publicEvents.push(structuredClone(delta));
        this.updateView(client, delta);
      }
    }
    const presenterId = this.session.presenterPlayerId;
    const presenter = this.clients.get(presenterId);
    if (presenter) presenter.privateEvents.push(...structuredClone(outcome.presenterDeltas));
    for (const spectator of this.aggregate.players.filter((player) => player.role === "SPECTATOR")) {
      const client = this.clients.get(spectator.id);
      if (client && outcome.spectatorDeltas) client.privateEvents.push(...structuredClone(outcome.spectatorDeltas));
    }
    for (const delivery of outcome.playerDeltas) this.clients.get(delivery.playerId)?.privateEvents.push(structuredClone(delivery.delta));
  }

  async act(actorId: string, name: string, payload: Record<string, unknown> = {}) {
    const client = this.clients.get(actorId) ?? this.connect(actorId);
    const clientSeq = client.nextSeq++;
    const envelope: VNextMutationEnvelope = {
      actionId: `${actorId}:${clientSeq}:${name}:q${this.session.currentQuestionIndex}:r${this.session.currentRevealRound}`,
      actorId,
      clientSeq,
      gameId: "g1",
      questionIndex: this.session.currentQuestionIndex,
      name,
      payload,
    };
    this.lastEnvelopeByActor.set(actorId, structuredClone(envelope));
    const receivedAtMs = this.nowMs++;
    const outcome = this.authority.handleMutation(client.socket, envelope, receivedAtMs);
    this.trace.push(`${receivedAtMs}:${actorId}:${clientSeq}:${name}:${outcome.error ?? "ok"}`);
    this.deliver(outcome);
    if (outcome.forceCheckpoint) await this.authority.forceCheckpoint(outcome.forceCheckpoint, Boolean(outcome.archiveQuestion));
    this.assertPublicPositionConverged();
    this.assertInvariants();
    return outcome;
  }

  replayLast(actorId: string) {
    const client = this.clients.get(actorId);
    const envelope = this.lastEnvelopeByActor.get(actorId);
    assert.ok(client && envelope, `no replayable action for ${actorId}`);
    const before = structuredClone(this.aggregate);
    const outcome = this.authority.handleMutation(client.socket, structuredClone(envelope), this.nowMs + 1);
    this.trace.push(`${this.nowMs + 1}:${actorId}:${envelope.clientSeq}:${envelope.name}:duplicate`);
    assert.equal(outcome.duplicate, true);
    assert.deepEqual(this.aggregate, before, "duplicate mutation changed aggregate state");
    this.assertInvariants();
  }

  injectOutOfOrder(actorId: string) {
    const client = this.clients.get(actorId) ?? this.connect(actorId);
    const before = structuredClone(this.aggregate);
    const envelope: VNextMutationEnvelope = {
      actionId: `${actorId}:gap:${client.nextSeq + 1}`,
      actorId,
      clientSeq: client.nextSeq + 1,
      gameId: "g1",
      questionIndex: this.session.currentQuestionIndex,
      name: "submitAnswer",
      payload: { playerId: actorId, answerText: "must-not-apply" },
    };
    const outcome = this.authority.handleMutation(client.socket, envelope, this.nowMs + 1);
    this.trace.push(`${this.nowMs + 1}:${actorId}:${envelope.clientSeq}:out-of-order:${outcome.error ?? "unexpected-ok"}`);
    assert.equal(outcome.provisional, false);
    assert.match(outcome.error ?? "", /顺序|乱序/);
    assert.deepEqual(this.aggregate, before, "out-of-order mutation changed aggregate state");
    this.assertInvariants();
  }

  async hibernateAndRestore(checkpoint: boolean) {
    if (checkpoint) await this.authority.forceCheckpoint("phase-boundary");
    const before = JSON.parse(JSON.stringify(this.aggregate)) as unknown;
    this.authority = new RoomAuthorityVNext(this.state as unknown as DurableObjectState, fakeD1, this.random);
    await this.authority.restoreFromStorage();
    this.trace.push(`${this.nowMs}:system:restore:${checkpoint ? "checkpointed" : "attachments"}`);
    assert.deepEqual(JSON.parse(JSON.stringify(this.aggregate)), before, "hibernation restore changed authoritative state");
    this.assertInvariants();
    this.assertPublicPositionConverged();
  }

  async runDeadline() {
    const deadline = this.authority.getDeadline();
    assert.ok(deadline, "expected a business deadline");
    this.nowMs = Math.max(this.nowMs, deadline.runAtMs);
    const result = await this.authority.executeDueDeadline(this.nowMs);
    assert.ok(result, "deadline should execute");
    this.deliver(result.outcome);
    const afterFirstExecution = JSON.parse(JSON.stringify(this.aggregate));
    const duplicate = await this.authority.executeDueDeadline(this.nowMs);
    assert.equal(duplicate, null, "duplicate deadline execution was not ignored");
    assert.deepEqual(JSON.parse(JSON.stringify(this.aggregate)), afterFirstExecution, "duplicate deadline changed aggregate state");
    this.trace.push(`${this.nowMs}:system:deadline:executed-and-retried`);
    this.assertPublicPositionConverged();
    return result.outcome;
  }

  assertPublicPositionConverged() {
    const expected = this.snapshotView();
    for (const client of this.clients.values()) {
      const normalizedScores = Object.fromEntries(
        Object.keys(expected.scores).map((playerId) => [playerId, client.view.scores[playerId] ?? 0]),
      );
      assert.deepEqual({ ...client.view, scores: normalizedScores }, expected, `${client.id} public state diverged`);
    }
  }

  assertInvariants() {
    const aggregate = this.aggregate;
    const participantIds = new Set((aggregate.gameParticipants ?? []).map((player) => player.id));
    const playerIds = aggregate.players.map((player) => player.id);
    assert.equal(new Set(playerIds).size, playerIds.length, "duplicate room player id");
    assert.equal(participantIds.has(this.session.presenterPlayerId), false, "presenter became a participant");
    for (const player of aggregate.gameParticipants ?? []) assert.equal(player.role, "PLAYER", "participant snapshot contains non-player role");

    const scoreIds = aggregate.scores.map((score) => score.playerId);
    assert.equal(new Set(scoreIds).size, scoreIds.length, "duplicate score row");
    for (const score of aggregate.scores) {
      assert.ok(participantIds.has(score.playerId), `score belongs to non-participant ${score.playerId}`);
      assert.ok(Number.isInteger(score.score) && score.score >= 0, `invalid score for ${score.playerId}`);
      assert.ok(Number.isInteger(score.correctCount) && score.correctCount >= 0, `invalid correct count for ${score.playerId}`);
    }

    const currentPlayers = new Map(aggregate.players.map((player) => [player.id, player]));
    for (const eligibleId of this.session.eligiblePlayerIds ?? []) {
      assert.notEqual(eligibleId, this.session.presenterPlayerId, "presenter is eligible to answer");
      const currentPlayer = currentPlayers.get(eligibleId);
      if (currentPlayer) assert.equal(currentPlayer.role, "PLAYER", `ineligible role in eligible list: ${eligibleId}`);
    }

    for (const collection of [aggregate.answers, aggregate.buzzerAnswers, aggregate.questionResults]) {
      const ids = collection.map((item) => item.id);
      assert.equal(new Set(ids).size, ids.length, "duplicate current-question entity id");
    }
    for (const [actorId, committed] of Object.entries(aggregate.committedSeqByActor)) {
      assert.ok((aggregate.seenSeqByActor[actorId] ?? 0) >= committed, `committed seq exceeds seen seq for ${actorId}`);
    }

    const leaderboardIds = this.leaderboard().map((entry) => entry.playerId);
    assert.equal(leaderboardIds.includes(this.session.presenterPlayerId), false, "presenter leaked into leaderboard");
    for (const player of aggregate.players.filter((item) => item.role === "SPECTATOR" && !participantIds.has(item.id))) {
      assert.equal(leaderboardIds.includes(player.id), false, `never-participating spectator ${player.id} leaked into leaderboard`);
    }
  }

  assertPublicPayloadDoesNotContain(...secrets: string[]) {
    for (const client of this.clients.values()) {
      const payload = JSON.stringify(client.publicEvents);
      for (const secret of secrets) assert.equal(payload.includes(secret), false, `${client.id} public stream leaked answer ${secret}`);
    }
  }

  leaderboard() {
    return this.authority.query("getLeaderboardForGameSession", []) as Array<{ playerId: string; score: number; correctCount: number }>;
  }

  dispose() {
    this.state.storage.sql.db.close();
  }

  failure(error: unknown) {
    return new Error(`${String(error)}\nRecent deterministic trace:\n${this.trace.slice(-60).join("\n")}`);
  }
}

async function openRound(sim: FullGameSimulator, block: number) {
  const outcome = await sim.act("host", "confirmRevealBlocks", { presenterPlayerId: "host", selectedBlocks: [block] });
  assert.equal(outcome.error, undefined);
  assert.ok(sim.session.roundStartedAt);
}

async function submitPersonalAnswers(sim: FullGameSimulator, playerIds: string[], prefix: string, mutation = "submitAnswer") {
  const answers = new Map<string, string>();
  for (const playerId of playerIds) {
    const text = `${prefix}-${playerId}`;
    const outcome = await sim.act(playerId, mutation, { playerId, answerText: text });
    assert.equal(outcome.error, undefined);
    answers.set(playerId, (outcome.data as { id: string; buzzerAnswer?: { id: string } }).buzzerAnswer?.id ?? (outcome.data as { id: string }).id);
  }
  sim.advanceTime(3_001);
  return answers;
}

async function judgeAnswers(sim: FullGameSimulator, answers: Map<string, string>, correctPlayerIds: string[]) {
  const correct = new Set(correctPlayerIds);
  const outcome = await sim.act("host", "setAnswerJudgements", {
    presenterPlayerId: "host",
    judgements: [...answers].map(([playerId, buzzerAnswerId]) => ({ buzzerAnswerId, isCorrect: correct.has(playerId) })),
  });
  assert.equal(outcome.error, undefined);
  return outcome;
}

async function settlePersonalRound(sim: FullGameSimulator) {
  const previousRound = sim.session.currentRevealRound;
  const outcome = await sim.act("host", "settleBuzzerRound", { presenterPlayerId: "host" });
  assert.equal(outcome.error, undefined);
  assert.equal(sim.session.roundStartedAt, null);
  assert.ok(sim.session.revealedBlocks.length === 45 || sim.session.currentRevealRound >= previousRound);
}

async function labelAndAdvance(sim: FullGameSimulator, label: string) {
  assert.deepEqual(sim.session.revealedBlocks, ALL_BLOCKS);
  const question = sim.aggregate.questions[sim.session.currentQuestionIndex];
  const labeled = await sim.act("host", "updateQuestionLabel", { presenterPlayerId: "host", questionId: question.id, labelText: label, source: "manual" });
  assert.equal(labeled.error, undefined);
  return await sim.act("host", "advanceReviewedQuestion", { presenterPlayerId: "host", expectedQuestionIndex: sim.session.currentQuestionIndex });
}

test("ROUND_REVEAL completes three questions with late join, spectator exclusion, and converged public state", async () => {
  const sim = new FullGameSimulator({ mode: "ROUND_REVEAL", playerCount: 10, spectatorCount: 2, questionCount: 3 });
  const secrets: string[] = [];
  const initialPlayers = Array.from({ length: 10 }, (_, index) => `p${index}`);

  await openRound(sim, 0);
  const first = await submitPersonalAnswers(sim, ["p0", "p1"], "q0-r1-secret");
  secrets.push("q0-r1-secret-p0", "q0-r1-secret-p1");
  for (const playerId of initialPlayers.slice(2)) await sim.act(playerId, "submitForfeitAnswer", { playerId });
  await sim.act("late", "joinRoom", { nickname: "Late", role: "PLAYER" });
  const lateRejected = await sim.act("late", "submitAnswer", { playerId: "late", answerText: "not-eligible-yet" });
  assert.equal(lateRejected.terminal, true);
  await judgeAnswers(sim, first, ["p0"]);
  await settlePersonalRound(sim);

  await openRound(sim, 1);
  const remainingPlayers = initialPlayers.slice(1);
  const second = await submitPersonalAnswers(sim, remainingPlayers, "q0-r2-secret");
  secrets.push(...remainingPlayers.map((id) => `q0-r2-secret-${id}`));
  await judgeAnswers(sim, second, remainingPlayers);
  await settlePersonalRound(sim);
  await labelAndAdvance(sim, "round answer 1");
  assert.ok(sim.session.eligiblePlayerIds?.includes("late"));

  for (let questionIndex = 1; questionIndex < 3; questionIndex += 1) {
    await openRound(sim, questionIndex + 1);
    const eligible = sim.session.eligiblePlayerIds ?? [];
    const answers = await submitPersonalAnswers(sim, eligible, `q${questionIndex}-secret`);
    secrets.push(...eligible.map((id) => `q${questionIndex}-secret-${id}`));
    await judgeAnswers(sim, answers, eligible);
    await settlePersonalRound(sim);
    await labelAndAdvance(sim, `round answer ${questionIndex + 1}`);
  }

  assert.equal(sim.session.status, "GAME_RESULT");
  assert.equal(sim.aggregate.cutoverState, "ended");
  const leaderboardIds = sim.leaderboard().map((entry) => entry.playerId);
  assert.ok(leaderboardIds.includes("late"));
  assert.equal(leaderboardIds.includes("host"), false);
  assert.equal(leaderboardIds.includes("s0"), false);
  assert.equal(leaderboardIds.includes("s1"), false);
  sim.assertPublicPayloadDoesNotContain(...secrets);
});

test("BUZZER_FIRST_CORRECT completes a two-question game only after ordered presenter judgements", async () => {
  const sim = new FullGameSimulator({ mode: "BUZZER_FIRST_CORRECT", playerCount: 5, spectatorCount: 1, questionCount: 2 });
  const secrets: string[] = [];

  for (let questionIndex = 0; questionIndex < 2; questionIndex += 1) {
    await openRound(sim, questionIndex);
    const answers = await submitPersonalAnswers(sim, ["p0", "p1", "p2"], `first-q${questionIndex}`, "submitBuzzerAnswer");
    secrets.push(...["p0", "p1", "p2"].map((id) => `first-q${questionIndex}-${id}`));
    for (const playerId of ["p3", "p4"]) await sim.act(playerId, "submitForfeitAnswer", { playerId });
    await judgeAnswers(sim, new Map([["p0", answers.get("p0")!]]), []);
    assert.notDeepEqual(sim.session.revealedBlocks, ALL_BLOCKS);
    await judgeAnswers(sim, new Map([["p1", answers.get("p1")!]]), ["p1"]);
    assert.deepEqual(sim.session.revealedBlocks, ALL_BLOCKS);
    assert.equal(sim.session.roundStartedAt, null);
    await labelAndAdvance(sim, `first answer ${questionIndex + 1}`);
  }

  assert.equal(sim.session.status, "GAME_RESULT");
  assert.deepEqual(sim.leaderboard().filter((entry) => entry.score > 0).map((entry) => [entry.playerId, entry.score, entry.correctCount]), [["p1", 2, 2]]);
  sim.assertPublicPayloadDoesNotContain(...secrets);
});

test("BUZZER_RANKED completes across rounds with whole-question descending scores and manual settlement", async () => {
  const sim = new FullGameSimulator({ mode: "BUZZER_RANKED", playerCount: 5, spectatorCount: 1, questionCount: 2 });
  const secrets: string[] = [];

  await openRound(sim, 0);
  let answers = await submitPersonalAnswers(sim, ["p0", "p1", "p2", "p3", "p4"], "rank-q0-r1", "submitBuzzerAnswer");
  secrets.push(...["p0", "p1", "p2", "p3", "p4"].map((id) => `rank-q0-r1-${id}`));
  await judgeAnswers(sim, answers, ["p0"]);
  assert.ok(sim.session.roundStartedAt, "judgement must not auto-advance ranked mode");
  await settlePersonalRound(sim);

  await openRound(sim, 1);
  answers = await submitPersonalAnswers(sim, ["p1", "p2", "p3", "p4"], "rank-q0-r2", "submitBuzzerAnswer");
  secrets.push(...["p1", "p2", "p3", "p4"].map((id) => `rank-q0-r2-${id}`));
  await judgeAnswers(sim, answers, ["p1", "p2"]);
  await settlePersonalRound(sim);

  await openRound(sim, 2);
  answers = await submitPersonalAnswers(sim, ["p3"], "rank-q0-r3", "submitBuzzerAnswer");
  secrets.push("rank-q0-r3-p3");
  await sim.act("p4", "submitForfeitAnswer", { playerId: "p4" });
  await judgeAnswers(sim, answers, ["p3"]);
  await settlePersonalRound(sim);
  assert.deepEqual(sim.aggregate.scores.map((score) => [score.playerId, score.score]), [["p0", 5], ["p1", 4], ["p2", 3], ["p3", 2], ["p4", 0]]);
  await labelAndAdvance(sim, "rank answer 1");

  await openRound(sim, 3);
  answers = await submitPersonalAnswers(sim, ["p0", "p1", "p2", "p3", "p4"], "rank-q1", "submitBuzzerAnswer");
  secrets.push(...["p0", "p1", "p2", "p3", "p4"].map((id) => `rank-q1-${id}`));
  await judgeAnswers(sim, answers, ["p0", "p1", "p2", "p3", "p4"]);
  assert.ok(sim.session.roundStartedAt, "all correct still waits for presenter settlement");
  await settlePersonalRound(sim);
  await labelAndAdvance(sim, "rank answer 2");

  assert.equal(sim.session.status, "GAME_RESULT");
  assert.deepEqual(sim.leaderboard().map((entry) => [entry.playerId, entry.score]), [["p0", 10], ["p1", 8], ["p2", 6], ["p3", 4], ["p4", 1]]);
  sim.assertPublicPayloadDoesNotContain(...secrets);
});

async function teamVote(sim: FullGameSimulator, phase: "REVEAL_VOTE" | "GUESS_VOTE", value: number[] | { type: "skip" | "guess"; answerText?: string }) {
  const state = sim.session.teamBattleState!;
  assert.equal(state.phase, phase);
  const fixedDeadline = state.voteDeadlineAt;
  assert.ok(fixedDeadline, "team phase must start with a deadline");
  const members = state.teams[state.activeTeam];
  for (const [index, playerId] of members.entries()) {
    const outcome = phase === "REVEAL_VOTE"
      ? await sim.act(playerId, "submitTeamBattleRevealVote", { playerId, selectedBlocks: value, revealBlockCount: 45 })
      : await sim.act(playerId, "submitTeamBattleGuessVote", { playerId, vote: value });
    assert.equal(outcome.error, undefined);
    if (index + 1 < members.length) {
      assert.equal(sim.session.teamBattleState?.voteDeadlineAt, fixedDeadline, "partial submissions must not move the phase deadline");
    } else {
      assert.ok(new Date(sim.session.teamBattleState!.voteDeadlineAt!).getTime() < new Date(fixedDeadline!).getTime(), "all submissions should shorten a long deadline");
    }
  }
  assert.ok(sim.session.teamBattleState?.voteDeadlineAt);
  await sim.runDeadline();
}

test("TEAM_BATTLE fixed timers settle zero and partial submissions without early completion", async () => {
  const sim = new FullGameSimulator({ mode: "TEAM_BATTLE", playerCount: 6, spectatorCount: 1, questionCount: 1 });
  const initialDeadline = sim.session.teamBattleState?.voteDeadlineAt;
  assert.equal(initialDeadline, new Date(1_015_000).toISOString());

  await sim.runDeadline();
  assert.equal(sim.session.revealedBlocks.length, 1, "zero reveal votes must randomly open one cell");
  assert.equal(sim.session.teamBattleState?.phase, "GUESS_VOTE");
  assert.equal(new Date(sim.session.teamBattleState!.voteDeadlineAt!).getTime(), new Date(initialDeadline!).getTime() + 50_000);

  await sim.runDeadline();
  assert.equal(sim.session.teamBattleState?.previousTurnAction?.type, "skip", "zero guess votes must skip");
  assert.equal(sim.session.teamBattleState?.phase, "REVEAL_VOTE");
  const partialDeadline = sim.session.teamBattleState!.voteDeadlineAt!;
  const activeMember = sim.session.teamBattleState!.teams[sim.session.teamBattleState!.activeTeam][0];
  const partial = await sim.act(activeMember, "submitTeamBattleRevealVote", { playerId: activeMember, selectedBlocks: [10], revealBlockCount: 45 });
  assert.equal(partial.error, undefined);
  assert.equal(sim.session.teamBattleState?.voteDeadlineAt, partialDeadline);
  await sim.runDeadline();
  assert.ok(sim.session.revealedBlocks.includes(10), "the only submitted reveal vote must win");
});

test("TEAM_BATTLE completes alternating-team votes, wrong guess, bonus reveal, and final scoring", async () => {
  const sim = new FullGameSimulator({ mode: "TEAM_BATTLE", playerCount: 6, spectatorCount: 1, questionCount: 2 });

  await teamVote(sim, "REVEAL_VOTE", [0]);
  assert.equal(sim.session.teamBattleState?.phase, "GUESS_VOTE");
  await teamVote(sim, "GUESS_VOTE", { type: "guess", answerText: "red correct" });
  assert.equal(sim.session.teamBattleState?.phase, "JUDGING");
  await sim.act("host", "judgeTeamBattleGuess", { presenterPlayerId: "host", isCorrect: true });
  assert.equal(sim.session.teamBattleState?.phase, "REVIEW");
  assert.equal(sim.session.teamBattleState?.teamScores.red, 1);
  await labelAndAdvance(sim, "team answer 1");

  assert.equal(sim.session.teamBattleState?.activeTeam, "blue");
  await teamVote(sim, "REVEAL_VOTE", [1]);
  await teamVote(sim, "GUESS_VOTE", { type: "skip" });
  assert.equal(sim.session.teamBattleState?.activeTeam, "red");
  assert.equal(sim.session.currentRevealRound, 2);
  await teamVote(sim, "REVEAL_VOTE", [2]);
  await teamVote(sim, "GUESS_VOTE", { type: "guess", answerText: "red wrong" });
  await sim.act("host", "judgeTeamBattleGuess", { presenterPlayerId: "host", isCorrect: false });
  assert.equal(sim.session.teamBattleState?.activeTeam, "blue");
  assert.equal(sim.session.teamBattleState?.revealLimit, 2);
  await teamVote(sim, "REVEAL_VOTE", [3, 4]);
  await teamVote(sim, "GUESS_VOTE", { type: "guess", answerText: "blue correct" });
  await sim.act("host", "judgeTeamBattleGuess", { presenterPlayerId: "host", isCorrect: true });
  assert.equal(sim.session.teamBattleState?.teamScores.blue, 1);
  await labelAndAdvance(sim, "team answer 2");

  assert.equal(sim.session.status, "GAME_RESULT");
  assert.deepEqual(sim.session.teamBattleState?.teamScores, { red: 1, blue: 1 });
  const positive = new Map(sim.leaderboard().filter((entry) => entry.score > 0).map((entry) => [entry.playerId, entry.score]));
  assert.deepEqual([...positive.entries()].sort(), [["p0", 1], ["p1", 1], ["p2", 1], ["p3", 1], ["p4", 1], ["p5", 1]]);
  assert.equal(sim.leaderboard().some((entry) => entry.playerId === "host" || entry.playerId === "s0"), false);
});

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function shuffled<T>(values: readonly T[], random: () => number) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function randomAvailableBlocks(sim: FullGameSimulator, count: number, random: () => number) {
  const revealed = new Set(sim.session.revealedBlocks);
  return shuffled(ALL_BLOCKS.filter((block) => !revealed.has(block)), random).slice(0, count);
}

async function runRoundRevealRandomScenario(seed: number) {
  const random = seededRandom(seed);
  const sim = new FullGameSimulator({ mode: "ROUND_REVEAL", playerCount: 8, spectatorCount: 2, questionCount: 2, random });
  const secrets: string[] = [];
  try {
    for (let question = 0; question < 2; question += 1) {
      let remaining = [...(sim.session.eligiblePlayerIds ?? [])];
      for (let round = 1; round <= 3 && remaining.length; round += 1) {
        await openRound(sim, randomAvailableBlocks(sim, 1, random)[0]);
        if (question === 0 && round === 1) {
          const lateId = `late-${seed}`;
          assert.equal((await sim.act(lateId, "joinRoom", { nickname: lateId, role: "SPECTATOR" })).error, undefined);
          assert.equal((await sim.act("host", "updatePlayerRole", { targetPlayerId: lateId, role: "PLAYER" })).error, undefined);
          const rejected = await sim.act(lateId, "submitAnswer", { playerId: lateId, answerText: "not-yet-eligible" });
          assert.equal(rejected.terminal, true);
        }

        const order = shuffled(remaining, random);
        const finalRound = round === 3;
        const correctCount = finalRound ? order.length : Math.max(1, Math.floor(random() * Math.max(1, order.length)));
        const correct = new Set(order.slice(0, correctCount));
        const answerers = finalRound ? order : order.filter((playerId) => correct.has(playerId) || random() >= 0.3);
        const answerIds = new Map<string, string>();
        for (const playerId of answerers) {
          const answerText = `round-${seed}-${question}-${round}-${playerId}`;
          secrets.push(answerText);
          const outcome = await sim.act(playerId, "submitAnswer", { playerId, answerText });
          assert.equal(outcome.error, undefined);
          answerIds.set(playerId, (outcome.data as { buzzerAnswer: { id: string } }).buzzerAnswer.id);
          sim.advanceTime(1);
        }
        for (const playerId of order.filter((id) => !answerIds.has(id))) {
          assert.equal((await sim.act(playerId, "submitForfeitAnswer", { playerId })).error, undefined);
        }

        if (question === 0 && round === 1 && answerers.length) await sim.hibernateAndRestore(false);
        sim.advanceTime(3_001);
        if (answerIds.size) await judgeAnswers(sim, answerIds, [...correct].filter((id) => answerIds.has(id)));
        const positionBeforeSettle = [sim.session.currentQuestionIndex, sim.session.currentRevealRound];
        await settlePersonalRound(sim);
        assert.deepEqual(positionBeforeSettle[0], sim.session.currentQuestionIndex, "settlement skipped the question");
        remaining = remaining.filter((playerId) => !correct.has(playerId));
        if (sim.session.revealedBlocks.length === 45) break;
      }
      assert.equal(remaining.length, 0, `ROUND_REVEAL left unresolved players for seed ${seed}`);
      await sim.hibernateAndRestore(true);
      if (question === 0) {
        const leaver = shuffled(sim.session.eligiblePlayerIds ?? [], random)[0];
        assert.ok(leaver);
        assert.equal((await sim.act(leaver, "leaveRoom", { roomId: "r1", playerId: leaver })).error, undefined);
      }
      await labelAndAdvance(sim, `round-random-${seed}-${question}`);
    }
    assert.equal(sim.session.status, "GAME_RESULT");
    sim.assertPublicPayloadDoesNotContain(...secrets);
    return sim.trace.length;
  } catch (error) {
    throw sim.failure(error);
  } finally {
    sim.dispose();
  }
}

async function runFirstCorrectRandomScenario(seed: number) {
  const random = seededRandom(seed ^ 0x1f123bb5);
  const sim = new FullGameSimulator({ mode: "BUZZER_FIRST_CORRECT", playerCount: 8, spectatorCount: 2, questionCount: 2, random });
  const secrets: string[] = [];
  try {
    for (let question = 0; question < 2; question += 1) {
      await openRound(sim, randomAvailableBlocks(sim, 1, random)[0]);
      const order = shuffled(sim.session.eligiblePlayerIds ?? [], random);
      const answerIds = new Map<string, string>();
      for (const playerId of order) {
        const answerText = `first-${seed}-${question}-${playerId}`;
        secrets.push(answerText);
        const outcome = await sim.act(playerId, "submitBuzzerAnswer", { playerId, answerText });
        assert.equal(outcome.error, undefined);
        answerIds.set(playerId, (outcome.data as { id: string }).id);
        sim.advanceTime(1);
      }
      if (question === 0) {
        sim.replayLast(order[0]);
        sim.injectOutOfOrder(order[1]);
        await sim.hibernateAndRestore(false);
      }
      sim.advanceTime(3_001);
      const stableOrder = [...sim.aggregate.buzzerAnswers].sort((left, right) =>
        new Date(left.serverReceivedAt).getTime() - new Date(right.serverReceivedAt).getTime()
          || left.playerId.localeCompare(right.playerId)
          || left.id.localeCompare(right.id),
      );
      const winningIndex = Math.floor(random() * stableOrder.length);
      for (let index = 0; index <= winningIndex; index += 1) {
        const answer = stableOrder[index];
        const outcome = await judgeAnswers(sim, new Map([[answer.playerId, answer.id]]), index === winningIndex ? [answer.playerId] : []);
        assert.equal(outcome.error, undefined);
      }
      assert.deepEqual(sim.session.revealedBlocks, ALL_BLOCKS);
      await labelAndAdvance(sim, `first-random-${seed}-${question}`);
    }
    assert.equal(sim.session.status, "GAME_RESULT");
    sim.assertPublicPayloadDoesNotContain(...secrets);
    return sim.trace.length;
  } catch (error) {
    throw sim.failure(error);
  } finally {
    sim.dispose();
  }
}

async function runRankedRandomScenario(seed: number) {
  const random = seededRandom(seed ^ 0x62a9d9ed);
  const sim = new FullGameSimulator({ mode: "BUZZER_RANKED", playerCount: 8, spectatorCount: 2, questionCount: 2, random });
  const secrets: string[] = [];
  try {
    for (let question = 0; question < 2; question += 1) {
      let remaining = [...(sim.session.eligiblePlayerIds ?? [])];
      for (let round = 1; round <= 3 && remaining.length; round += 1) {
        await openRound(sim, randomAvailableBlocks(sim, 1, random)[0]);
        const order = shuffled(remaining, random);
        const correctCount = round === 3 ? order.length : Math.max(1, Math.floor(random() * Math.max(1, order.length)));
        const correct = new Set(order.slice(0, correctCount));
        const answerIds = new Map<string, string>();
        for (const playerId of order) {
          const answerText = `ranked-${seed}-${question}-${round}-${playerId}`;
          secrets.push(answerText);
          const outcome = await sim.act(playerId, "submitBuzzerAnswer", { playerId, answerText });
          assert.equal(outcome.error, undefined);
          answerIds.set(playerId, (outcome.data as { id: string }).id);
          sim.advanceTime(1);
        }
        if (question === 0 && round === 1) await sim.hibernateAndRestore(false);
        sim.advanceTime(3_001);
        await judgeAnswers(sim, answerIds, [...correct]);
        assert.ok(sim.session.roundStartedAt, "ranked judgement advanced without presenter settlement");
        await settlePersonalRound(sim);
        remaining = remaining.filter((playerId) => !correct.has(playerId));
        if (sim.session.revealedBlocks.length === 45) break;
      }
      assert.equal(remaining.length, 0, `BUZZER_RANKED left unresolved players for seed ${seed}`);
      await labelAndAdvance(sim, `ranked-random-${seed}-${question}`);
    }
    assert.equal(sim.session.status, "GAME_RESULT");
    sim.assertPublicPayloadDoesNotContain(...secrets);
    return sim.trace.length;
  } catch (error) {
    throw sim.failure(error);
  } finally {
    sim.dispose();
  }
}

async function randomTeamVote(sim: FullGameSimulator, random: () => number, vote: "reveal" | "skip" | "guess", answerText = "") {
  const teamState = sim.session.teamBattleState!;
  const members = shuffled(teamState.teams[teamState.activeTeam], random);
  for (const playerId of members) {
    const outcome = vote === "reveal"
      ? await sim.act(playerId, "submitTeamBattleRevealVote", {
          playerId,
          selectedBlocks: randomAvailableBlocks(sim, teamState.revealLimit, random),
          revealBlockCount: 45,
        })
      : await sim.act(playerId, "submitTeamBattleGuessVote", {
          playerId,
          vote: vote === "skip" ? { type: "skip" } : { type: "guess", answerText },
        });
    assert.equal(outcome.error, undefined);
  }
  await sim.runDeadline();
}

async function runTeamRandomScenario(seed: number) {
  const random = seededRandom(seed ^ 0xa511e9b3);
  const sim = new FullGameSimulator({ mode: "TEAM_BATTLE", playerCount: 8, spectatorCount: 2, questionCount: 2, random });
  try {
    for (let question = 0; question < 2; question += 1) {
      const nonWinningTurns = 1 + Math.floor(random() * 3);
      for (let turn = 0; turn < nonWinningTurns; turn += 1) {
        await randomTeamVote(sim, random, "reveal");
        if (turn === 0 && question === 0) await sim.hibernateAndRestore(true);
        if (random() < 0.5) {
          await randomTeamVote(sim, random, "skip");
        } else {
          await randomTeamVote(sim, random, "guess", `wrong-${seed}-${question}-${turn}`);
          assert.equal((await sim.act("host", "judgeTeamBattleGuess", { presenterPlayerId: "host", isCorrect: false })).error, undefined);
        }
      }
      await randomTeamVote(sim, random, "reveal");
      await randomTeamVote(sim, random, "guess", `correct-${seed}-${question}`);
      assert.equal((await sim.act("host", "judgeTeamBattleGuess", { presenterPlayerId: "host", isCorrect: true })).error, undefined);
      assert.equal(sim.session.teamBattleState?.phase, "REVIEW");
      await labelAndAdvance(sim, `team-random-${seed}-${question}`);
    }
    assert.equal(sim.session.status, "GAME_RESULT");
    return sim.trace.length;
  } catch (error) {
    throw sim.failure(error);
  } finally {
    sim.dispose();
  }
}

test("seeded state-machine interleavings preserve authority invariants in all four modes", async (context) => {
  const scenarios: Array<[GameMode, (seed: number) => Promise<number>]> = [
    ["ROUND_REVEAL", runRoundRevealRandomScenario],
    ["BUZZER_FIRST_CORRECT", runFirstCorrectRandomScenario],
    ["BUZZER_RANKED", runRankedRandomScenario],
    ["TEAM_BATTLE", runTeamRandomScenario],
  ];
  const originalInfo = console.info;
  let totalTraceEvents = 0;
  console.info = () => undefined;
  try {
    for (const [mode, scenario] of scenarios) {
      await context.test(`${mode}: 50 deterministic seeds`, async () => {
        for (let seed = 1; seed <= 50; seed += 1) {
          try {
            totalTraceEvents += await scenario(seed);
          } catch (error) {
            throw new Error(`${mode} state-machine failure at seed ${seed}: ${String(error)}`);
          }
        }
      });
    }
    originalInfo(JSON.stringify({ event: "authority_state_machine_result", modes: scenarios.length, seedsPerMode: 50, totalSeeds: scenarios.length * 50, totalTraceEvents }));
  } finally {
    console.info = originalInfo;
  }
});

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
    voteDeadlineAt: null,
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
  readonly authority: RoomAuthorityVNext;
  readonly clients = new Map<string, SimulatedClient>();
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
    this.authority = new RoomAuthorityVNext(this.state as unknown as DurableObjectState, fakeD1, options.random ?? (() => 0));
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
    const outcome = this.authority.handleMutation(client.socket, envelope, this.nowMs);
    this.deliver(outcome);
    if (outcome.forceCheckpoint) await this.authority.forceCheckpoint(outcome.forceCheckpoint, Boolean(outcome.archiveQuestion));
    this.assertPublicPositionConverged();
    return outcome;
  }

  async runDeadline() {
    const deadline = this.authority.getDeadline();
    assert.ok(deadline, "expected a business deadline");
    this.nowMs = Math.max(this.nowMs, deadline.runAtMs);
    const result = await this.authority.executeDueDeadline(this.nowMs);
    assert.ok(result, "deadline should execute");
    this.deliver(result.outcome);
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

  assertPublicPayloadDoesNotContain(...secrets: string[]) {
    for (const client of this.clients.values()) {
      const payload = JSON.stringify(client.publicEvents);
      for (const secret of secrets) assert.equal(payload.includes(secret), false, `${client.id} public stream leaked answer ${secret}`);
    }
  }

  leaderboard() {
    return this.authority.query("getLeaderboardForGameSession", []) as Array<{ playerId: string; score: number; correctCount: number }>;
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
  const members = state.teams[state.activeTeam];
  for (const playerId of members) {
    const outcome = phase === "REVEAL_VOTE"
      ? await sim.act(playerId, "submitTeamBattleRevealVote", { playerId, selectedBlocks: value, revealBlockCount: 45 })
      : await sim.act(playerId, "submitTeamBattleGuessVote", { playerId, vote: value });
    assert.equal(outcome.error, undefined);
  }
  assert.ok(sim.session.teamBattleState?.voteDeadlineAt);
  await sim.runDeadline();
}

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

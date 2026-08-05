import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GameDatabase, GamePreparedStatement } from "../worker/d1QueryCompat";
import { CURRENT_ROOM_RUNTIME_GENERATION } from "../src/lib/roomRuntime";
import type { DbPlayer } from "../src/types/game";
import { decodeQuestionSetManifest, encodeQuestionSetManifest } from "../worker/questionSetManifest";
import { decodeRoomState, encodeRoomState } from "../worker/roomStateManifest";
import {
  completeTeamBattleBlockSelection,
  createRoom,
  createUploadedQuestionSet,
  createQuestionSetFromUrlText,
  getCommunityQuestionSets,
  getQuestionSetById,
  joinRoom,
  publishQuestionSetToCommunity,
  returnRoomToLobby,
  runWithGameDatabase,
  selectPresenterForRound,
  startGameWithQuestionSet,
  selectTeamForPlayer,
  updatePlayerRole,
  updateRoomGameSettings,
} from "../worker/gameService";

const root = resolve(import.meta.dirname, "..");
const migrationsDirectory = join(root, "d1", "migrations");

class PreparedStatementAdapter implements GamePreparedStatement {
  private bindings: unknown[] = [];

  constructor(private readonly statement: ReturnType<DatabaseSync["prepare"]>) {}

  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }

  async all<T>() {
    return { results: this.statement.all(...this.bindings) as T[] };
  }

  async first<T>() {
    return (this.statement.get(...this.bindings) as T | undefined) ?? null;
  }
}

class DatabaseAdapter implements GameDatabase {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(query: string) {
    return new PreparedStatementAdapter(this.sqlite.prepare(query));
  }

  async batch<T>(statements: GamePreparedStatement[]) {
    const results: Array<{ results?: T[] }> = [];
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) results.push(await statement.all<T>());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function migrationFiles() {
  return readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

function applyMigrations(db: DatabaseSync, through = "0018") {
  for (const name of migrationFiles()) {
    if (name.slice(0, 4) > through) break;
    db.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
  }
}

function upgradeRoomFixtureToAggregate(db: DatabaseSync, roomId: string) {
  const room = db.prepare("SELECT id,host_player_id FROM rooms WHERE id=?").get(roomId) as {
    id: string;
    host_player_id: string;
  };
  const players = db.prepare("SELECT * FROM players WHERE room_id=? ORDER BY joined_at,id").all(roomId) as DbPlayer[];
  const stateJson = encodeRoomState(room.id, room.host_player_id, players);
  db.prepare(`UPDATE rooms
    SET runtime_generation=?,room_state_version=1,room_state_revision=0,room_state_json=?
    WHERE id=?`).run(CURRENT_ROOM_RUNTIME_GENERATION, stateJson, roomId);
  db.prepare("DELETE FROM players WHERE room_id=?").run(roomId);
}

test("question-set manifest codec rejects corruption instead of silently falling back", () => {
  const encoded = encodeQuestionSetManifest([{
    id: "manifest-q1",
    questionSetId: "manifest-set",
    imageUrl: "https://example.com/manifest.webp",
    orderIndex: 0,
    labelText: null,
    createdAt: "2026-07-31T00:00:00.000Z",
  }]);
  assert.deepEqual(
    decodeQuestionSetManifest({ id: "manifest-set", manifest_version: 1, manifest_json: encoded })?.map((question) => question.question_set_id),
    ["manifest-set"],
  );
  assert.equal(decodeQuestionSetManifest({ id: "legacy-set", manifest_version: null, manifest_json: null }), null);
  assert.throws(
    () => decodeQuestionSetManifest({ id: "broken-set", manifest_version: 1, manifest_json: "{" }),
    /manifest JSON 已损坏/,
  );
  assert.throws(
    () => decodeQuestionSetManifest({ id: "future-set", manifest_version: 2, manifest_json: encoded }),
    /不支持的 manifest 版本/,
  );
  const duplicateManifest = JSON.parse(encoded) as { schema: 1; questions: Array<Record<string, unknown>> };
  duplicateManifest.questions.push({ ...duplicateManifest.questions[0], order_index: 1 });
  assert.throws(
    () => decodeQuestionSetManifest({
      id: "duplicate-set",
      manifest_version: 1,
      manifest_json: JSON.stringify(duplicateManifest),
    }),
    /重复题目 ID/,
  );
});

test("D1 0017 adds manifest storage and targeted partial indexes without rewriting legacy sets", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0016");
  db.prepare("INSERT INTO question_sets(id,title,created_by_player_id,is_public,image_count,updated_at) VALUES(?,?,?,?,?,?)")
    .run("legacy-private", "Legacy", "host", 0, 1, "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO questions(id,question_set_id,image_url,order_index) VALUES(?,?,?,?)")
    .run("legacy-q", "legacy-private", "https://example.com/legacy.webp", 0);
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,prepared_question_set_id) VALUES(?,?,?,?)")
    .run("legacy-room", "LEG017", "host", "legacy-private");

  const migration = readFileSync(join(migrationsDirectory, "0017_question_set_manifest.sql"), "utf8");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration.split(";").slice(0, 2).join(";") + ";");
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('question_sets') WHERE name='manifest_version'").get().count, 0);

  db.exec(migration);
  const legacy = db.prepare("SELECT manifest_version,manifest_revision,manifest_json FROM question_sets WHERE id='legacy-private'").get();
  assert.equal(legacy.manifest_version, null);
  assert.equal(legacy.manifest_revision, 0);
  assert.equal(legacy.manifest_json, null);

  const publicIndexSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='question_sets_public_created_idx'").get().sql;
  assert.match(String(publicIndexSql), /WHERE is_public = 1/i);
  const cleanupPlan = db.prepare(`EXPLAIN QUERY PLAN
    select qs.id from question_sets qs
    where qs.is_public=0 and qs.updated_at<?
      and not exists(select 1 from game_sessions gs where gs.question_set_id=qs.id)
      and not exists(select 1 from rooms r where r.prepared_question_set_id=qs.id)
    order by qs.updated_at,qs.id limit ?`).all("2027-01-01T00:00:00.000Z", 100)
    .map((row) => String(row.detail)).join("\n");
  assert.match(cleanupPlan, /question_sets_private_cleanup_idx/);
  assert.match(cleanupPlan, /game_sessions_question_set_id_idx/);
  assert.match(cleanupPlan, /rooms_prepared_question_set_id_idx/);
});

test("D1 0018 adds aggregate room state transactionally without rewriting old rooms", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0017");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,runtime_generation) VALUES(?,?,?,?)")
    .run("legacy-room-state", "STATE1", "host", 3);

  const migration = readFileSync(join(migrationsDirectory, "0018_room_state_manifest.sql"), "utf8");
  const firstStatement = migration.split(";").map((statement) => statement.trim()).filter(Boolean)[0];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`${firstStatement};`);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='room_state_version'").get().count, 0);

  db.exec(migration);
  const legacy = db.prepare(`SELECT runtime_generation,room_state_version,room_state_revision,room_state_json
    FROM rooms WHERE id='legacy-room-state'`).get();
  assert.equal(legacy.runtime_generation, 3);
  assert.equal(legacy.room_state_version, null);
  assert.equal(legacy.room_state_revision, 0);
  assert.equal(legacy.room_state_json, null);
  assert.throws(() => db.prepare("UPDATE rooms SET room_state_version=2 WHERE id='legacy-room-state'").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE rooms SET room_state_revision=-1 WHERE id='legacy-room-state'").run(), /CHECK constraint failed/);
});

test("room-state manifest is room-scoped and rejects corruption", () => {
  const joined = "2026-08-01T00:00:00.000Z";
  const json = encodeRoomState("room-a", "shared", [{
    id: "shared", room_id: "room-a", nickname: "Host A", is_host: true,
    role: "PLAYER", joined_at: joined, last_seen_at: joined,
  }]);
  assert.deepEqual(decodeRoomState({
    id: "room-a", host_player_id: "shared", room_state_version: 1, room_state_json: json,
  }).map((player) => player.id), ["shared"]);
  assert.doesNotThrow(() => encodeRoomState("room-b", "shared", [{
    id: "shared", room_id: "room-b", nickname: "Host B", is_host: true,
    role: "PLAYER", joined_at: joined, last_seen_at: joined,
  }]));
  assert.throws(() => decodeRoomState({
    id: "room-a", host_player_id: "shared", room_state_version: 1, room_state_json: "{",
  }), /JSON 已损坏/);
  assert.throws(() => encodeRoomState("room-a", "missing", [{
    id: "shared", room_id: "room-a", nickname: "Host", is_host: true,
    role: "PLAYER", joined_at: joined, last_seen_at: joined,
  }]), /房主不在玩家列表/);
  const fiftyOne = Array.from({ length: 51 }, (_, index) => ({
    id: `p${index}`, room_id: "room-a", nickname: `P${index}`, is_host: index === 0,
    role: "PLAYER" as const, joined_at: joined, last_seen_at: joined,
  }));
  assert.throws(() => encodeRoomState("room-a", "p0", fiftyOne), /玩家数量无效/);
  assert.throws(() => encodeRoomState("room-a", "p0", [fiftyOne[0], { ...fiftyOne[1], nickname: " p0 " }]), /重复玩家昵称/);
});

test("D1 0013 upgrades rooms to TEAM_BATTLE vote durations transactionally", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0013");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status) VALUES(?,?,?,?)")
    .run("legacy-room", "LEGACY", "host", "LOBBY");
  const migration = readFileSync(join(migrationsDirectory, "0014_team_battle_vote_durations.sql"), "utf8");
  const firstStatement = migration.split(";").map((statement) => statement.trim()).filter(Boolean)[0];

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`${firstStatement};`);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_team_reveal_vote_seconds'").get().count, 0);

  db.exec(migration);
  const room = db.prepare("SELECT * FROM rooms WHERE id='legacy-room'").get();
  assert.equal(room.room_code, "LEGACY");
  assert.equal(room.lobby_team_reveal_vote_seconds, 15);
  assert.equal(room.lobby_team_guess_vote_seconds, 50);
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_team_reveal_vote_seconds=0 WHERE id='legacy-room'").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_team_guess_vote_seconds=601 WHERE id='legacy-room'").run(), /CHECK constraint failed/);
});

test("D1 0015 adds manual team state transactionally with safe defaults", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0014");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status) VALUES(?,?,?,?)").run("legacy-team", "TEAM15", "host", "LOBBY");
  const migration = readFileSync(join(migrationsDirectory, "0015_manual_team_assignment.sql"), "utf8");
  const firstStatement = migration.split(";").map((statement) => statement.trim()).filter(Boolean)[0];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`${firstStatement};`);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_team_assignment_mode'").get().count, 0);
  db.exec(migration);
  const room = db.prepare("SELECT * FROM rooms WHERE id='legacy-team'").get();
  assert.equal(room.lobby_team_assignment_mode, "AUTO");
  assert.equal(room.lobby_team_assignments, "{}");
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_team_assignment_mode='INVALID' WHERE id='legacy-team'").run(), /CHECK constraint failed/);
});

test("D1 0012 upgrades to nullable creation methods without rewriting historical rows", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0012");
  db.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)")
    .run("legacy", "Legacy", "host", 1);

  db.exec(readFileSync(join(migrationsDirectory, "0013_question_set_creation_method.sql"), "utf8"));

  assert.equal(db.prepare("SELECT creation_method FROM question_sets WHERE id='legacy'").get().creation_method, null);
  assert.throws(
    () => db.prepare("UPDATE question_sets SET creation_method='invalid' WHERE id='legacy'").run(),
    /CHECK constraint failed/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='index' AND name LIKE 'question_sets_public_creation_%'").get().count,
    3,
  );
});

test("new rooms explicitly use the current TEAM_BATTLE defaults", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);

  await runWithGameDatabase(db, async () => {
    const room = await createRoom("host-defaults", "Host");
    assert.equal(room.teamRevealVoteSeconds, 25);
    assert.equal(room.teamGuessVoteSeconds, 50);
    assert.equal(room.teamAssignmentMode, "MANUAL");

    const stored = db.sqlite.prepare("SELECT lobby_team_reveal_vote_seconds, lobby_team_guess_vote_seconds, lobby_team_assignment_mode, runtime_generation FROM rooms WHERE id=?")
      .get(room.id);
    assert.equal(stored.lobby_team_reveal_vote_seconds, 25);
    assert.equal(stored.lobby_team_guess_vote_seconds, 50);
    assert.equal(stored.lobby_team_assignment_mode, "MANUAL");
    assert.equal(stored.runtime_generation, CURRENT_ROOM_RUNTIME_GENERATION);
    const aggregate = db.sqlite.prepare("SELECT * FROM rooms WHERE id=?").get(room.id);
    assert.equal(aggregate.room_state_version, 1);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM players WHERE room_id=?").get(room.id).count, 0);

    const changesBeforeNoOps = Number(db.sqlite.prepare("SELECT total_changes() changes").get().changes);
    const rejoined = await joinRoom(room.code, "host-defaults", "Host");
    assert.equal(rejoined.error, null);
    await updateRoomGameSettings({
      roomId: room.id,
      hostPlayerId: "host-defaults",
      gameMode: "ROUND_REVEAL",
      maxRevealRounds: 3,
      roundSeconds: 45,
      roundScores: [5, 3, 1],
      teamRevealVoteSeconds: 25,
      teamGuessVoteSeconds: 50,
      teamAssignmentMode: "MANUAL",
    });
    assert.equal(Number(db.sqlite.prepare("SELECT total_changes() changes").get().changes), changesBeforeNoOps);
    assert.equal(db.sqlite.prepare("SELECT room_state_revision FROM rooms WHERE id=?").get(room.id).room_state_revision, 0);
  });
});

test("manual team joins enter the lobby unassigned before play and require an atomic team choice only while playing", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare(`INSERT INTO rooms(
    id,room_code,host_player_id,game_status,lobby_game_mode,lobby_team_assignment_mode
  ) VALUES(?,?,?,?,?,?)`).run("room-join-stage", "JOIN01", "host", "LOBBY", "TEAM_BATTLE", "MANUAL");
  db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
    .run("host", "room-join-stage", "Host", 1, "PLAYER");
  upgradeRoomFixtureToAggregate(db.sqlite, "room-join-stage");

  await runWithGameDatabase(db, async () => {
    let joined = await joinRoom("JOIN01", "p1", "P1");
    assert.equal(joined.error, null);
    assert.equal(joined.room?.status, "LOBBY");
    assert.equal(joined.room?.players.some((player) => player.id === "p1"), true);
    assert.deepEqual(joined.room?.teamAssignments, {});

    db.sqlite.prepare("UPDATE rooms SET game_status='QUESTION_SETUP',current_presenter_player_id='host' WHERE id='room-join-stage'").run();
    joined = await joinRoom("JOIN01", "p2", "P2");
    assert.equal(joined.error, null);
    assert.equal(joined.room?.status, "QUESTION_SETUP");
    assert.equal(joined.room?.players.some((player) => player.id === "p2"), true);
    assert.deepEqual(joined.room?.teamAssignments, {});

    db.sqlite.prepare("UPDATE rooms SET game_status='PLAYING' WHERE id='room-join-stage'").run();
    joined = await joinRoom("JOIN01", "p3", "P3");
    assert.equal(joined.room, null);
    assert.equal(joined.errorCode, "TEAM_SELECTION_REQUIRED");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM players WHERE id='p3'").get().count, 0);
    const stored = db.sqlite.prepare("SELECT * FROM rooms WHERE id='room-join-stage'").get() as never;
    assert.equal(decodeRoomState(stored).some((player) => player.id === "p3"), false);
  });
});

test("new question sets default by creation path, publishing can confirm the method, and community filtering stays consistent", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status,current_presenter_player_id) VALUES(?,?,?,?,?)")
    .run("room-1", "ROOM01", "host", "QUESTION_SETUP", "host");
  db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
    .run("host", "room-1", "Host", 1, "PLAYER");
  upgradeRoomFixtureToAggregate(db.sqlite, "room-1");

  await runWithGameDatabase(db, async () => {
    const manual = await createUploadedQuestionSet({
      roomId: "room-1",
      presenterPlayerId: "host",
      title: "Manual",
      imageUrls: ["https://example.com/manual.webp"],
    });
    const assisted = await createQuestionSetFromUrlText({
      roomId: "room-1",
      presenterPlayerId: "host",
      title: "Assisted",
      imageUrlsText: "{\"image_url\":\"https://example.com/assisted.webp\",\"label_text\":\"Example\"}",
    });
    const localFilenameAssisted = await createUploadedQuestionSet({
      roomId: "room-1",
      presenterPlayerId: "host",
      title: "Local filename assisted",
      questions: [{ imageUrl: "https://example.com/local.webp", labelText: "樱满集-罪恶王冠" }],
      creationMethod: "creation_tool_assisted",
    });

    assert.equal(manual.creationMethod, "player_manual");
    assert.equal(assisted.creationMethod, "creation_tool_assisted");
    assert.equal(localFilenameAssisted.creationMethod, "creation_tool_assisted");
    assert.deepEqual(localFilenameAssisted.questions?.map((question) => question.labelText), ["樱满集-罪恶王冠"]);
    assert.equal(
      db.sqlite.prepare("SELECT COUNT(*) count FROM questions WHERE question_set_id IN (?,?,?)")
        .get(manual.id, assisted.id, localFilenameAssisted.id).count,
      0,
    );
    const storedManual = db.sqlite.prepare("SELECT manifest_version,manifest_revision,manifest_json,image_urls_text FROM question_sets WHERE id=?").get(manual.id);
    assert.equal(storedManual.manifest_version, 1);
    assert.equal(storedManual.manifest_revision, 0);
    assert.equal(storedManual.image_urls_text, null);
    assert.match(String(storedManual.manifest_json), /manual\.webp/);
    assert.deepEqual((await getQuestionSetById(manual.id))?.questions?.map((question) => question.imageUrl), ["https://example.com/manual.webp"]);

    await publishQuestionSetToCommunity({
      questionSetId: manual.id,
      playerId: "host",
      title: "Manual",
      creationMethod: "creation_tool_assisted",
    });
    await publishQuestionSetToCommunity({
      questionSetId: assisted.id,
      playerId: "host",
      title: "Assisted",
      creationMethod: "player_manual",
    });

    const manualPage = await getCommunityQuestionSets({ creationMethod: "player_manual" });
    const assistedPage = await getCommunityQuestionSets({ creationMethod: "creation_tool_assisted" });
    assert.deepEqual(manualPage.items.map((item) => item.id), [assisted.id]);
    assert.deepEqual(assistedPage.items.map((item) => item.id), [manual.id]);
    assert.equal(manualPage.total, 1);
    assert.equal(assistedPage.total, 1);
  });
});

test("custom room TEAM_BATTLE vote durations flow into the initial game state", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare(`INSERT INTO rooms(id,room_code,host_player_id,game_status,current_presenter_player_id,prepared_question_set_id)
    VALUES(?,?,?,?,?,?)`).run("room-team", "TEAM01", "host", "QUESTION_SETUP", "host", "set-team");
  for (const [id, nickname, isHost] of [["host", "Host", 1], ["p1", "P1", 0], ["p2", "P2", 0]] as const) {
    db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
      .run(id, "room-team", nickname, isHost, "PLAYER");
  }
  upgradeRoomFixtureToAggregate(db.sqlite, "room-team");
  db.sqlite.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)")
    .run("set-team", "Team Set", "host", 1);
  db.sqlite.prepare("INSERT INTO questions(id,question_set_id,image_url,order_index) VALUES(?,?,?,?)")
    .run("question-team", "set-team", "https://example.com/team.webp", 0);

  await runWithGameDatabase(db, async () => {
    const room = await updateRoomGameSettings({
      roomId: "room-team",
      hostPlayerId: "host",
      gameMode: "TEAM_BATTLE",
      teamRevealVoteSeconds: 23,
      teamGuessVoteSeconds: 61,
    });
    assert.equal(room.teamRevealVoteSeconds, 23);
    assert.equal(room.teamGuessVoteSeconds, 61);

    const started = await startGameWithQuestionSet({
      startRequestId: "team-countdown-01",
      roomId: "room-team",
      hostPlayerId: "host",
      presenterPlayerId: "host",
      questionSetId: "set-team",
      gameMode: "TEAM_BATTLE",
    });
    assert.equal(started.gameSession.teamBattleState?.revealVoteSeconds, 23);
    assert.equal(started.gameSession.teamBattleState?.guessVoteSeconds, 61);
    assert.equal(started.gameSession.teamBattleState?.phase, "PRESENTER_BLOCK");
    assert.equal(started.gameSession.teamBattleState?.voteDeadlineAt, null);

    const blockSelectionReceivedAtMs = Date.now();
    const afterBlockSelection = await completeTeamBattleBlockSelection({
      gameSessionId: started.gameSession.id,
      presenterPlayerId: "host",
      disabledBlocks: [],
      serverReceivedAtMs: blockSelectionReceivedAtMs,
    });
    assert.equal(afterBlockSelection.gameSession.teamBattleState?.phase, "REVEAL_VOTE");
    assert.equal(
      new Date(afterBlockSelection.gameSession.teamBattleState!.voteDeadlineAt!).getTime(),
      blockSelectionReceivedAtMs + 23_000,
    );
  });
});

test("manual team setup blocks incomplete rosters, allows uneven teams, and switching to AUTO clears assignments", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare(`INSERT INTO rooms(id,room_code,host_player_id,game_status,current_presenter_player_id,prepared_question_set_id)
    VALUES(?,?,?,?,?,?)`).run("room-manual-team", "MTEAM1", "host", "QUESTION_SETUP", "host", "set-manual-team");
  for (const [id, nickname, isHost] of [["host", "Host", 1], ["p1", "P1", 0], ["p2", "P2", 0], ["p3", "P3", 0], ["watch", "Watch", 0]] as const) {
    db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
      .run(id, "room-manual-team", nickname, isHost, id === "watch" ? "SPECTATOR" : "PLAYER");
  }
  upgradeRoomFixtureToAggregate(db.sqlite, "room-manual-team");
  db.sqlite.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)")
    .run("set-manual-team", "Manual Team Set", "host", 1);
  db.sqlite.prepare("INSERT INTO questions(id,question_set_id,image_url,order_index) VALUES(?,?,?,?)")
    .run("question-manual-team", "set-manual-team", "https://example.com/manual-team.webp", 0);

  await runWithGameDatabase(db, async () => {
    let room = await updateRoomGameSettings({
      roomId: "room-manual-team",
      hostPlayerId: "host",
      gameMode: "TEAM_BATTLE",
      teamAssignmentMode: "MANUAL",
    });
    assert.equal(room.teamAssignmentMode, "MANUAL");
    await assert.rejects(startGameWithQuestionSet({
      startRequestId: "manual-team-start-01",
      roomId: "room-manual-team",
      hostPlayerId: "host",
      presenterPlayerId: "host",
      questionSetId: "set-manual-team",
      gameMode: "TEAM_BATTLE",
    }), /尚未选择队伍/);

    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p1", team: "red" });
    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p2", team: "blue" });
    room = await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p3", team: "blue" });
    assert.deepEqual(room.teamAssignments, { p1: "red", p2: "blue", p3: "blue" });

    room = await updateRoomGameSettings({
      roomId: "room-manual-team",
      hostPlayerId: "host",
      gameMode: "ROUND_REVEAL",
      teamAssignmentMode: "MANUAL",
    });
    assert.deepEqual(room.teamAssignments, {}, "leaving TEAM_BATTLE must discard manual assignments");
    room = await updateRoomGameSettings({
      roomId: "room-manual-team",
      hostPlayerId: "host",
      gameMode: "TEAM_BATTLE",
      teamAssignmentMode: "MANUAL",
    });
    assert.deepEqual(room.teamAssignments, {}, "returning to TEAM_BATTLE must not restore stale assignments");

    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p1", team: "red" });
    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p2", team: "blue" });
    room = await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p3", team: "blue" });
    assert.deepEqual(room.teamAssignments, { p1: "red", p2: "blue", p3: "blue" });

    room = await updateRoomGameSettings({ roomId: "room-manual-team", hostPlayerId: "host", gameMode: "TEAM_BATTLE", teamAssignmentMode: "AUTO" });
    assert.deepEqual(room.teamAssignments, {});
    room = await updateRoomGameSettings({ roomId: "room-manual-team", hostPlayerId: "host", gameMode: "TEAM_BATTLE", teamAssignmentMode: "MANUAL" });
    assert.deepEqual(room.teamAssignments, {});

    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p1", team: "red" });
    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p2", team: "blue" });
    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p3", team: "blue" });
    const started = await startGameWithQuestionSet({
      startRequestId: "manual-team-start-02",
      roomId: "room-manual-team",
      hostPlayerId: "host",
      presenterPlayerId: "host",
      questionSetId: "set-manual-team",
      gameMode: "TEAM_BATTLE",
    });
    assert.deepEqual(started.gameSession.teamBattleState?.teams, { red: ["p1"], blue: ["p2", "p3"] });
    assert.equal(started.gameSession.teamBattleState?.initialTeams?.red.includes("host"), false);
    assert.equal(started.gameSession.teamBattleState?.initialTeams?.blue.includes("watch"), false);
  });
});

test("manual team setup removes presenter and spectator assignments and remains editable after question-set preparation", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status) VALUES(?,?,?,?)")
    .run("room-manual-lifecycle", "MTEAM2", "host", "LOBBY");
  for (const [id, nickname, isHost] of [["host", "Host", 1], ["p1", "P1", 0], ["p2", "P2", 0]] as const) {
    db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
      .run(id, "room-manual-lifecycle", nickname, isHost, "PLAYER");
  }
  upgradeRoomFixtureToAggregate(db.sqlite, "room-manual-lifecycle");

  await runWithGameDatabase(db, async () => {
    await updateRoomGameSettings({
      roomId: "room-manual-lifecycle",
      hostPlayerId: "host",
      gameMode: "TEAM_BATTLE",
      teamAssignmentMode: "MANUAL",
    });
    await selectTeamForPlayer({ roomId: "room-manual-lifecycle", playerId: "host", team: "red" });
    await selectTeamForPlayer({ roomId: "room-manual-lifecycle", playerId: "p1", team: "blue" });
    await selectTeamForPlayer({ roomId: "room-manual-lifecycle", playerId: "p2", team: "red" });

    let room = await selectPresenterForRound("room-manual-lifecycle", "host", "p1");
    assert.equal(room.status, "QUESTION_SETUP");
    assert.deepEqual(room.teamAssignments, { host: "red", p2: "red" });

    db.sqlite.prepare("UPDATE rooms SET prepared_question_set_id=? WHERE id=?")
      .run("prepared-set", "room-manual-lifecycle");
    room = await selectTeamForPlayer({ roomId: "room-manual-lifecycle", playerId: "p2", team: "blue" });
    assert.equal(room.preparedQuestionSetId, "prepared-set");
    assert.deepEqual(room.teamAssignments, { host: "red", p2: "blue" });

    room = await updatePlayerRole("room-manual-lifecycle", "p2", "p2", "SPECTATOR");
    assert.deepEqual(room.teamAssignments, { host: "red" });
    await assert.rejects(
      updatePlayerRole("room-manual-lifecycle", "p2", "p2", "PLAYER"),
      /请先选择加入红队或蓝队/,
    );
    room = await updatePlayerRole("room-manual-lifecycle", "p2", "p2", "PLAYER", "blue");
    assert.deepEqual(room.teamAssignments, { host: "red", p2: "blue" });
  });
});

test("returning a completed room to the lobby clears all per-game identities", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare(`INSERT INTO rooms(
    id,room_code,host_player_id,game_status,current_presenter_player_id,current_game_id,prepared_question_set_id,lobby_team_assignments
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    "room-reset-after-game", "RESET1", "host", "GAME_RESULT", "presenter", "game-1", "stale-set", '{"host":"red","player":"blue"}',
  );
  for (const [id, nickname, isHost] of [["host", "Host", 1], ["presenter", "Presenter", 0], ["player", "Player", 0]] as const) {
    db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
      .run(id, "room-reset-after-game", nickname, isHost, "PLAYER");
  }
  upgradeRoomFixtureToAggregate(db.sqlite, "room-reset-after-game");

  await runWithGameDatabase(db, async () => {
    const room = await returnRoomToLobby("room-reset-after-game", "host");
    assert.equal(room.status, "LOBBY");
    assert.equal(room.currentPresenterPlayerId, null);
    assert.equal(room.currentGameId, null);
    assert.equal(room.preparedQuestionSetId, null);
    assert.deepEqual(room.teamAssignments, {});
  });
});

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GameDatabase, GamePreparedStatement } from "../worker/d1QueryCompat";
import {
  createUploadedQuestionSet,
  createQuestionSetFromUrlText,
  getCommunityQuestionSets,
  publishQuestionSetToCommunity,
  runWithGameDatabase,
  startGameWithQuestionSet,
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

function applyMigrations(db: DatabaseSync, through = "0014") {
  for (const name of migrationFiles()) {
    if (name.slice(0, 4) > through) break;
    db.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
  }
}

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

test("new question sets default by creation path, publishing can confirm the method, and community filtering stays consistent", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status,current_presenter_player_id) VALUES(?,?,?,?,?)")
    .run("room-1", "ROOM01", "host", "QUESTION_SETUP", "host");
  db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
    .run("host", "room-1", "Host", 1, "PLAYER");

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

    assert.equal(manual.creationMethod, "player_manual");
    assert.equal(assisted.creationMethod, "creation_tool_assisted");

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
    const deadlineMs = new Date(started.gameSession.teamBattleState!.voteDeadlineAt!).getTime();
    const createdAtMs = new Date(started.gameSession.createdAt).getTime();
    assert.ok(deadlineMs >= createdAtMs + 22_000 && deadlineMs <= Date.now() + 23_000);
  });
});

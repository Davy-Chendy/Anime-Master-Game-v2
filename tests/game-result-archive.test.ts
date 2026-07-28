import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GameDatabase, GamePreparedStatement } from "../worker/d1QueryCompat";
import { getArchivedGameResultSnapshot, getGameResultSnapshot, runWithGameDatabase } from "../worker/gameService";

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
  constructor(readonly sqlite = new DatabaseSync(":memory:")) {}

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

function applyMigrations(db: DatabaseSync, through = "0012") {
  for (const name of migrationFiles()) {
    if (name.slice(0, 4) > through) break;
    db.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
  }
}

function seedCompletedGame(db: DatabaseSync, gameId = "game-1") {
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status,current_game_id) VALUES(?,?,?,?,?)")
    .run("room-1", "ROOM01", "host", "GAME_RESULT", gameId);
  db.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)").run("host", "room-1", "Host", 1, "PLAYER");
  db.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)").run("p1", "room-1", "Player 1", 0, "PLAYER");
  db.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)").run("spectator", "room-1", "Viewer", 0, "SPECTATOR");
  db.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)").run("set-1", "Set", "host", 2);
  db.prepare("INSERT INTO questions(id,question_set_id,image_url,order_index,label_text) VALUES(?,?,?,?,?)").run("q1", "set-1", "https://example.com/1.webp", 0, "answer one");
  db.prepare("INSERT INTO questions(id,question_set_id,image_url,order_index,label_text) VALUES(?,?,?,?,?)").run("q2", "set-1", "https://example.com/2.webp", 1, "answer two");
  db.prepare(`INSERT INTO game_sessions(id,room_id,question_set_id,presenter_player_id,status,game_mode,current_question_index,completed_normally_at,ended_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(gameId, "room-1", "set-1", "host", "GAME_RESULT", "ROUND_REVEAL", 2, "2026-07-28T01:00:00.000Z", "2026-07-28T01:00:00.000Z");
}

test("D1 0011 schema upgrades to 0012 additively and reapplying 0012 preserves archives", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0011");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='game_result_archives'").get().count, 0);

  const migration = readFileSync(join(migrationsDirectory, "0012_game_result_archives.sql"), "utf8");
  db.exec(migration);
  db.prepare(`INSERT INTO game_result_archives(game_session_id,room_id,question_set_id,archive_version,completed_at,result_json)
    VALUES(?,?,?,?,?,?)`).run("game-1", "room-1", "set-1", 1, "2026-07-28T01:00:00.000Z", "{\"version\":1}");
  db.exec(migration);

  assert.equal(db.prepare("SELECT COUNT(*) count FROM game_result_archives").get().count, 1);
  assert.equal(db.prepare("SELECT result_json FROM game_result_archives WHERE game_session_id='game-1'").get().result_json, "{\"version\":1}");
});

test("new aggregate archive restores leaderboard and sparse per-question scores", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  seedCompletedGame(db.sqlite);
  const archive = {
    version: 1,
    gameMode: "ROUND_REVEAL",
    questionCount: 2,
    completedAt: "2026-07-28T01:00:00.000Z",
    leaderboard: [{ playerId: "p1", nickname: "Player 1", rank: 1, score: 5, correctCount: 1 }],
    questionScores: [{ playerId: "p1", questionIndex: 0, scoreAwarded: 5 }],
  };
  db.sqlite.prepare(`INSERT INTO game_result_archives(game_session_id,room_id,question_set_id,archive_version,completed_at,result_json)
    VALUES(?,?,?,?,?,?)`).run("game-1", "room-1", "set-1", 1, archive.completedAt, JSON.stringify(archive));

  const result = await runWithGameDatabase(db, () => getArchivedGameResultSnapshot("game-1"));
  assert.ok(result);
  assert.deepEqual(result.leaderboard, archive.leaderboard);
  assert.deepEqual(result.questionScores, archive.questionScores);
  assert.equal(result.leaderboard.some((entry) => entry.playerId === "host" || entry.playerId === "spectator"), false);
  assert.equal(JSON.stringify(archive).includes("answer one"), false);
});

test("legacy normalized result remains readable when no aggregate archive exists", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite, "0011");
  seedCompletedGame(db.sqlite);
  db.sqlite.prepare("INSERT INTO game_participants(game_session_id,player_id,nickname,role,joined_at) VALUES(?,?,?,?,?)")
    .run("game-1", "p1", "Player 1", "PLAYER", "2026-07-28T00:00:00.000Z");
  db.sqlite.prepare("INSERT INTO player_scores(id,game_session_id,player_id,score,correct_count) VALUES(?,?,?,?,?)")
    .run("score-1", "game-1", "p1", 3, 1);
  db.sqlite.prepare(`INSERT INTO question_results(id,game_session_id,question_index,player_id,scored_round,score_awarded,judged_by_player_id)
    VALUES(?,?,?,?,?,?,?)`).run("result-1", "game-1", 1, "p1", 2, 3, "host");

  const directArchive = await runWithGameDatabase(db, () => getArchivedGameResultSnapshot("game-1"));
  assert.equal(directArchive, null);
  const result = await runWithGameDatabase(db, () => getGameResultSnapshot("game-1"));
  assert.deepEqual(result.leaderboard, [{ playerId: "p1", nickname: "Player 1", rank: 1, score: 3, correctCount: 1 }]);
  assert.deepEqual(result.questionScores, [{ playerId: "p1", questionIndex: 1, scoreAwarded: 3 }]);
});

test("corrupt or incompatible aggregate archive fails explicitly instead of returning an empty result", async () => {
  for (const [label, resultJson] of [
    ["invalid JSON", "{"],
    ["incompatible version", JSON.stringify({ version: 99, questionCount: 0, leaderboard: [], questionScores: [] })],
    ["unknown score player", JSON.stringify({ version: 1, questionCount: 1, leaderboard: [], questionScores: [{ playerId: "ghost", questionIndex: 0, scoreAwarded: 1 }] })],
  ] as const) {
    const db = new DatabaseAdapter();
    applyMigrations(db.sqlite);
    seedCompletedGame(db.sqlite);
    db.sqlite.prepare(`INSERT INTO game_result_archives(game_session_id,room_id,question_set_id,archive_version,completed_at,result_json)
      VALUES(?,?,?,?,?,?)`).run("game-1", "room-1", "set-1", 1, "2026-07-28T01:00:00.000Z", resultJson);
    await assert.rejects(
      () => runWithGameDatabase(db, () => getArchivedGameResultSnapshot("game-1")),
      /\u7ed3\u7b97\u5f52\u6863/,
      label,
    );
  }
});

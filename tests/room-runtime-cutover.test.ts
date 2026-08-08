import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { CURRENT_ROOM_RUNTIME_GENERATION } from "../src/lib/roomRuntime";
import { RoomDurableObject, RoomDurableObjectV3, type Env } from "../worker/index";
import { RoomRuntimeV3Storage } from "../worker/roomRuntimeV3";

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

class StorageAdapter {
  readonly db = new DatabaseSync(":memory:");
  failOn = "";
  deletedAlarmCount = 0;
  private alarmAt: number | null = null;
  readonly sql = {
    exec: <T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) => {
      if (this.failOn && query.includes(this.failOn)) throw new Error("injected migration failure");
      const statement = this.db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return new Cursor(statement.all(...bindings) as T[]);
      }
      statement.run(...bindings);
      return new Cursor<T>([]);
    },
    get databaseSize() { return 0; },
  };
  transactionSync<T>(callback: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(value: number | Date) { this.alarmAt = typeof value === "number" ? value : value.getTime(); }
  async deleteAlarm() {
    this.alarmAt = null;
    this.deletedAlarmCount += 1;
  }
}

test("D1 migration leaves old rooms unmarked and supports explicit current-generation rooms", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../d1/migrations/0001_initial.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id) VALUES(?,?,?)").run("old", "OLD001", "host-old");
  db.exec(readFileSync(new URL("../d1/migrations/0016_room_runtime_generation.sql", import.meta.url), "utf8"));
  assert.equal(db.prepare("SELECT runtime_generation FROM rooms WHERE id='old'").get().runtime_generation, null);
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,runtime_generation) VALUES(?,?,?,?)")
    .run("new", "NEW001", "host-new", CURRENT_ROOM_RUNTIME_GENERATION);
  assert.equal(
    db.prepare("SELECT runtime_generation FROM rooms WHERE id='new'").get().runtime_generation,
    CURRENT_ROOM_RUNTIME_GENERATION,
  );
});

test("room authority schema is minimal, idempotent, and never creates legacy projection tables", () => {
  const storage = new StorageAdapter();
  const runtime = new RoomRuntimeV3Storage(storage as unknown as DurableObjectStorage);
  runtime.initializeSchema();
  runtime.initializeSchema();
  runtime.ensureRoom("room-1");
  runtime.ensureRoom("room-1");
  const tables = storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((row) => String(row.name));
  assert.deepEqual(tables, [
    "authority_vnext_active_game",
    "authority_vnext_projection_outbox",
    "authority_vnext_question_archive",
    "room_runtime_meta",
    "room_runtime_schema",
  ]);
  for (const legacy of ["rooms", "players", "answers", "mutation_journal", "projection_outbox"]) {
    assert.equal(tables.includes(legacy), false, `legacy table should not exist: ${legacy}`);
  }
  assert.equal(storage.db.prepare("SELECT runtime_generation FROM room_runtime_meta").get().runtime_generation, CURRENT_ROOM_RUNTIME_GENERATION);
  assert.equal(runtime.bumpVersion("room-1").stateVersion, 1);
  assert.throws(() => runtime.ensureRoom("room-2"), /identity mismatch/);
});

test("V3 migration failure does not advance the schema version", () => {
  const storage = new StorageAdapter();
  storage.failOn = "authority_vnext_question_archive";
  const runtime = new RoomRuntimeV3Storage(storage as unknown as DurableObjectStorage);
  assert.throws(() => runtime.initializeSchema(), /injected migration failure/);
  assert.equal(storage.db.prepare("SELECT COUNT(*) count FROM room_runtime_schema").get().count, 0);
  storage.failOn = "";
  runtime.initializeSchema();
  assert.equal(storage.db.prepare("SELECT version FROM room_runtime_schema WHERE id=1").get().version, 1);
});

test("retired Room DO cancels its Alarm without creating SQLite tables", async () => {
  const storage = new StorageAdapter();
  const state = {
    storage,
    getWebSockets: () => [],
  } as unknown as DurableObjectState;
  await new RoomDurableObject(state).alarm();
  assert.equal(storage.deletedAlarmCount, 1);
  assert.equal(storage.db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table'").get().count, 0);
});

test("generation 3 V3 object rejects HTTP and expires stale sockets before business restore", async () => {
  const storage = new StorageAdapter();
  const runtime = new RoomRuntimeV3Storage(storage as unknown as DurableObjectStorage);
  runtime.initializeSchema();
  runtime.ensureRoom("room-old");
  storage.db.prepare("UPDATE room_runtime_meta SET runtime_generation=3 WHERE id=1").run();
  const sent: string[] = [];
  let closeCode = 0;
  const socket = {
    send(value: string) { sent.push(value); },
    close(code: number) { closeCode = code; },
  } as unknown as WebSocket;
  const state = {
    storage,
    id: { toString: () => "room-old" },
    blockConcurrencyWhile(callback: () => Promise<void>) { void callback(); },
    getWebSockets: () => [socket],
  } as unknown as DurableObjectState;
  const env = { DB: { prepare() { throw new Error("retired object must not read D1 business state"); } } } as unknown as Env;
  const object = new RoomDurableObjectV3(state, env);

  const response = await object.fetch(new Request("https://room-object/api/rpc", { method: "POST" }));
  assert.equal(response.status, 410);
  assert.equal((await response.json() as { code: string }).code, "ROOM_VERSION_EXPIRED");
  assert.equal(storage.deletedAlarmCount, 1);
  assert.equal(closeCode, 4001);
  assert.match(sent[0] ?? "", /room_expired/);

  await object.webSocketMessage(socket, "{}");
  assert.equal(closeCode, 4001);
});

test("ended TEAM_BATTLE state cannot recreate an expired vote Alarm on a V3 wake", async () => {
  const storage = new StorageAdapter();
  const runtime = new RoomRuntimeV3Storage(storage as unknown as DurableObjectStorage);
  runtime.initializeSchema();
  runtime.ensureRoom("room-ended");
  const expiredAt = Date.now() - 60_000;
  const aggregate = {
    authorityVersion: 2,
    schemaVersion: 1,
    cutoverState: "ended",
    roomId: "room-ended",
    gameId: "game-ended",
    players: [],
    gameParticipants: [],
    questions: [],
    questionSetManifestVersion: null,
    dirtyQuestionLabelIds: [],
    answers: [],
    buzzerAnswers: [],
    questionResults: [],
    scores: [],
    scoreBaseline: {},
    committedSeqByActor: {},
    seenSeqByActor: {},
    terminalRejections: {},
    deadline: {
      kind: "team-vote",
      gameId: "game-ended",
      questionIndex: 0,
      phaseKey: "GUESS_VOTE:1",
      runAtMs: expiredAt,
    },
    gameSession: {
      id: "game-ended",
      gameMode: "TEAM_BATTLE",
      currentQuestionIndex: 0,
      teamBattleState: {
        teams: { red: ["player-red"], blue: ["player-blue"] },
        phase: "GUESS_VOTE",
        turnNumber: 1,
        voteDeadlineAt: new Date(expiredAt).toISOString(),
      },
    },
    stateVersion: 1,
    publicStateVersion: 1,
    checkpointGeneration: 1,
    lastCheckpointAtMs: Date.now(),
  };
  storage.db.prepare(`INSERT INTO authority_vnext_active_game(
    id,room_id,game_id,authority_version,schema_version,cutover_state,state_version,state_json,updated_at
  ) VALUES(1,?,?,?,?,?,?,?,?)`).run(
    "room-ended",
    "game-ended",
    2,
    1,
    "ended",
    1,
    JSON.stringify(aggregate),
    Date.now(),
  );
  await storage.setAlarm(expiredAt);
  const state = {
    storage,
    id: { toString: () => "room-ended" },
    blockConcurrencyWhile(callback: () => Promise<void>) { void callback(); },
    getWebSockets: () => [],
  } as unknown as DurableObjectState;
  const env = { DB: {} } as unknown as Env;

  await new RoomDurableObjectV3(state, env).alarm();

  assert.equal(await storage.getAlarm(), null);
  assert.equal(storage.deletedAlarmCount, 1);
  const stored = JSON.parse(String(storage.db.prepare(
    "SELECT state_json FROM authority_vnext_active_game WHERE id=1",
  ).get().state_json)) as { cutoverState: string; deadline: unknown };
  assert.equal(stored.cutoverState, "ended");
  assert.equal(stored.deadline, null);
});

import type { AuthorityVersion } from "./roomGameAuthority";
import {
  CURRENT_ROOM_RUNTIME_GENERATION,
  ROOM_VERSION_EXPIRED_ERROR_CODE,
  ROOM_VERSION_EXPIRED_MESSAGE,
} from "../src/lib/roomRuntime";

export { CURRENT_ROOM_RUNTIME_GENERATION, ROOM_VERSION_EXPIRED_ERROR_CODE, ROOM_VERSION_EXPIRED_MESSAGE };

const ROOM_RUNTIME_SCHEMA_VERSION = 1;

const V3_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS room_runtime_schema (
    id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS room_runtime_meta (
    id INTEGER PRIMARY KEY CHECK(id=1), room_id TEXT NOT NULL UNIQUE,
    runtime_generation INTEGER NOT NULL, state_version INTEGER NOT NULL DEFAULT 0,
    initialized_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS authority_vnext_active_game (
    id INTEGER PRIMARY KEY CHECK(id=1), room_id TEXT NOT NULL, game_id TEXT NOT NULL,
    authority_version INTEGER NOT NULL, schema_version INTEGER NOT NULL, cutover_state TEXT NOT NULL,
    state_version INTEGER NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS authority_vnext_question_archive (
    game_id TEXT NOT NULL, question_index INTEGER NOT NULL, checkpoint_version INTEGER NOT NULL,
    state_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(game_id,question_index)
  )`,
  `CREATE TABLE IF NOT EXISTS authority_vnext_projection_outbox (
    id INTEGER PRIMARY KEY CHECK(id=1), payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
] as const;

const REQUIRED_COLUMNS = new Map<string, string[]>([
  ["room_runtime_meta", ["room_id", "runtime_generation", "state_version"]],
  ["authority_vnext_active_game", ["authority_version", "schema_version", "cutover_state", "state_json"]],
  ["authority_vnext_question_archive", ["game_id", "question_index", "state_json"]],
  ["authority_vnext_projection_outbox", ["payload_json", "attempts"]],
]);

export class RoomRuntimeV3Storage {
  private roomId: string | null = null;

  constructor(private readonly storage: DurableObjectStorage) {}

  initializeSchema() {
    this.storage.sql.exec(V3_SCHEMA[0]);
    const current = this.storage.sql
      .exec<{ version: number }>("SELECT version FROM room_runtime_schema WHERE id=1")
      .toArray()[0];
    const currentVersion = Number(current?.version ?? 0);
    if (currentVersion >= ROOM_RUNTIME_SCHEMA_VERSION) return;

    this.storage.transactionSync(() => {
      for (const statement of V3_SCHEMA.slice(1)) this.storage.sql.exec(statement);
      this.validateSchema();
      this.storage.sql.exec(
        "INSERT INTO room_runtime_schema(id,version) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version",
        ROOM_RUNTIME_SCHEMA_VERSION,
      );
      const advanced = this.storage.sql
        .exec<{ version: number }>("SELECT version FROM room_runtime_schema WHERE id=1")
        .one();
      if (advanced.version !== ROOM_RUNTIME_SCHEMA_VERSION) {
        throw new Error("room runtime v3 schema version did not advance");
      }
    });
  }

  private validateSchema() {
    for (const [table, columns] of REQUIRED_COLUMNS) {
      const existing = new Set(
        this.storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((row) => row.name),
      );
      if (columns.some((column) => !existing.has(column))) {
        throw new Error(`room runtime v3 schema validation failed: ${table}`);
      }
    }
  }

  ensureRoom(roomId: string) {
    if (this.roomId === roomId) return;
    const current = this.storage.sql
      .exec<{ room_id: string; runtime_generation: number }>(
        "SELECT room_id,runtime_generation FROM room_runtime_meta WHERE id=1",
      )
      .toArray()[0];
    if (!current) {
      this.storage.sql.exec(
        "INSERT INTO room_runtime_meta(id,room_id,runtime_generation,state_version,initialized_at) VALUES(1,?,?,0,?)",
        roomId,
        CURRENT_ROOM_RUNTIME_GENERATION,
        Date.now(),
      );
      this.roomId = roomId;
      return;
    }
    if (current.room_id !== roomId || current.runtime_generation !== CURRENT_ROOM_RUNTIME_GENERATION) {
      throw new Error("room runtime v3 identity mismatch");
    }
    this.roomId = roomId;
  }

  bumpVersion(roomId: string): AuthorityVersion {
    this.ensureRoom(roomId);
    this.storage.sql.exec(
      "UPDATE room_runtime_meta SET state_version=state_version+1 WHERE id=1 AND room_id=? AND runtime_generation=?",
      roomId,
      CURRENT_ROOM_RUNTIME_GENERATION,
    );
    const row = this.storage.sql
      .exec<{ state_version: number }>("SELECT state_version FROM room_runtime_meta WHERE id=1")
      .one();
    return { epoch: "v3", stateVersion: row.state_version };
  }
}

export class RoomVersionExpiredError extends Error {
  readonly code = ROOM_VERSION_EXPIRED_ERROR_CODE;
  readonly status = 410;

  constructor() {
    super(ROOM_VERSION_EXPIRED_MESSAGE);
    this.name = "RoomVersionExpiredError";
  }
}

import type { DbPlayer, DbRoom, Player, PlayerRole } from "../src/types/game";

export const ROOM_STATE_MANIFEST_VERSION = 1 as const;
export const ROOM_STATE_MAX_PLAYERS = 50;
export const ROOM_STATE_MAX_BYTES = 64 * 1024;

type StoredRoomPlayer = {
  id: string;
  nickname: string;
  role: PlayerRole;
  joined_at: string;
};

type StoredRoomState = {
  schema: typeof ROOM_STATE_MANIFEST_VERSION;
  players: StoredRoomPlayer[];
};

type RoomStateRow = Pick<
  DbRoom,
  "id" | "host_player_id" | "room_state_version" | "room_state_json"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`房间状态字段 ${field} 无效。`);
  }
  return value;
}

function normalizeRole(value: unknown): PlayerRole {
  if (value !== "PLAYER" && value !== "SPECTATOR") {
    throw new Error("房间状态包含无效玩家身份。");
  }
  return value;
}

function normalizeJoinedAt(value: number | string) {
  if (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  throw new Error("房间状态包含无效加入时间。");
}

function validateStoredPlayers(players: StoredRoomPlayer[], roomId: string, hostPlayerId: string) {
  if (players.length < 1 || players.length > ROOM_STATE_MAX_PLAYERS) {
    throw new Error(`房间 ${roomId} 的玩家数量无效。`);
  }
  if (new Set(players.map((player) => player.id)).size !== players.length) {
    throw new Error(`房间 ${roomId} 包含重复玩家 ID。`);
  }
  const nicknames = players.map((player) => player.nickname.trim().toLowerCase());
  if (new Set(nicknames).size !== nicknames.length) {
    throw new Error(`房间 ${roomId} 包含重复玩家昵称。`);
  }
  if (!players.some((player) => player.id === hostPlayerId)) {
    throw new Error(`房间 ${roomId} 的房主不在玩家列表中。`);
  }
}

function parseStoredPlayer(value: unknown): StoredRoomPlayer {
  if (!isRecord(value)) throw new Error("房间状态包含无效玩家。");
  return {
    id: requiredString(value.id, "player.id"),
    nickname: requiredString(value.nickname, "player.nickname").trim(),
    role: normalizeRole(value.role),
    joined_at: normalizeJoinedAt(value.joined_at as string | number),
  };
}

export function decodeRoomState(row: RoomStateRow): DbPlayer[] {
  if (
    row.room_state_version !== ROOM_STATE_MANIFEST_VERSION ||
    typeof row.room_state_json !== "string"
  ) {
    throw new Error(`房间 ${row.id} 使用了不支持的状态版本。`);
  }
  if (new TextEncoder().encode(row.room_state_json).byteLength > ROOM_STATE_MAX_BYTES) {
    throw new Error(`房间 ${row.id} 的状态超过大小限制。`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.room_state_json);
  } catch {
    throw new Error(`房间 ${row.id} 的状态 JSON 已损坏。`);
  }
  if (!isRecord(parsed) || parsed.schema !== ROOM_STATE_MANIFEST_VERSION || !Array.isArray(parsed.players)) {
    throw new Error(`房间 ${row.id} 的状态结构无效。`);
  }

  const players = parsed.players.map(parseStoredPlayer);
  validateStoredPlayers(players, row.id, row.host_player_id);
  return players
    .map((player) => ({
      ...player,
      room_id: row.id,
      is_host: player.id === row.host_player_id,
      last_seen_at: player.joined_at,
    }))
    .sort((left, right) => left.joined_at.localeCompare(right.joined_at) || left.id.localeCompare(right.id));
}

function toStoredPlayer(player: DbPlayer | Player): StoredRoomPlayer {
  if ("room_id" in player) {
    return {
      id: player.id,
      nickname: player.nickname.trim(),
      role: player.role === "SPECTATOR" ? "SPECTATOR" : "PLAYER",
      joined_at: normalizeJoinedAt(player.joined_at),
    };
  }
  return {
    id: player.id,
    nickname: player.nickname.trim(),
    role: player.role,
    joined_at: normalizeJoinedAt(player.joinedAt),
  };
}

export function encodeRoomState(
  roomId: string,
  hostPlayerId: string,
  players: readonly (DbPlayer | Player)[],
) {
  const stored = players
    .map(toStoredPlayer)
    .sort((left, right) => left.joined_at.localeCompare(right.joined_at) || left.id.localeCompare(right.id));
  validateStoredPlayers(stored, roomId, hostPlayerId);
  const json = JSON.stringify({
    schema: ROOM_STATE_MANIFEST_VERSION,
    players: stored,
  } satisfies StoredRoomState);
  if (new TextEncoder().encode(json).byteLength > ROOM_STATE_MAX_BYTES) {
    throw new Error(`房间 ${roomId} 的状态超过大小限制。`);
  }
  return json;
}

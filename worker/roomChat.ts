import {
  ROOM_CHAT_MAX_ENVELOPE_BYTES,
  ROOM_CHAT_MAX_TEXT_BYTES,
  ROOM_CHAT_MAX_TEXT_CODE_POINTS,
  type RoomChatErrorCode,
  type RoomChatErrorMessage,
  type RoomChatChannel,
  type RoomChatMessage,
  type RoomChatSendMessage,
} from "../src/types/chat";
import type { TeamBattleTeam } from "../src/types/game";

type RoomChatSocketAttachment = {
  topic?: string;
  playerId?: string;
};

type RateWindow = {
  startedAt: number;
  count: number;
};

export type RoomChatTeamAudience = {
  team: TeamBattleTeam;
  playerIds: ReadonlySet<string>;
};

const CHAT_MESSAGE_TYPE_PATTERN = /"type"\s*:\s*"chat_send"/;
const CHAT_RATE_WINDOW_MS = 5000;
const CHAT_RATE_MAX_MESSAGES = 3;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class RoomChatRateLimiter {
  private readonly windows = new WeakMap<WebSocket, RateWindow>();

  take(socket: WebSocket, now: number) {
    const current = this.windows.get(socket);
    if (!current || now - current.startedAt >= CHAT_RATE_WINDOW_MS) {
      this.windows.set(socket, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= CHAT_RATE_MAX_MESSAGES) return false;
    current.count += 1;
    return true;
  }
}

function asText(message: string | ArrayBuffer) {
  return typeof message === "string" ? message : decoder.decode(message);
}

function safeAttachment(socket: WebSocket): RoomChatSocketAttachment | null {
  try {
    const value = socket.deserializeAttachment() as RoomChatSocketAttachment | null;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function sendError(
  socket: WebSocket,
  code: RoomChatErrorCode,
  message: string,
  clientMessageId?: string,
) {
  const payload: RoomChatErrorMessage = { type: "chat_error", code, message, clientMessageId };
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    try { socket.close(1011, "聊天消息返回失败。"); } catch { /* The socket may already be closed. */ }
  }
}

function parseSendMessage(text: string): RoomChatSendMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<RoomChatSendMessage>;
  if (
    candidate.type !== "chat_send" ||
    typeof candidate.clientMessageId !== "string" ||
    candidate.clientMessageId.length < 1 ||
    candidate.clientMessageId.length > 100 ||
    (candidate.channel !== undefined && candidate.channel !== "room" && candidate.channel !== "team") ||
    typeof candidate.text !== "string"
  ) return null;
  return { type: "chat_send", clientMessageId: candidate.clientMessageId, channel: candidate.channel, text: candidate.text };
}

export function tryHandleRoomChatMessage(options: {
  socket: WebSocket;
  message: string | ArrayBuffer;
  sockets: readonly WebSocket[];
  rateLimiter: RoomChatRateLimiter;
  resolveTeamAudience?: (topic: string, playerId: string) => RoomChatTeamAudience | null;
  now?: number;
}) {
  const text = asText(options.message);
  if (!CHAT_MESSAGE_TYPE_PATTERN.test(text)) return false;

  if (encoder.encode(text).byteLength > ROOM_CHAT_MAX_ENVELOPE_BYTES) {
    sendError(options.socket, "INVALID_MESSAGE", "聊天消息过长。");
    return true;
  }

  const parsed = parseSendMessage(text);
  if (!parsed) {
    sendError(options.socket, "INVALID_MESSAGE", "聊天消息格式无效。");
    return true;
  }

  const normalizedText = parsed.text.trim();
  if (
    normalizedText.length === 0 ||
    Array.from(normalizedText).length > ROOM_CHAT_MAX_TEXT_CODE_POINTS ||
    encoder.encode(normalizedText).byteLength > ROOM_CHAT_MAX_TEXT_BYTES
  ) {
    sendError(options.socket, "INVALID_MESSAGE", `聊天内容应为 1～${ROOM_CHAT_MAX_TEXT_CODE_POINTS} 个字符。`, parsed.clientMessageId);
    return true;
  }

  const attachment = safeAttachment(options.socket);
  const topic = attachment?.topic?.trim();
  const playerId = attachment?.playerId?.trim();
  if (!topic || !playerId) {
    sendError(options.socket, "NO_IDENTITY", "加入房间后才能发送聊天消息。", parsed.clientMessageId);
    return true;
  }

  const now = options.now ?? Date.now();
  if (!options.rateLimiter.take(options.socket, now)) {
    sendError(options.socket, "RATE_LIMITED", "发送得太快，请稍后再试。", parsed.clientMessageId);
    return true;
  }

  const channel: RoomChatChannel = parsed.channel ?? "room";
  const teamAudience = channel === "team" ? options.resolveTeamAudience?.(topic, playerId) ?? null : null;
  if (channel === "team" && !teamAudience) {
    sendError(options.socket, "CHANNEL_UNAVAILABLE", "当前身份不能发送队内消息。", parsed.clientMessageId);
    return true;
  }

  const outgoing: RoomChatMessage = {
    type: "chat_message",
    messageId: crypto.randomUUID(),
    clientMessageId: parsed.clientMessageId,
    topic,
    playerId,
    channel,
    ...(teamAudience ? { team: teamAudience.team } : {}),
    text: normalizedText,
    sentAt: now,
  };
  const payload = JSON.stringify(outgoing);
  for (const target of options.sockets) {
    const targetAttachment = safeAttachment(target);
    if (targetAttachment?.topic !== topic) continue;
    if (teamAudience && (!targetAttachment.playerId || !teamAudience.playerIds.has(targetAttachment.playerId))) continue;
    try {
      target.send(payload);
    } catch {
      try { target.close(1011, "聊天广播失败。"); } catch { /* Best-effort cleanup. */ }
    }
  }
  return true;
}

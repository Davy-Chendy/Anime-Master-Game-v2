import { ROOM_CHAT_MAX_MESSAGES, type RoomChatMessage } from "@/types/chat";

export type StoredRoomChatMessage = RoomChatMessage & {
  nickname: string;
};

const ROOM_CHAT_STORAGE_PREFIX = "anime-master:room-chat:";

function getStorage(storage?: Storage) {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isStoredMessage(value: unknown): value is StoredRoomChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<StoredRoomChatMessage>;
  return message.type === "chat_message" &&
    typeof message.messageId === "string" &&
    typeof message.clientMessageId === "string" &&
    typeof message.topic === "string" &&
    typeof message.playerId === "string" &&
    (message.channel === undefined || message.channel === "room" || message.channel === "team") &&
    (message.team === undefined || message.team === "red" || message.team === "blue") &&
    typeof message.nickname === "string" &&
    typeof message.text === "string" &&
    typeof message.sentAt === "number" &&
    Number.isFinite(message.sentAt);
}

export function appendRoomChatMessage(
  messages: readonly StoredRoomChatMessage[],
  message: StoredRoomChatMessage,
) {
  if (messages.some((current) => current.messageId === message.messageId)) return [...messages];
  return [...messages, message].slice(-ROOM_CHAT_MAX_MESSAGES);
}

export function loadRoomChatMessages(roomId: string, storage?: Storage) {
  if (!roomId) return [];
  const target = getStorage(storage);
  if (!target) return [];
  try {
    const raw = target.getItem(`${ROOM_CHAT_STORAGE_PREFIX}${roomId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredMessage).slice(-ROOM_CHAT_MAX_MESSAGES);
  } catch {
    return [];
  }
}

export function saveRoomChatMessages(roomId: string, messages: readonly StoredRoomChatMessage[], storage?: Storage) {
  if (!roomId) return;
  const target = getStorage(storage);
  if (!target) return;
  try {
    target.setItem(`${ROOM_CHAT_STORAGE_PREFIX}${roomId}`, JSON.stringify(messages.slice(-ROOM_CHAT_MAX_MESSAGES)));
  } catch {
    // Restricted browser modes can reject sessionStorage; in-memory history remains available.
  }
}

export function clearRoomChatMessages(roomId: string, storage?: Storage) {
  if (!roomId) return;
  const target = getStorage(storage);
  if (!target) return;
  try {
    target.removeItem(`${ROOM_CHAT_STORAGE_PREFIX}${roomId}`);
  } catch {
    // Best-effort cleanup for restricted browser modes.
  }
}

export function clearAllRoomChatMessages(storage?: Storage) {
  const target = getStorage(storage);
  if (!target) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key?.startsWith(ROOM_CHAT_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) target.removeItem(key);
  } catch {
    // Best-effort cleanup for restricted browser modes.
  }
}

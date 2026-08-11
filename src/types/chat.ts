import type { TeamBattleTeam } from "./game";

export const ROOM_CHAT_MAX_MESSAGES = 100;
export const ROOM_CHAT_MAX_TEXT_CODE_POINTS = 50;
export const ROOM_CHAT_MAX_TEXT_BYTES = 1024;
export const ROOM_CHAT_MAX_ENVELOPE_BYTES = 2048;

export type RoomChatChannel = "room" | "team";

export type RoomChatSendMessage = {
  type: "chat_send";
  clientMessageId: string;
  channel?: RoomChatChannel;
  text: string;
};

export type RoomChatMessage = {
  type: "chat_message";
  messageId: string;
  clientMessageId: string;
  topic: string;
  playerId: string;
  channel?: RoomChatChannel;
  team?: TeamBattleTeam;
  text: string;
  sentAt: number;
};

export type RoomChatErrorCode = "INVALID_MESSAGE" | "RATE_LIMITED" | "NO_IDENTITY" | "CHANNEL_UNAVAILABLE";

export type RoomChatErrorMessage = {
  type: "chat_error";
  clientMessageId?: string;
  code: RoomChatErrorCode;
  message: string;
};

export type RoomChatServerEvent = RoomChatMessage | RoomChatErrorMessage;

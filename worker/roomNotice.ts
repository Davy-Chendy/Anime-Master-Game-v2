import type { RealtimeDelta } from "../src/types/game";

type RoomNoticeUpdatedDelta = Extract<RealtimeDelta, { scope: "room"; type: "room_notice_updated" }>;

export function getRoomNoticeUpdatedDelta(name: string, result: unknown): RoomNoticeUpdatedDelta | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = result as Record<string, unknown>;
  if (
    name !== "updateRoomNotice" ||
    value.changed !== true ||
    typeof value.roomId !== "string" ||
    typeof value.updatedAt !== "string" ||
    (typeof value.notice !== "string" && value.notice !== null)
  ) {
    return null;
  }
  return {
    scope: "room",
    type: "room_notice_updated",
    roomId: value.roomId,
    notice: value.notice,
    updatedAt: value.updatedAt,
  };
}

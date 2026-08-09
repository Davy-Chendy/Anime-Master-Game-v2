import { GAME_MODE_ORDER } from "@/lib/gameModeLabels";
import type { PublicRoomSummary, RoomQuestionSource } from "@/types/game";

export type PublicRoomSortKey = "name" | "status" | "mode" | "people" | "source" | "activity";
export type PublicRoomSortDirection = "asc" | "desc";

export const PUBLIC_ROOM_DEFAULT_SORT_DIRECTIONS: Record<PublicRoomSortKey, PublicRoomSortDirection> = {
  name: "asc",
  status: "asc",
  mode: "asc",
  people: "desc",
  source: "asc",
  activity: "desc",
};

function statusOrder(room: PublicRoomSummary) {
  if (room.status === "PLAYING") return 0;
  if (room.status === "QUESTION_SETUP") return room.questionSource ? 1 : 2;
  if (room.status === "LOBBY") return 3;
  return 4;
}

const SOURCE_ORDER: Record<RoomQuestionSource, number> = {
  COMMUNITY: 0,
  CREATION_TOOL: 1,
  MANUAL: 2,
};

function activityTime(room: PublicRoomSummary) {
  const value = Date.parse(room.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

function comparePrimary(left: PublicRoomSummary, right: PublicRoomSummary, key: PublicRoomSortKey) {
  if (key === "name") return left.name.localeCompare(right.name, "zh-CN");
  if (key === "activity") return activityTime(left) - activityTime(right);
  if (key === "status") return statusOrder(left) - statusOrder(right);
  if (key === "people") return left.memberCount - right.memberCount;
  if (key === "mode") return GAME_MODE_ORDER.indexOf(left.gameMode) - GAME_MODE_ORDER.indexOf(right.gameMode);
  if (!left.questionSource || !right.questionSource) return 0;
  return SOURCE_ORDER[left.questionSource] - SOURCE_ORDER[right.questionSource];
}

export function sortPublicRooms(
  rooms: PublicRoomSummary[],
  key: PublicRoomSortKey,
  direction: PublicRoomSortDirection = PUBLIC_ROOM_DEFAULT_SORT_DIRECTIONS[key],
) {
  return rooms.slice().sort((left, right) => {
    if (key === "source" && left.questionSource !== right.questionSource) {
      if (!left.questionSource) return 1;
      if (!right.questionSource) return -1;
    }
    const primary = comparePrimary(left, right, key);
    if (primary !== 0) return direction === "asc" ? primary : -primary;
    const activity = activityTime(right) - activityTime(left);
    if (activity !== 0) return activity;
    return left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id);
  });
}

import type { Room } from "@/types/game";

const LOBBY_HANDOFF_MUTATION_NAMES = new Set(["returnRoomToLobby", "cancelCurrentRound"]);

export function completesAuthorityLobbyHandoff(
  message: { name: string; authorityVersion?: 1 | 2 },
  room: Pick<Room, "status" | "currentGameId">,
) {
  return (
    message.authorityVersion === 2 &&
    LOBBY_HANDOFF_MUTATION_NAMES.has(message.name) &&
    room.status === "LOBBY" &&
    !room.currentGameId
  );
}

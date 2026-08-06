import type { Player } from "@/types/game";

export function isRoomNicknameTaken(
  players: readonly Pick<Player, "id" | "nickname">[],
  playerId: string,
  nickname: string,
) {
  const normalizedNickname = nickname.trim().toLowerCase();
  return players.some(
    (player) => player.id !== playerId && player.nickname.trim().toLowerCase() === normalizedNickname,
  );
}

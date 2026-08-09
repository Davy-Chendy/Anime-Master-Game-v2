export const ROOM_REMOVAL_NOTICE = "你已主动退出或被房主移出房间";

export function getInviteNicknameNotice(roomCode: string, nickname: string) {
  if (!/^\d{6}$/.test(roomCode) || nickname.trim()) return "";
  return `已填入房间号 ${roomCode}，输入昵称后即可加入。`;
}

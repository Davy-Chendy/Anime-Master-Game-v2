import type { GameMode } from "@/types/game";

export const GAME_MODE_ORDER: GameMode[] = [
  "ROUND_REVEAL",
  "BUZZER_FIRST_CORRECT",
  "BUZZER_RANKED",
  "TEAM_BATTLE",
];

export const GAME_MODE_LABELS: Record<GameMode, string> = {
  ROUND_REVEAL: "个人 · 标准模式",
  BUZZER_FIRST_CORRECT: "个人 · 抢答模式",
  BUZZER_RANKED: "个人 · 顺位得分模式",
  TEAM_BATTLE: "团队 · 对抗模式",
};

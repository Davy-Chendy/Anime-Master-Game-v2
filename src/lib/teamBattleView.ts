import type { TeamBattleTeam } from "../types/game";

type TeamBattleViewerAccessParams = {
  activeTeam: TeamBattleTeam;
  isPresenter: boolean;
  isSpectator: boolean;
  viewerTeam: TeamBattleTeam | null;
};

export function getTeamBattleViewerAccess({
  activeTeam,
  isPresenter,
  isSpectator,
  viewerTeam,
}: TeamBattleViewerAccessParams) {
  const isActiveTeamPlayer = viewerTeam === activeTeam;

  return {
    canAct: !isPresenter && !isSpectator && isActiveTeamPlayer,
    canSeeVotes: isPresenter || isSpectator || isActiveTeamPlayer,
  };
}

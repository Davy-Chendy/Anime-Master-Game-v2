import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getTeamBattleViewerAccess } from "../src/lib/teamBattleView";

test("team battle spectators can see live votes but cannot act", () => {
  assert.deepEqual(
    getTeamBattleViewerAccess({
      activeTeam: "red",
      isPresenter: false,
      isSpectator: true,
      viewerTeam: null,
    }),
    { canAct: false, canSeeVotes: true },
  );
});

test("team battle vote visibility preserves presenter and team access", () => {
  assert.deepEqual(
    getTeamBattleViewerAccess({ activeTeam: "red", isPresenter: true, isSpectator: false, viewerTeam: null }),
    { canAct: false, canSeeVotes: true },
  );
  assert.deepEqual(
    getTeamBattleViewerAccess({ activeTeam: "red", isPresenter: false, isSpectator: false, viewerTeam: "red" }),
    { canAct: true, canSeeVotes: true },
  );
  assert.deepEqual(
    getTeamBattleViewerAccess({ activeTeam: "red", isPresenter: false, isSpectator: false, viewerTeam: "blue" }),
    { canAct: false, canSeeVotes: false },
  );
});

test("team battle review renders the correct guess proposer in the visible review panel", () => {
  const source = readFileSync(new URL("../src/components/ImageRevealGame.tsx", import.meta.url), "utf8");
  const reviewPanelStart = source.indexOf(") : isQuestionReviewing ? (");
  const teamBattlePanelStart = source.indexOf(") : isTeamBattleMode && teamBattleState ? (", reviewPanelStart);
  const proposerDisplay = source.indexOf("提出者：{teamBattleState.correctGuess.proposerName}", reviewPanelStart);

  assert.ok(reviewPanelStart >= 0, "expected the shared review panel");
  assert.ok(teamBattlePanelStart > reviewPanelStart, "expected the team battle action panel after the shared review panel");
  assert.ok(
    proposerDisplay > reviewPanelStart && proposerDisplay < teamBattlePanelStart,
    "expected the proposer to render in the shared review panel reached by every TEAM_BATTLE viewer",
  );
});

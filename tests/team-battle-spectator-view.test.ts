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

test("team battle can open the shared previous-question review", () => {
  const source = readFileSync(new URL("../src/components/ImageRevealGame.tsx", import.meta.url), "utf8");
  const handlerStart = source.indexOf("function handleOpenPreviousQuestionReview");
  const handlerEnd = source.indexOf("\n  }", handlerStart);
  const footerStart = source.indexOf('<div className="grid items-center gap-3 lg:grid-cols-6">');
  const reviewButton = source.indexOf("回顾上题", footerStart);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "expected the previous-question review handler");
  assert.ok(
    !source.slice(handlerStart, handlerEnd).includes("isTeamBattleMode"),
    "expected the previous-question review handler to allow TEAM_BATTLE",
  );
  assert.ok(footerStart >= 0 && reviewButton > footerStart, "expected the shared footer to render the review button");
  assert.ok(
    !source.slice(footerStart, reviewButton).includes("!isTeamBattleMode"),
    "expected the review button to render in TEAM_BATTLE",
  );
});

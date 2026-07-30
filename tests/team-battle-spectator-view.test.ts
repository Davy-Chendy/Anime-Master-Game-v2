import assert from "node:assert/strict";
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

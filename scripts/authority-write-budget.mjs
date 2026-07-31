import assert from "node:assert/strict";

const players = Number.parseInt(process.argv[2] ?? "50", 10);
const questions = Number.parseInt(process.argv[3] ?? "30", 10);
const checkpointEvery = 20;
const roomRuntimeV3 = {
  sqliteTables: 5,
  applicationRowsOnFirstUse: 2,
  legacyTables: 0,
  d1GenerationIndexRowsPerRoomWrite: 0,
  websocketGenerationReadsAt50People10Rooms: 50 * 10,
};

if (!Number.isInteger(players) || players < 1 || players > 50) throw new Error("players must be 1..50");
if (!Number.isInteger(questions) || questions < 1 || questions > 30) throw new Error("questions must be 1..30");

const answers = players * questions;
const judgements = players * questions;
const actions = answers + judgements;

// Legacy lower bounds come from the current journal + normalized-table path.
// A normal answer changes two journal rows, two answer rows, the authority
// version, then deletes two journal rows. A single judgement additionally
// validates the journal, changes answer/result, rewrites player score rows,
// persists an action receipt, and clears all three journal rows.
const legacyAnswerRows = 7;
const legacyJudgementRows = players + 10;
const legacyRows = answers * legacyAnswerRows + judgements * legacyJudgementRows;

// vNext coalesces every 20 actions into one active_game update. Each question
// boundary persists active_game plus one archive row. The final projection
// outbox costs one upsert and one delete after a successful D1 projection.
const rollingCheckpointsPerQuestion = Math.ceil((players * 2) / checkpointEvery);
const vnextCheckpointRows = rollingCheckpointsPerQuestion * questions;
const vnextBoundaryRows = questions * 2;
const vnextProjectionRows = 2;
const vnextRows = vnextCheckpointRows + vnextBoundaryRows + vnextProjectionRows;

// TEAM_BATTLE timer example used by the rules/budget review: one question,
// six active team members, one presenter block-selection mutation, ten reveal
// phases and ten guess phases. Completing block selection persists one
// active_game row but only defers the first reveal Alarm; it does not add an
// Alarm. A phase-end deadline checkpoint also persists one active_game row.
// With one submission per member per phase, each phase stays below the 20-action
// rolling threshold. If all members finish early, the early-completion checkpoint
// absorbs those dirty actions before the later deadline checkpoint. D1 remains
// untouched until the final projection.
const teamExample = {
  activeMembers: 6,
  presenterBlockMutations: 1,
  revealPhases: 10,
  guessPhases: 10,
};
const teamExamplePhases = teamExample.revealPhases + teamExample.guessPhases;
const teamExampleVoteMutations = teamExample.activeMembers * teamExamplePhases;
const teamExamplePresenterFallbackMutationsAtMost = teamExamplePhases;
const teamExampleTurnResultConfirmationMutationsAtMost = teamExample.guessPhases;
const teamExampleBlockCheckpointRows = teamExample.presenterBlockMutations;
const teamExampleDeadlineCheckpointRows = teamExamplePhases + teamExampleBlockCheckpointRows;
const teamExampleTurnResultConfirmationCheckpointRowsAtMost = teamExample.guessPhases;
const teamExampleEarlyCompletionCheckpointRows = teamExamplePhases;
const teamExampleExtraRollingRows = Math.floor(teamExample.activeMembers / checkpointEvery) * teamExamplePhases;
const teamExampleAlarmSchedules = teamExamplePhases * 2;
const teamBlockSelectionBudget = {
  perGameMutations: questions,
  perGameCheckpointRows: questions,
  perDayMutationsAt60Games: questions * 60,
  perDayCheckpointRowsAt60Games: questions * 60,
};
const teamTurnResultBudget = {
  confirmationsPerQuestionAtMost: teamExample.guessPhases,
  perGameMutationsAtMost: questions * teamExample.guessPhases,
  perGameCheckpointRowsAtMost: questions * teamExample.guessPhases,
  perDayMutationsAt60GamesAtMost: questions * teamExample.guessPhases * 60,
  perDayCheckpointRowsAt60GamesAtMost: questions * teamExample.guessPhases * 60,
};

// D1 billing is based on rows read/written, not SQL statement count. The new
// result archive is one aggregate row. Roster reconciliation writes nothing
// when the expected D1 roster is already current; genuinely changed members
// still pay for their table row and affected index rows.
const d1ArchiveRows = 1;
const d1QuestionRows = questions;
const d1RoomSessionAndCompletionRows = 3;
const d1UnchangedRosterRows = 0;
const d1NonRosterIndexOverheadConservative = { lower: 1, upper: 35 };
const d1EstimatedRows = {
  lower: d1ArchiveRows + d1QuestionRows + d1RoomSessionAndCompletionRows + d1NonRosterIndexOverheadConservative.lower,
  upper: d1ArchiveRows + d1QuestionRows + d1RoomSessionAndCompletionRows + d1NonRosterIndexOverheadConservative.upper,
};
const avoidedNormalizedResultRows = players + players + answers;

assert.equal(answers, players * questions);
assert.equal(judgements, players * questions);
if (players === 50 && questions === 30) {
  assert.deepEqual(roomRuntimeV3, {
    sqliteTables: 5,
    applicationRowsOnFirstUse: 2,
    legacyTables: 0,
    d1GenerationIndexRowsPerRoomWrite: 0,
    websocketGenerationReadsAt50People10Rooms: 500,
  });
  assert.ok(vnextRows >= 150 && vnextRows <= 300, `vNext write target missed: ${vnextRows}`);
  assert.ok(d1EstimatedRows.upper <= 500, `D1 final projection target missed: ${d1EstimatedRows.upper}`);
  assert.deepEqual(teamBlockSelectionBudget, {
    perGameMutations: 30,
    perGameCheckpointRows: 30,
    perDayMutationsAt60Games: 1_800,
    perDayCheckpointRowsAt60Games: 1_800,
  });
  assert.deepEqual(teamTurnResultBudget, {
    confirmationsPerQuestionAtMost: 10,
    perGameMutationsAtMost: 300,
    perGameCheckpointRowsAtMost: 300,
    perDayMutationsAt60GamesAtMost: 18_000,
    perDayCheckpointRowsAt60GamesAtMost: 18_000,
  });
  assert.equal(
    teamExampleVoteMutations
      + teamExample.presenterBlockMutations
      + teamExamplePresenterFallbackMutationsAtMost
      + teamExampleTurnResultConfirmationMutationsAtMost,
    151,
  );
}

console.log(JSON.stringify({
  players,
  questions,
  actions,
  legacy: {
    answerRowsEachLowerBound: legacyAnswerRows,
    judgementRowsEachLowerBound: legacyJudgementRows,
    estimatedRowsWrittenLowerBound: legacyRows,
  },
  vnext: {
    rollingCheckpointsPerQuestion,
    checkpointRows: vnextCheckpointRows,
    questionBoundaryRows: vnextBoundaryRows,
    finalProjectionRows: vnextProjectionRows,
    estimatedRowsWritten: vnextRows,
    teamBlockSelectionBudget,
    teamTurnResultBudget,
    teamTimerExample: {
      ...teamExample,
      voteMutations: teamExampleVoteMutations,
      presenterDeadlineFallbackMutationsAtMost: teamExamplePresenterFallbackMutationsAtMost,
      turnResultConfirmationMutationsAtMost: teamExampleTurnResultConfirmationMutationsAtMost,
      totalMutationsAtMost:
        teamExampleVoteMutations
        + teamExample.presenterBlockMutations
        + teamExamplePresenterFallbackMutationsAtMost
        + teamExampleTurnResultConfirmationMutationsAtMost,
      blockSelectionCheckpointRows: teamExampleBlockCheckpointRows,
      turnResultConfirmationCheckpointRowsAtMost: teamExampleTurnResultConfirmationCheckpointRowsAtMost,
      alarmSchedulesAtMostWhenEveryPhaseCompletesEarly: teamExampleAlarmSchedules,
      alarmExecutions: teamExamplePhases,
      deadlineCheckpointRows: teamExampleDeadlineCheckpointRows,
      earlyCompletionCheckpointRowsAtMost: teamExampleEarlyCompletionCheckpointRows,
      extraRollingCheckpointRows: teamExampleExtraRollingRows,
      d1RowsDuringGame: 0,
    },
  },
  roomRuntimeV3: {
    ...roomRuntimeV3,
    note: "First-use logical rows are schema-version + runtime-meta; SQLite catalog rows must be measured in production billing rather than guessed.",
  },
  d1FinalProjection: {
    aggregateArchiveRows: d1ArchiveRows,
    questionLabelRowsAtMost: d1QuestionRows,
    roomSessionAndCompletionRows: d1RoomSessionAndCompletionRows,
    unchangedRosterRows: d1UnchangedRosterRows,
    changedMemberRowsIncludingIndexesEach: { insertOrDelete: "about 4-5", replace: "about 8-10" },
    nonRosterIndexOverheadConservative: d1NonRosterIndexOverheadConservative,
    typicalEstimatedRowsWrittenWithUnchangedRoster: d1EstimatedRows,
    normalizedParticipantScoreAndQuestionResultRowsAvoidedAtMost: avoidedNormalizedResultRows,
    note: "Only real roster changes are billed; SQL statement count is not treated as rows_written.",
  },
}, null, 2));

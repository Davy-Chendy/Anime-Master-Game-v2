import assert from "node:assert/strict";

const players = Number.parseInt(process.argv[2] ?? "50", 10);
const questions = Number.parseInt(process.argv[3] ?? "30", 10);
const checkpointEvery = 20;
const roomRuntimeV4 = {
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
// six active team members, presenter block selection disabled by default, ten
// reveal phases and ten guess phases. Enabling the advanced option adds one
// presenter mutation and one active_game checkpoint but only defers the first
// reveal Alarm; it does not add an Alarm. A phase-end deadline checkpoint also
// persists one active_game row.
// With one submission per member per phase, each phase stays below the 20-action
// rolling threshold. If all members finish early, the early-completion checkpoint
// absorbs those dirty actions before the later deadline checkpoint. D1 remains
// untouched until the final projection.
const teamExample = {
  activeMembers: 6,
  presenterBlockEnabledByDefault: false,
  presenterBlockMutations: 0,
  presenterBlockMutationsWhenEnabled: 1,
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
  defaultPerGameMutations: 0,
  defaultPerGameCheckpointRows: 0,
  whenEnabledPerGameMutations: questions,
  whenEnabledPerGameCheckpointRows: questions,
  whenEnabledPerDayMutationsAt60Games: questions * 60,
  whenEnabledPerDayCheckpointRowsAt60Games: questions * 60,
};
const teamTurnResultBudget = {
  confirmationsPerQuestionAtMost: teamExample.guessPhases,
  perGameMutationsAtMost: questions * teamExample.guessPhases,
  perGameCheckpointRowsAtMost: questions * teamExample.guessPhases,
  perDayMutationsAt60GamesAtMost: questions * teamExample.guessPhases * 60,
  perDayCheckpointRowsAt60GamesAtMost: questions * teamExample.guessPhases * 60,
};

// D1 billing is based on rows read/written, not SQL statement count. The new
// result archive is one aggregate row. Runtime generation 4 stores the roster
// in the existing room row, so final room lifecycle + roster projection is one
// UPDATE and never reconciles normalized player/index rows.
const d1ArchiveRows = 1;
const d1LegacyQuestionLabelRows = questions;
const d1ManifestQuestionLabelRows = { clean: 0, dirtyAtMost: 1 };
const d1RoomSessionAndCompletionRows = 3;
const d1NormalizedPlayerRows = 0;
const d1AggregateRoomDataRows = 1;
const d1NonRosterIndexOverheadConservative = { lower: 1, upper: 35 };
const d1EstimatedRows = {
  lower: d1ArchiveRows + d1ManifestQuestionLabelRows.clean + d1RoomSessionAndCompletionRows + d1NonRosterIndexOverheadConservative.lower,
  upper: d1ArchiveRows + d1ManifestQuestionLabelRows.dirtyAtMost + d1RoomSessionAndCompletionRows + d1NonRosterIndexOverheadConservative.upper,
};
// 2026-07-30 production attribution: question-set rows averaged 146/16
// rowsWritten per INSERT and 204 normalized question rows cost 796 rowsWritten.
// A new private manifest row maintains the table row, PK, creator index, and
// private-cleanup partial index, so its pre-deployment estimate is four rows.
const normalizedQuestionSetCreationRows = (146 / 16) + ((796 / 204) * questions);
const manifestQuestionSetCreationRows = 4;
const questionSetCreationRowsSaved = normalizedQuestionSetCreationRows - manifestQuestionSetCreationRows;
const labelProjectionRowsSavedAtMost = d1LegacyQuestionLabelRows - d1ManifestQuestionLabelRows.dirtyAtMost;
const manifestSavingsAt60Games = (questionSetCreationRowsSaved + labelProjectionRowsSavedAtMost) * 60;
const avoidedNormalizedResultRows = players + players + answers;
const productionPlayerRoomBaseline = {
  date: "2026-07-30",
  playerWrites: 969,
  roomWrites: 325,
  playerAndRoomWrites: 1294,
  finalRosterDifferenceReads: 4512,
};
const aggregatePlayerWriteTarget = { lower: 150, upper: 220 };
const postManifestDailyWriteTarget = { lower: 1330, upper: 1600 };
const communityRatingCountSortBudget = {
  addedPartialIndexes: 2,
  ratingSubmissionsPerGameAtMost: players,
  ratingSubmissionsPerDayAt60GamesAtMost: players * 60,
  addedIndexMaintenancePathsPerDayAt60GamesAtMost: players * 60 * 2,
};

assert.equal(answers, players * questions);
assert.equal(judgements, players * questions);
if (players === 50 && questions === 30) {
  assert.deepEqual(roomRuntimeV4, {
    sqliteTables: 5,
    applicationRowsOnFirstUse: 2,
    legacyTables: 0,
    d1GenerationIndexRowsPerRoomWrite: 0,
    websocketGenerationReadsAt50People10Rooms: 500,
  });
  assert.ok(vnextRows >= 150 && vnextRows <= 300, `vNext write target missed: ${vnextRows}`);
  assert.ok(d1EstimatedRows.upper <= 500, `D1 final projection target missed: ${d1EstimatedRows.upper}`);
  assert.ok(manifestSavingsAt60Games >= 8_900, `manifest daily write saving target missed: ${manifestSavingsAt60Games}`);
  assert.ok(aggregatePlayerWriteTarget.upper < productionPlayerRoomBaseline.playerWrites / 4);
  assert.deepEqual(communityRatingCountSortBudget, {
    addedPartialIndexes: 2,
    ratingSubmissionsPerGameAtMost: 50,
    ratingSubmissionsPerDayAt60GamesAtMost: 3_000,
    addedIndexMaintenancePathsPerDayAt60GamesAtMost: 6_000,
  });
  assert.deepEqual(teamBlockSelectionBudget, {
    defaultPerGameMutations: 0,
    defaultPerGameCheckpointRows: 0,
    whenEnabledPerGameMutations: 30,
    whenEnabledPerGameCheckpointRows: 30,
    whenEnabledPerDayMutationsAt60Games: 1_800,
    whenEnabledPerDayCheckpointRowsAt60Games: 1_800,
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
    150,
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
      totalMutationsAtMostWhenPresenterBlockEnabled:
        teamExampleVoteMutations
        + teamExample.presenterBlockMutationsWhenEnabled
        + teamExamplePresenterFallbackMutationsAtMost
        + teamExampleTurnResultConfirmationMutationsAtMost,
      blockSelectionCheckpointRows: teamExampleBlockCheckpointRows,
      blockSelectionCheckpointRowsWhenEnabled: teamExample.presenterBlockMutationsWhenEnabled,
      turnResultConfirmationCheckpointRowsAtMost: teamExampleTurnResultConfirmationCheckpointRowsAtMost,
      alarmSchedulesAtMostWhenEveryPhaseCompletesEarly: teamExampleAlarmSchedules,
      alarmExecutions: teamExamplePhases,
      deadlineCheckpointRows: teamExampleDeadlineCheckpointRows,
      earlyCompletionCheckpointRowsAtMost: teamExampleEarlyCompletionCheckpointRows,
      extraRollingCheckpointRows: teamExampleExtraRollingRows,
      d1RowsDuringGame: 0,
    },
  },
  roomRuntimeV4: {
    ...roomRuntimeV4,
    note: "First-use logical rows are schema-version + runtime-meta; SQLite catalog rows must be measured in production billing rather than guessed.",
  },
  d1FinalProjection: {
    aggregateArchiveRows: d1ArchiveRows,
    legacyQuestionLabelRowsAtMost: d1LegacyQuestionLabelRows,
    manifestQuestionLabelRows: d1ManifestQuestionLabelRows,
    roomSessionAndCompletionRows: d1RoomSessionAndCompletionRows,
    aggregateRoomDataRows: d1AggregateRoomDataRows,
    normalizedPlayerRows: d1NormalizedPlayerRows,
    finalRosterDifferenceReads: 0,
    nonRosterIndexOverheadConservative: d1NonRosterIndexOverheadConservative,
    typicalEstimatedRowsWrittenWithUnchangedRoster: d1EstimatedRows,
    normalizedParticipantScoreAndQuestionResultRowsAvoidedAtMost: avoidedNormalizedResultRows,
    note: "Room lifecycle and the full bounded roster share one room UPDATE. SQL statement count is not treated as rows_written; Analytics remains authoritative.",
  },
  roomStateV4: {
    productionBaseline: productionPlayerRoomBaseline,
    playerDerivedWriteTarget: aggregatePlayerWriteTarget,
    postManifestDailyWriteTarget,
    avoidedFinalRosterDifferenceReads: productionPlayerRoomBaseline.finalRosterDifferenceReads,
  },
  questionSetManifest: {
    productionBaseline: "2026-07-30",
    normalizedQuestionSetCreationRows,
    manifestQuestionSetCreationRows,
    questionSetCreationRowsSaved,
    labelProjectionRowsSavedAtMost,
    estimatedRowsSavedAt60Games: manifestSavingsAt60Games,
    note: "The normalized estimate uses measured production coefficients (146/16 + 796/204 per question); the four-row manifest estimate must be replaced with post-deployment Analytics.",
  },
  communityRatingCountSort: {
    ...communityRatingCountSortBudget,
    note: "Index-maintenance paths are a pre-deployment workload bound, not billed rowsWritten. D1 Analytics remains authoritative because an index key change can have platform-specific accounting.",
  },
}, null, 2));

import assert from "node:assert/strict";

const players = Number.parseInt(process.argv[2] ?? "50", 10);
const questions = Number.parseInt(process.argv[3] ?? "30", 10);
const checkpointEvery = 20;

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
  assert.ok(vnextRows >= 150 && vnextRows <= 300, `vNext write target missed: ${vnextRows}`);
  assert.ok(d1EstimatedRows.upper <= 500, `D1 final projection target missed: ${d1EstimatedRows.upper}`);
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

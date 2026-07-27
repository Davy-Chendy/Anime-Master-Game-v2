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

assert.equal(answers, players * questions);
assert.equal(judgements, players * questions);
if (players === 50 && questions === 30) {
  assert.ok(vnextRows >= 150 && vnextRows <= 300, `vNext write target missed: ${vnextRows}`);
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
}, null, 2));

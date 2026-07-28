import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDirectory, "..");
const artifactDirectory = join(root, ".codex-question-set-backfill");
const databaseName = "anime_master_game";
const wranglerExecutable = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const allowedMethods = new Set(["player_manual", "creation_tool_assisted"]);

function parseArgs(argv) {
  const result = { apply: false, confirmCount: null, reportPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") result.apply = true;
    else if (value === "--confirm-count") result.confirmCount = Number(argv[++index]);
    else if (value === "--report") result.reportPath = resolve(root, argv[++index]);
    else throw new Error(`未知参数：${value}`);
  }
  return result;
}

async function findLatestReport(explicitPath) {
  if (explicitPath) return explicitPath;
  const files = (await readdir(artifactDirectory))
    .filter((name) => /^question-set-creation-method-.+\.json$/.test(name))
    .sort();
  if (files.length === 0) throw new Error("没有找到题库来源分析报告，请先运行 analyze:question-set-creation-method。");
  return join(artifactDirectory, files.at(-1));
}

function runWrangler(args, options = {}) {
  return execFileSync(process.execPath, [wranglerExecutable, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function parseWranglerJson(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("Wrangler 没有返回可解析的 JSON。");
  return JSON.parse(output.slice(start, end + 1));
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function loadPlan(report) {
  if (report.mode !== "dry-run" || report.databaseChanged !== false || !Array.isArray(report.items)) {
    throw new Error("分析报告格式无效，或报告不是只读 dry-run 结果。");
  }
  const updates = report.items
    .filter((item) => item.creationMethod != null)
    .map((item) => ({ id: String(item.questionSetId), creationMethod: String(item.creationMethod) }));
  const ids = new Set();
  for (const update of updates) {
    if (!/^[a-zA-Z0-9_-]+$/.test(update.id)) throw new Error(`题库 ID 格式无效：${update.id}`);
    if (!allowedMethods.has(update.creationMethod)) throw new Error(`题库来源值无效：${update.creationMethod}`);
    if (ids.has(update.id)) throw new Error(`分析报告包含重复题库 ID：${update.id}`);
    ids.add(update.id);
  }
  return updates;
}

function readRemoteTargets(updates) {
  if (updates.length === 0) return [];
  const ids = updates.map((update) => sqlString(update.id)).join(",");
  const output = runWrangler([
    "d1", "execute", databaseName, "--remote", "--json",
    "--command", `SELECT id,is_public,creation_method FROM question_sets WHERE id IN (${ids}) ORDER BY id`,
  ]);
  return parseWranglerJson(output)[0]?.results ?? [];
}

function validateRemoteTargets(updates, rows) {
  const expected = new Map(updates.map((update) => [update.id, update.creationMethod]));
  const actual = new Map(rows.map((row) => [String(row.id), row]));
  if (actual.size !== expected.size) {
    const missing = Array.from(expected.keys()).filter((id) => !actual.has(id));
    throw new Error(`线上缺少 ${missing.length} 个目标题库：${missing.join(", ")}`);
  }
  const conflicts = [];
  const pending = [];
  for (const [id, creationMethod] of expected) {
    const row = actual.get(id);
    if (Number(row.is_public) !== 1) throw new Error(`目标题库不是公开题库：${id}`);
    if (row.creation_method == null) pending.push({ id, creationMethod });
    else if (row.creation_method !== creationMethod) conflicts.push({ id, expected: creationMethod, actual: row.creation_method });
  }
  if (conflicts.length > 0) throw new Error(`已有分类与报告冲突：${JSON.stringify(conflicts)}`);
  return pending;
}

function buildUpdateSql(pending) {
  const cases = pending.map((item) => `WHEN ${sqlString(item.id)} THEN ${sqlString(item.creationMethod)}`).join("\n    ");
  const ids = pending.map((item) => sqlString(item.id)).join(",");
  return `UPDATE question_sets\nSET creation_method = CASE id\n    ${cases}\n  END\nWHERE is_public = 1\n  AND creation_method IS NULL\n  AND id IN (${ids});\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(artifactDirectory, { recursive: true });
  const reportPath = await findLatestReport(args.reportPath);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const updates = loadPlan(report);
  const rowsBefore = readRemoteTargets(updates);
  const pending = validateRemoteTargets(updates, rowsBefore);
  const summary = {
    reportPath,
    report: basename(reportPath),
    planned: updates.length,
    playerManual: updates.filter((item) => item.creationMethod === "player_manual").length,
    creationToolAssisted: updates.filter((item) => item.creationMethod === "creation_tool_assisted").length,
    alreadyMatching: updates.length - pending.length,
    pending: pending.length,
    unresolvedKeptNull: report.items.filter((item) => item.creationMethod == null).length,
  };

  if (!args.apply) {
    process.stdout.write(`${JSON.stringify({ mode: "dry-run", databaseChanged: false, ...summary }, null, 2)}\n`);
    return;
  }
  if (!Number.isInteger(args.confirmCount) || args.confirmCount !== pending.length) {
    throw new Error(`正式执行必须传入 --confirm-count ${pending.length}，当前为 ${String(args.confirmCount)}。`);
  }
  if (pending.length === 0) {
    process.stdout.write(`${JSON.stringify({ mode: "apply", databaseChanged: false, ...summary }, null, 2)}\n`);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(artifactDirectory, `anime-master-game-before-creation-method-backfill-${timestamp}.sql`);
  runWrangler(["d1", "export", databaseName, "--remote", "--skip-confirmation", "--output", backupPath], { inherit: true });

  const sqlPath = join(artifactDirectory, `question-set-creation-method-apply-${timestamp}.sql`);
  await writeFile(sqlPath, buildUpdateSql(pending), "utf8");
  runWrangler(["d1", "execute", databaseName, "--remote", "--yes", "--file", sqlPath], { inherit: true });

  const rowsAfter = readRemoteTargets(updates);
  const stillPending = validateRemoteTargets(updates, rowsAfter);
  if (stillPending.length > 0) throw new Error(`回填后仍有 ${stillPending.length} 个目标题库为 NULL。`);
  process.stdout.write(`${JSON.stringify({
    mode: "apply",
    databaseChanged: true,
    ...summary,
    updated: pending.length,
    backupPath,
    sqlPath,
    verified: updates.length,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

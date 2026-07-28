import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDirectory, "..");
const reportDirectory = join(root, ".codex-question-set-backfill");
const configPath = join(scriptsDirectory, "wrangler.question-set-creation-analysis.jsonc");
const port = 8791;
const origin = `http://127.0.0.1:${port}`;
const wranglerExecutable = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

async function waitForHealth(child, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode != null) throw new Error(`Wrangler 提前退出，退出码 ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Wrangler is still starting.
    }
    await wait(500);
  }
  throw new Error("等待只读分析 Worker 启动超时。");
}

async function main() {
  await mkdir(reportDirectory, { recursive: true });
  const child = spawn(
    process.execPath,
    [wranglerExecutable, "dev", "--config", configPath, "--port", String(port), "--show-interactive-dev-session", "false"],
    { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk.toString(); });
  child.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });

  try {
    await waitForHealth(child);
    const response = await fetch(`${origin}/analyze`, { headers: { accept: "application/json" } });
    const body = await response.text();
    if (!response.ok) throw new Error(`线上只读分析失败（${response.status}）：${body}`);
    const report = JSON.parse(body);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = join(reportDirectory, `question-set-creation-method-${timestamp}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ reportPath, summary: report.summary }, null, 2)}\n`);
  } catch (error) {
    if (diagnostics.trim()) process.stderr.write(`${diagnostics.trim()}\n`);
    throw error;
  } finally {
    child.kill("SIGTERM");
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

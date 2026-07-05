#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ACCOUNT_ID = "77dd7cd7d595510c8dc8f6f8967ddb70";
const DEFAULT_SERVICE = "anime-master-game-api";
const DEFAULT_DATASET = "cloudflare-workers";

function printHelp() {
  console.log(`Usage:
  node scripts/export-cf-observability.mjs --from 2026-07-03T19:28:00Z --to 2026-07-03T19:50:00Z --out logs.json

Required:
  CLOUDFLARE_API_TOKEN  API token with Workers Observability read access.

Options:
  --account <id>        Cloudflare account id. Defaults to this project's account.
  --service <name>      Worker service name. Defaults to ${DEFAULT_SERVICE}.
  --from <iso|ms>       Start time, inclusive.
  --to <iso|ms>         End time, exclusive-ish.
  --out <path>          Output file. Defaults to observability-events-<timestamp>.json.
  --format <json|jsonl> Output format. Defaults to json.
  --limit <n>           Page size. Defaults to 1000.
  --max <n>             Stop after this many events. Defaults to no cap.
  --dataset <name>      Dataset. Defaults to ${DEFAULT_DATASET}.
  --trigger <text>      Optional exact $metadata.trigger filter.
  --event-type <text>   Optional exact $workers.eventType filter, e.g. fetch/websocket/alarm.
  --help                Show this help.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") {
      args.help = true;
      continue;
    }
    if (!key.startsWith("--")) {
      throw new Error(`Unknown positional argument: ${key}`);
    }
    const name = key.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    args[name] = value;
    i += 1;
  }
  return args;
}

function parseTime(value, label) {
  if (!value) {
    throw new Error(`Missing --${label}`);
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid --${label}: ${value}`);
  }
  return ms;
}

function buildFilters({ service, trigger, eventType }) {
  const filters = [
    {
      key: "$metadata.service",
      operation: "eq",
      type: "string",
      value: service,
    },
  ];

  if (trigger) {
    filters.push({
      key: "$metadata.trigger",
      operation: "eq",
      type: "string",
      value: trigger,
    });
  }

  if (eventType) {
    filters.push({
      key: "$workers.eventType",
      operation: "eq",
      type: "string",
      value: eventType,
    });
  }

  return filters;
}

async function queryPage({ token, accountId, from, to, dataset, filters, limit, offset }) {
  const body = {
    queryId: "codex-observability-export",
    timeframe: { from, to },
    view: "events",
    limit,
    offsetDirection: "next",
    parameters: {
      datasets: [dataset],
      filterCombination: "and",
      filters,
    },
  };

  if (offset) {
    body.offset = offset;
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const payload = await response.json().catch(async () => ({ text: await response.text() }));
  if (!response.ok || payload.success === false) {
    const details = payload.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") || JSON.stringify(payload);
    throw new Error(`Cloudflare query failed (${response.status}): ${details}`);
  }

  return payload.result;
}

async function writeJson(outputPath, events) {
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(events, null, 2)}\n`, "utf8");
}

async function writeJsonl(outputPath, events, append) {
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  const text = events.map((event) => JSON.stringify(event)).join("\n");
  if (!text) {
    return;
  }
  await fs[append ? "appendFile" : "writeFile"](outputPath, `${text}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (!token) {
    throw new Error("Set CLOUDFLARE_API_TOKEN first. Wrangler OAuth cache is not used by this exporter.");
  }

  const accountId = args.account || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const service = args.service || DEFAULT_SERVICE;
  const dataset = args.dataset || DEFAULT_DATASET;
  const from = parseTime(args.from, "from");
  const to = parseTime(args.to, "to");
  const limit = Math.max(1, Math.min(5000, Number(args.limit || 1000)));
  const max = args.max ? Number(args.max) : Infinity;
  const format = args.format || "json";
  if (!["json", "jsonl"].includes(format)) {
    throw new Error("--format must be json or jsonl");
  }

  const outputPath =
    args.out ||
    `observability-events-${new Date(from).toISOString().replace(/[:.]/g, "-")}-${new Date(to)
      .toISOString()
      .replace(/[:.]/g, "-")}.${format}`;

  const filters = buildFilters({ service, trigger: args.trigger, eventType: args["event-type"] });
  const allEvents = [];
  let offset = args.offset || "";
  let page = 0;
  let append = false;

  while (allEvents.length < max) {
    page += 1;
    const pageLimit = Math.min(limit, max - allEvents.length);
    const result = await queryPage({
      token,
      accountId,
      from,
      to,
      dataset,
      filters,
      limit: pageLimit,
      offset,
    });

    const events = result?.events?.events || [];
    const lastId = events.at(-1)?.$metadata?.id;
    console.error(
      `page=${page} fetched=${events.length} total=${allEvents.length + events.length} scanned=${result?.statistics?.rows_read ?? "?"}`,
    );

    if (format === "jsonl") {
      await writeJsonl(outputPath, events, append);
      append = true;
    } else {
      allEvents.push(...events);
    }

    if (format === "jsonl") {
      allEvents.length += events.length;
    }

    if (events.length === 0 || events.length < pageLimit || !lastId || lastId === offset) {
      break;
    }
    offset = lastId;
  }

  if (format === "json") {
    await writeJson(outputPath, allEvents.slice(0, max));
  }

  console.error(`wrote ${Math.min(allEvents.length, max)} events to ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

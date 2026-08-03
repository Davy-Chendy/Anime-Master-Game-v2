import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configPath = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
  "xdg.config",
  ".wrangler",
  "config",
  "default.toml",
);
const config = fs.readFileSync(configPath, "utf8");
const token = config.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
if (!token) throw new Error("Wrangler OAuth token not found");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const url = request.url ?? "https://api.cloudflare.com/client/v4/graphql";
const method = request.method ?? "POST";
const body = request.url ? request.body : request;
const response = await fetch(url, {
  method,
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: method === "GET" ? undefined : JSON.stringify(body),
});
console.log(JSON.stringify(await response.json(), null, 2));

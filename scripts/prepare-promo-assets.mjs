import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const projectRoot = process.cwd();
const referenceRoot = path.resolve(
  process.env.ANIME_SCREENSHOT_PICKER_PATH || path.join(projectRoot, "..", "anime-screenshot-picker")
);
const referencePublic = path.join(referenceRoot, "public");
const outputRoot = path.join(projectRoot, "public", "promo", "assets");
const fancapsOutput = path.join(outputRoot, "fancaps");
const coversOutput = path.join(outputRoot, "covers");
const charactersOutput = path.join(outputRoot, "characters");
const USER_AGENT = "AnimeMasterPromo/1.0 (local promotional recording tool)";

const counts = {
  fancaps: Number(process.env.PROMO_FANCAPS_COUNT || 180),
  covers: Number(process.env.PROMO_COVER_COUNT || 100),
  characters: Number(process.env.PROMO_CHARACTER_COUNT || 100),
};

await Promise.all([
  mkdir(fancapsOutput, { recursive: true }),
  mkdir(coversOutput, { recursive: true }),
  mkdir(charactersOutput, { recursive: true }),
]);

console.log(`Reference project: ${referenceRoot}`);
let screenshots = await existingAssets(fancapsOutput);
if (screenshots.length < 90) {
  console.log("Selecting FanCaps screenshots...");
  const fancapsRecords = await readJsonLines(path.join(referencePublic, "fancaps_anime_images.jsonl"));
  const screenshotCandidates = selectFanCapsImages(fancapsRecords, counts.fancaps);
  screenshots = await downloadCandidates(screenshotCandidates, fancapsOutput, "shot", counts.fancaps, 6);
} else {
  console.log(`Reusing ${screenshots.length} local FanCaps screenshots.`);
}

let covers = await existingAssets(coversOutput);
let characters = await existingAssets(charactersOutput);
if (covers.length < counts.covers || characters.length < counts.characters) {
  console.log("Selecting Bangumi subjects...");
  const bangumiRecords = await readJsonLines(path.join(referencePublic, "bangumi_anime_subjects.jsonl"));
  const rankedSubjects = bangumiRecords
    .filter(record => record?.bgm_id && Number(record?.done_count) > 0)
    .sort((a, b) => Number(b.done_count) - Number(a.done_count))
    .slice(0, Math.max(counts.covers, counts.characters) + 90);

  const coverCandidates = [];
  const characterCandidates = [];
  for (let index = 0; index < rankedSubjects.length; index += 4) {
    if (coverCandidates.length >= counts.covers && characterCandidates.length >= counts.characters) break;
    const batch = rankedSubjects.slice(index, index + 4);
    const details = await Promise.all(batch.map(subject => fetchBangumiAssets(subject)));
    for (const detail of details) {
      if (!detail) continue;
      if (detail.coverUrl && coverCandidates.length < counts.covers) {
        coverCandidates.push({ url: detail.coverUrl, title: detail.title, bgmId: detail.bgmId });
      }
      if (detail.characterUrl && characterCandidates.length < counts.characters) {
        characterCandidates.push({
          url: detail.characterUrl,
          title: detail.title,
          bgmId: detail.bgmId,
          character: detail.character,
        });
      }
    }
    process.stdout.write(`\rBangumi metadata: covers ${coverCandidates.length}/${counts.covers}, characters ${characterCandidates.length}/${counts.characters}`);
  }
  process.stdout.write("\n");
  covers = await downloadCandidates(coverCandidates, coversOutput, "cover", counts.covers, 8);
  characters = await downloadCandidates(characterCandidates, charactersOutput, "character", counts.characters, 8);
} else {
  console.log(`Reusing ${covers.length} covers and ${characters.length} character images.`);
}

if (screenshots.length < 90 || covers.length < 70 || characters.length < 70) {
  throw new Error(
    `Not enough usable images: ${screenshots.length} screenshots, ${covers.length} covers, ${characters.length} characters`
  );
}

async function existingAssets(directory) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(avif|gif|jpe?g|png|webp)$/i.test(entry.name))
    .map(entry => entry.name)
    .sort();
  return files.map(fileName => ({
    src: `../assets/${path.basename(directory)}/${fileName}`,
    title: "",
  }));
}

const manifest = {
  generatedAt: new Date().toISOString(),
  sourceProject: path.basename(referenceRoot),
  screenshots,
  covers,
  characters,
};
await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Done: ${screenshots.length} screenshots, ${covers.length} covers, ${characters.length} character images.`);

async function readJsonLines(filePath) {
  await readFile(filePath, "utf8").catch(error => {
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  });
  const records = [];
  const reader = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Ignore malformed rows in the source export.
    }
  }
  return records;
}

function selectFanCapsImages(records, wanted) {
  const ranked = records
    .filter(record => record?.status === "ok" && Array.isArray(record.images) && record.images.length)
    .sort((a, b) => Number(b.done_count) - Number(a.done_count));
  const selected = [];
  const rounds = [0.1, 0.24, 0.4, 0.58, 0.74, 0.9];
  for (const ratio of rounds) {
    for (const record of ranked.slice(0, 260)) {
      if (selected.length >= wanted + 35) return selected;
      const images = record.images;
      const index = Math.min(images.length - 1, Math.max(0, Math.floor(images.length * ratio)));
      const url = images[index];
      if (!url || selected.some(item => item.url === url)) continue;
      selected.push({ url, title: record.label_text, bgmId: record.bgm_id });
    }
  }
  return selected;
}

async function fetchBangumiAssets(subject) {
  const bgmId = String(subject.bgm_id);
  try {
    const [detail, characters] = await Promise.all([
      fetchJson(`https://api.bgm.tv/v0/subjects/${encodeURIComponent(bgmId)}`),
      fetchJson(`https://api.bgm.tv/v0/subjects/${encodeURIComponent(bgmId)}/characters`),
    ]);
    const mainCharacters = (Array.isArray(characters) ? characters : [])
      .filter(character => character?.relation === "主角" && character?.images?.large)
      .sort((a, b) => Number(b?.comment) - Number(a?.comment));
    const character = mainCharacters[0];
    return {
      bgmId,
      title: subject.label_text,
      coverUrl: detail?.images?.large || detail?.images?.common || "",
      characterUrl: character?.images?.large || "",
      character: character?.name || "",
    };
  } catch (error) {
    console.warn(`\nSkipped Bangumi ${bgmId}: ${error.message}`);
    return null;
  }
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url, 3);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function downloadCandidates(candidates, directory, prefix, wanted, concurrency) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length && results.length < wanted) {
      const index = cursor++;
      const candidate = candidates[index];
      try {
        const downloadUrl = toDownloadUrl(candidate.url);
        const response = await fetchWithRetry(downloadUrl, 3, {
          Referer: candidate.url.includes("fancaps") ? "https://fancaps.net/" : "https://bgm.tv/",
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) throw new Error(`unexpected content type ${contentType}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength < 4_000) throw new Error("image is unexpectedly small");
        const fileName = `${prefix}-${String(index + 1).padStart(3, "0")}.jpg`;
        await writeFile(path.join(directory, fileName), bytes);
        results.push({
          src: `../assets/${path.basename(directory)}/${fileName}`,
          title: candidate.title,
          bgmId: candidate.bgmId,
          ...(candidate.character ? { character: candidate.character } : {}),
        });
        process.stdout.write(`\r${prefix}: ${results.length}/${wanted}`);
      } catch (error) {
        console.warn(`\nSkipped ${candidate.url}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  process.stdout.write("\n");
  return results.slice(0, wanted);
}

function toDownloadUrl(url) {
  if (!url.includes("cdni.fancaps.net/")) return url;
  const proxyUrl = new URL("https://wsrv.nl/");
  proxyUrl.searchParams.set("url", url);
  proxyUrl.searchParams.set("output", "jpg");
  proxyUrl.searchParams.set("w", "1280");
  proxyUrl.searchParams.set("q", "86");
  return proxyUrl.toString();
}

async function fetchWithRetry(url, attempts, extraHeaders = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...extraHeaders },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 500));
  }
  throw lastError || new Error("request failed");
}

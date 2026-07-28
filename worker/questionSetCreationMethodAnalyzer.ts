type CreationMethod = "player_manual" | "creation_tool_assisted";
type ClassificationBasis =
  | "r2_url_import_metadata"
  | "r2_local_upload_metadata"
  | "external_url"
  | "known_tool_url_with_initial_labels"
  | "legacy_managed_external_url"
  | "initial_labels"
  | "conflicting_r2_metadata"
  | "insufficient_evidence";

type Env = {
  DB: D1Database;
  IMAGE_BUCKET: R2Bucket;
  R2_IMAGE_PREFIX?: string;
};

type AnalysisRow = {
  question_set_id: string;
  title: string;
  created_at: string;
  image_count: number;
  question_id: string | null;
  image_url: string | null;
  order_index: number | null;
  label_text: string | null;
  label_source: string | null;
  label_updated_at: string | null;
};

type QuestionEvidence = Pick<AnalysisRow, "image_url" | "label_text" | "label_source" | "label_updated_at">;

export type CreationMethodAnalysisInput = {
  id: string;
  title: string;
  createdAt: string;
  imageCount: number;
  questions: QuestionEvidence[];
  r2Samples: Array<{ key: string; found: boolean; importSource: string | null }>;
};

const INITIAL_LABEL_WINDOW_MS = 5 * 60 * 1000;

function isInitialLabel(question: QuestionEvidence, createdAtMs: number) {
  if (!question.label_text?.trim() || question.label_source !== "manual" || !question.label_updated_at) return false;
  const labelUpdatedAtMs = Date.parse(question.label_updated_at);
  return Number.isFinite(labelUpdatedAtMs) && Number.isFinite(createdAtMs) &&
    Math.abs(labelUpdatedAtMs - createdAtMs) <= INITIAL_LABEL_WINDOW_MS;
}

function getR2Key(imageUrl: string | null, prefix: string) {
  if (!imageUrl) return null;
  try {
    const pathname = new URL(imageUrl).pathname;
    const marker = `/${prefix}/`;
    const markerIndex = pathname.indexOf(marker);
    if (markerIndex < 0) return null;
    return pathname
      .slice(markerIndex + 1)
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
  } catch {
    return null;
  }
}

function sampleKeys(keys: string[]) {
  if (keys.length <= 3) return keys;
  return Array.from(new Set([keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]]));
}

function getExternalUrlInfo(imageUrl: string | null, prefix: string) {
  if (!imageUrl || getR2Key(imageUrl, prefix)) return null;
  try {
    const url = new URL(imageUrl);
    return {
      host: url.hostname.toLowerCase(),
      isLegacyManagedUpload: url.hostname.toLowerCase() === "res.cloudinary.com" && url.pathname.includes("/anime-master-game/"),
      isKnownToolImage: url.hostname.toLowerCase() === "cdni.fancaps.net",
    };
  } catch {
    return { host: "invalid-url", isLegacyManagedUpload: false, isKnownToolImage: false };
  }
}

export function classifyQuestionSet(input: CreationMethodAnalysisInput, prefix = "question-images") {
  const r2Keys = input.questions.map((question) => getR2Key(question.image_url, prefix)).filter((key): key is string => Boolean(key));
  const externalUrls = input.questions.map((question) => getExternalUrlInfo(question.image_url, prefix)).filter((info): info is NonNullable<typeof info> => Boolean(info));
  const externalUrlCount = externalUrls.length;
  const externalHosts = Array.from(new Set(externalUrls.map((info) => info.host))).sort();
  const allExternalUrlsAreLegacyManagedUploads = externalUrls.length > 0 && externalUrls.every((info) => info.isLegacyManagedUpload);
  const hasKnownToolImageUrl = externalUrls.some((info) => info.isKnownToolImage);
  const foundSamples = input.r2Samples.filter((sample) => sample.found);
  const importedSamples = foundSamples.filter((sample) => sample.importSource === "url-text");
  const localSamples = foundSamples.filter((sample) => sample.importSource !== "url-text");
  const createdAtMs = Date.parse(input.createdAt);
  const initialLabelCount = input.questions.filter((question) => isInitialLabel(question, createdAtMs)).length;
  const initialLabelRatio = input.questions.length > 0 ? initialLabelCount / input.questions.length : 0;

  let creationMethod: CreationMethod | null = null;
  let basis: ClassificationBasis = "insufficient_evidence";
  let confidence: "high" | "medium" | "low" = "low";

  if (allExternalUrlsAreLegacyManagedUploads && initialLabelRatio < 0.9) {
    basis = "legacy_managed_external_url";
  } else if (hasKnownToolImageUrl && initialLabelRatio >= 0.9) {
    creationMethod = "creation_tool_assisted";
    basis = "known_tool_url_with_initial_labels";
    confidence = "high";
  } else if (externalUrlCount > 0) {
    creationMethod = "creation_tool_assisted";
    basis = allExternalUrlsAreLegacyManagedUploads ? "initial_labels" : "external_url";
    confidence = allExternalUrlsAreLegacyManagedUploads ? "medium" : "high";
  } else if (importedSamples.length > 0 && localSamples.length > 0) {
    basis = "conflicting_r2_metadata";
  } else if (importedSamples.length > 0) {
    creationMethod = "creation_tool_assisted";
    basis = "r2_url_import_metadata";
    confidence = "high";
  } else if (r2Keys.length > 0 && input.r2Samples.length > 0 && foundSamples.length === input.r2Samples.length) {
    creationMethod = "player_manual";
    basis = "r2_local_upload_metadata";
    confidence = "high";
  } else if (initialLabelCount > 0 && initialLabelRatio >= 0.9) {
    creationMethod = "creation_tool_assisted";
    basis = "initial_labels";
    confidence = "medium";
  }

  return {
    questionSetId: input.id,
    title: input.title,
    createdAt: input.createdAt,
    imageCount: input.imageCount,
    creationMethod,
    basis,
    confidence,
    evidence: {
      questionCount: input.questions.length,
      externalUrlCount,
      externalHosts,
      allExternalUrlsAreLegacyManagedUploads,
      r2KeyCount: r2Keys.length,
      r2SampleCount: input.r2Samples.length,
      r2FoundCount: foundSamples.length,
      r2UrlImportCount: importedSamples.length,
      r2LocalUploadCount: localSamples.length,
      initialLabelCount,
      initialLabelRatio: Number(initialLabelRatio.toFixed(3)),
    },
  };
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, mapper: (item: T) => Promise<U>) {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function analyze(env: Env) {
  const query = `
    SELECT qs.id AS question_set_id, qs.title, qs.created_at, qs.image_count,
           q.id AS question_id, q.image_url, q.order_index, q.label_text, q.label_source, q.label_updated_at
    FROM question_sets qs
    LEFT JOIN questions q ON q.question_set_id = qs.id
    WHERE qs.is_public = 1 AND qs.creation_method IS NULL
    ORDER BY qs.created_at ASC, qs.id ASC, q.order_index ASC
  `;
  const rows = (await env.DB.prepare(query).all<AnalysisRow>()).results ?? [];
  const grouped = new Map<string, CreationMethodAnalysisInput>();
  for (const row of rows) {
    const current = grouped.get(row.question_set_id) ?? {
      id: row.question_set_id,
      title: row.title,
      createdAt: row.created_at,
      imageCount: row.image_count,
      questions: [],
      r2Samples: [],
    };
    if (row.question_id) current.questions.push(row);
    grouped.set(row.question_set_id, current);
  }

  const prefix = env.R2_IMAGE_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || "question-images";
  const inputs = Array.from(grouped.values());
  await mapWithConcurrency(inputs, 8, async (input) => {
    const keys = sampleKeys(
      input.questions.map((question) => getR2Key(question.image_url, prefix)).filter((key): key is string => Boolean(key)),
    );
    input.r2Samples = await mapWithConcurrency(keys, 3, async (key) => {
      const object = await env.IMAGE_BUCKET.head(key);
      return {
        key,
        found: Boolean(object),
        importSource: object?.customMetadata?.importSource ?? null,
      };
    });
  });

  const items = inputs.map((input) => classifyQuestionSet(input, prefix));
  const summary = {
    total: items.length,
    playerManual: items.filter((item) => item.creationMethod === "player_manual").length,
    creationToolAssisted: items.filter((item) => item.creationMethod === "creation_tool_assisted").length,
    unresolved: items.filter((item) => item.creationMethod === null).length,
    highConfidence: items.filter((item) => item.confidence === "high").length,
    mediumConfidence: items.filter((item) => item.confidence === "medium").length,
    byBasis: Object.fromEntries(
      Array.from(new Set(items.map((item) => item.basis))).sort().map((basis) => [basis, items.filter((item) => item.basis === basis).length]),
    ),
  };
  return {
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    databaseChanged: false,
    scope: "public question sets where creation_method is null",
    summary,
    items,
  };
}

export default {
  async fetch(request: Request, env: Env) {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return Response.json({ ok: true, readOnly: true });
    if (pathname !== "/analyze") return new Response("Not found", { status: 404 });
    try {
      return Response.json(await analyze(env));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
};

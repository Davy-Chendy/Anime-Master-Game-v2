import * as gameService from "./gameService";

import type {
  Answer,
  BuzzerAnswer,
  FailedQuestionUrlImport,
  GameSession,
  PreparedQuestionUrlImport,
  Question,
  QuestionSet,
  QuestionSetUrlImportResult,
  QuestionUrlImportInput,
  RealtimeDelta,
  Room,
  RoundSnapshot,
} from "../src/types/game";

export interface Env {
  DB: D1Database;
  ROOM_OBJECTS: DurableObjectNamespace;
  IMAGE_BUCKET: R2Bucket;
  IMAGES?: ImagesBinding;
  ALLOWED_ORIGIN?: string;
  R2_IMAGE_PREFIX?: string;
  R2_PUBLIC_BASE_URL?: string;
  R2_EXISTING_IMAGE_LIMIT?: string;
  R2_IMAGE_STORAGE_LIMIT_BYTES?: string;
  REMOTE_IMAGE_PROXY_CANDIDATES?: string;
  REMOTE_IMPORT_STATE_SECRET?: string;
  REMOTE_UPLOAD_IMAGE_MAX_SIZE?: string;
  REMOTE_UPLOAD_IMAGE_QUALITY?: string;
  REMOTE_UPLOAD_IMAGE_FORMAT?: string;
}

type RpcBody = {
  name?: string;
  args?: unknown[];
  clientActionId?: string;
};

type BroadcastMessage = {
  type: "change";
  name: string;
  result: unknown;
  args: unknown[];
  topic: string;
  clientActionId?: string;
  delta?: RealtimeDelta;
  deltas?: RealtimeDelta[];
  roundSnapshot?: RoundSnapshot;
};

const ACTION_RESULT_TTL_MS = 10_000;
const ACTION_CACHE_MIN_ALARM_DELAY_MS = 100;
const IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const R2_IMAGE_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const R2_LIST_PAGE_LIMIT = 1000;
const R2_IMAGE_ROUTE_PREFIX = "/api/r2-images/";
const REMOTE_IMPORT_CONCURRENCY = 2;
const QUESTION_URL_IMPORT_MAX_COUNT = 120;
const REMOTE_UPLOAD_IMAGE_MAX_SIZE = 1600;
const REMOTE_UPLOAD_IMAGE_QUALITY = 78;
const REMOTE_UPLOAD_IMAGE_FORMAT = "image/webp";
const DEFAULT_REMOTE_IMAGE_PROXY_CANDIDATES = [
  "https://corsproxy.io/?url=",
  "https://api.allorigins.win/raw?url=",
  "https://api.codetabs.com/v1/proxy?quest=",
];

const MUTATION_NAMES = new Set([
  "createRoom",
  "joinRoom",
  "updatePlayerRole",
  "leaveRoom",
  "kickPlayerFromRoom",
  "dissolveRoom",
  "selectPresenterForRound",
  "cancelCurrentRound",
  "cancelPresenterSetup",
  "createUploadedQuestionSet",
  "createQuestionSetFromUrlText",
  "prepareQuestionSetForStart",
  "startGameWithQuestionSet",
  "confirmRevealBlocks",
  "submitAnswer",
  "submitForfeitAnswer",
  "autoForfeitExpiredRound",
  "cancelForfeitAnswer",
  "submitBuzzerAnswer",
  "judgeBuzzerAnswer",
  "settleBuzzerRound",
  "submitTeamBattleRevealVote",
  "submitTeamBattleGuessVote",
  "finalizeTeamBattleVote",
  "judgeTeamBattleGuess",
  "revealTeamBattleAnswer",
  "gradeAnswersAndAdvance",
  "advanceReviewedQuestion",
  "publishQuestionSetToCommunity",
  "rateCommunityQuestionSet",
  "updateQuestionLabel",
  "skipCurrentQuestion",
  "endCurrentGameEarly",
  "returnRoomToLobby",
]);

const COMPACT_SNAPSHOT_MUTATION_NAMES = new Set([
  "startGameWithQuestionSet",
  "kickPlayerFromRoom",
  "confirmRevealBlocks",
  "submitAnswer",
  "submitForfeitAnswer",
  "autoForfeitExpiredRound",
  "cancelForfeitAnswer",
  "judgeBuzzerAnswer",
  "settleBuzzerRound",
  "judgeTeamBattleGuess",
  "revealTeamBattleAnswer",
  "gradeAnswersAndAdvance",
  "advanceReviewedQuestion",
  "skipCurrentQuestion",
  "endCurrentGameEarly",
]);

function corsHeaders(request: Request, env: Env) {
  const origin = request.headers.get("origin") ?? "";
  const allowedOrigins = (env.ALLOWED_ORIGIN ?? "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowOrigin = allowedOrigins.includes("*") || allowedOrigins.includes(origin) ? origin || "*" : allowedOrigins[0] ?? "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data: unknown, init: ResponseInit = {}, request: Request, env: Env) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(request, env),
      ...init.headers,
    },
  });
}

function toUserErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";

  if (!message) {
      return "服务发生未知错误，请查看日志。";
  }

  if (/^[\x00-\x7F]+$/.test(message)) {
    if (/unique constraint/i.test(message)) {
      return "保存失败：数据已存在，请刷新后重试。";
    }
    if (/foreign key constraint/i.test(message)) {
      return "保存失败：关联数据不存在，请刷新后重试。";
    }
    if (/not null constraint/i.test(message)) {
      return "保存失败：缺少必填数据。";
    }
    if (/check constraint/i.test(message)) {
      return "保存失败：数据不符合规则。";
    }
    if (/no such table/i.test(message)) {
      return "数据库表不存在，请先执行数据库迁移。";
    }
    return "服务发生内部错误，请查看日志。";
  }

  return message;
}

function errorResponse(error: unknown, request: Request, env: Env) {
  const message = toUserErrorMessage(error);
  return json({ error: message }, { status: 400 }, request, env);
}

function getExportedFunction(name: string) {
  const fn = (gameService as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`未知游戏接口：${name}`);
  }
  return fn as (...args: unknown[]) => Promise<unknown>;
}

function getRoomObject(env: Env, topic: string) {
  return env.ROOM_OBJECTS.get(env.ROOM_OBJECTS.idFromName(topic));
}

function getR2UploadGateObject(env: Env) {
  return getRoomObject(env, "r2-image-upload-gate");
}

async function runWithGameDatabase<T>(env: Env, callback: () => Promise<T>) {
  return await gameService.runWithGameDatabase(env.DB, callback);
}

async function callGameFunction(name: string, args: unknown[]) {
  return await getExportedFunction(name)(...(args ?? []));
}

async function callGameFunctionWithEnv(name: string, args: unknown[], request: Request, env: Env) {
  if (name === "createQuestionSetFromUrlText") {
    return await createQuestionSetFromUrlTextWithRemoteImages(args[0], request, env);
  }

  return await callGameFunction(name, args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGameSessionRecord(value: Record<string, unknown>) {
  return typeof value.id === "string" && typeof value.roomId === "string" && "currentQuestionIndex" in value;
}

function getResultGameSessionId(result: unknown) {
  if (!isRecord(result)) {
    return null;
  }

  if (isGameSessionRecord(result)) {
    return result.id;
  }

  const gameSession = result.gameSession;
  if (isRecord(gameSession) && typeof gameSession.id === "string") {
    return gameSession.id;
  }

  if (typeof result.gameSessionId === "string") {
    return result.gameSessionId;
  }

  return null;
}

async function getRoundSnapshotForMutation(name: string, result: unknown) {
  if (!COMPACT_SNAPSHOT_MUTATION_NAMES.has(name)) {
    return null;
  }

  const gameSessionId = getResultGameSessionId(result);
  if (gameSessionId) {
    return await gameService.getRoundSnapshot(gameSessionId);
  }

  const room = getResultRoom(result);
  if (name === "kickPlayerFromRoom" && room?.status === "PLAYING" && room.currentGameId) {
    return await gameService.getRoundSnapshot(room.currentGameId);
  }

  return null;
}

function attachRoundSnapshot(result: unknown, roundSnapshot: RoundSnapshot | null) {
  if (!roundSnapshot || !isRecord(result)) {
    return result;
  }

  return {
    ...result,
    roundSnapshot,
  };
}

function stripRoundSnapshotFromBroadcastResult(result: unknown) {
  if (!isRecord(result) || !("roundSnapshot" in result)) {
    return result;
  }

  const { roundSnapshot: _roundSnapshot, ...broadcastResult } = result;
  return broadcastResult;
}

function asRoom(value: unknown): Room | null {
  return isRecord(value) && typeof value.code === "string" && typeof value.status === "string" ? (value as Room) : null;
}

function asGameSession(value: unknown): GameSession | null {
  return isRecord(value) && isGameSessionRecord(value) ? (value as GameSession) : null;
}

function asAnswer(value: unknown): Answer | null {
  return isRecord(value) && typeof value.id === "string" && typeof value.gameSessionId === "string" && "answerText" in value && "submittedAt" in value
    ? (value as Answer)
    : null;
}

function asBuzzerAnswer(value: unknown): BuzzerAnswer | null {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.gameSessionId === "string" &&
    "answerText" in value &&
    "submittedAt" in value &&
    typeof value.status === "string" &&
    "scoreAwarded" in value
    ? (value as BuzzerAnswer)
    : null;
}

function asQuestion(value: unknown): Question | null {
  return isRecord(value) && typeof value.id === "string" && typeof value.questionSetId === "string" && "orderIndex" in value
    ? (value as Question)
    : null;
}

function asQuestionSet(value: unknown): QuestionSet | null {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" && "imageCount" in value
    ? (value as QuestionSet)
    : null;
}

function getResultRoom(result: unknown) {
  if (isRecord(result)) {
    return asRoom(result.room) ?? asRoom(result);
  }
  return null;
}

function getResultGameSession(result: unknown) {
  if (isRecord(result)) {
    return asGameSession(result.gameSession) ?? asGameSession(result);
  }
  return null;
}

function getResultQuestionSet(result: unknown) {
  if (isRecord(result)) {
    return asQuestionSet(result.questionSet) ?? asQuestionSet(result);
  }
  return null;
}

function getArgRecord(args: unknown[]) {
  return isRecord(args[0]) ? args[0] : null;
}

function buildRealtimeDeltas(name: string, args: unknown[], result: unknown, roundSnapshot: RoundSnapshot | null): RealtimeDelta[] {
  const deltas: RealtimeDelta[] = [];
  const room = getResultRoom(result);
  const gameSession = getResultGameSession(result);
  const questionSet = getResultQuestionSet(result);
  const question = asQuestion(result);
  const buzzerAnswer = asBuzzerAnswer(result);
  const answer = buzzerAnswer ? null : asAnswer(result);
  const argRecord = getArgRecord(args);

  if (name === "dissolveRoom" && typeof args[0] === "string") {
    deltas.push({ scope: "room", type: "room_dissolved", roomId: args[0] });
  }

  if (room?.id) {
    deltas.push({ scope: "room", type: "room_updated", room });
  }

  if (questionSet) {
    deltas.push({
      scope: "question-set",
      type: "question_set_updated",
      questionSet,
      ratedPlayerId: typeof argRecord?.playerId === "string" ? argRecord.playerId : undefined,
      rating: typeof argRecord?.rating === "number" ? argRecord.rating : undefined,
    });
  }

  if (question) {
    deltas.push({ scope: "game", type: "question_label_updated", question });
  }

  if (name === "cancelForfeitAnswer" && isRecord(result) && gameSession && typeof result.canceledAnswerId === "string") {
    deltas.push({
      scope: "game",
      type: "answer_canceled",
      gameSession,
      canceledAnswerId: result.canceledAnswerId,
    });
  } else if (answer) {
    deltas.push({ scope: "game", type: "answer_submitted", answer });
  }

  const judgedBuzzerAnswer = isRecord(result) ? asBuzzerAnswer(result.judgedAnswer) : null;
  if (judgedBuzzerAnswer && gameSession) {
    deltas.push({ scope: "game", type: "buzzer_answer_judged", gameSession, buzzerAnswer: judgedBuzzerAnswer });
  } else if (buzzerAnswer) {
    deltas.push({ scope: "game", type: "buzzer_answer_submitted", buzzerAnswer });
  }

  if (roundSnapshot) {
    deltas.push({ scope: "game", type: "round_snapshot", snapshot: roundSnapshot });
  } else if (gameSession && name !== "cancelForfeitAnswer") {
    deltas.push({ scope: "game", type: "game_session_updated", gameSession });
  }

  return deltas;
}

async function getRoomTopicForBroadcast(name: string, args: unknown[], result: unknown) {
  const resultRoom = getResultRoom(result);
  if (resultRoom?.id) {
    return `room:${resultRoom.id}`;
  }

  const resultGameSession = getResultGameSession(result);
  if (resultGameSession?.roomId) {
    return `room:${resultGameSession.roomId}`;
  }

  const first = args[0];
  if (typeof first === "string" && (name.includes("Room") || name.includes("Presenter") || name.includes("Round"))) {
    return `room:${first}`;
  }

  if (isRecord(first)) {
    if (typeof first.roomId === "string" && first.roomId.trim()) {
      return `room:${first.roomId}`;
    }

    if (typeof first.gameSessionId === "string" && first.gameSessionId.trim()) {
      const gameSession = await gameService.getGameSessionById(first.gameSessionId);
      return gameSession?.roomId ? `room:${gameSession.roomId}` : null;
    }
  }

  return null;
}

async function broadcast(env: Env, message: BroadcastMessage) {
  await getRoomObject(env, message.topic).fetch("https://room-object/broadcast", {
    method: "POST",
    body: JSON.stringify(message),
  });
}

async function handleRpc(request: Request, env: Env) {
  const body = (await request.json()) as RpcBody;
  const name = body.name ?? "";
  const args = body.args ?? [];

  return await runWithGameDatabase(env, async () => {
    const result = await callGameFunctionWithEnv(name, args, request, env);
    const roundSnapshot = await getRoundSnapshotForMutation(name, result);
    const responseResult = attachRoundSnapshot(result, roundSnapshot);

    if (MUTATION_NAMES.has(name)) {
      const topic = await getRoomTopicForBroadcast(name, args, responseResult);
      const deltas = buildRealtimeDeltas(name, args, responseResult, roundSnapshot);
      if (topic && deltas.length > 0) {
        await broadcast(env, {
          type: "change",
          name,
          result: stripRoundSnapshotFromBroadcastResult(responseResult),
          args,
          topic,
          clientActionId: body.clientActionId,
          delta: deltas[0],
          deltas,
        });
      }
    }

    return json({ data: responseResult }, {}, request, env);
  });
}

function getR2ImagePrefix(env: Env) {
  return (env.R2_IMAGE_PREFIX ?? "question-images")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.\./g, "");
}

function getR2ImageStorageLimitBytes(env: Env) {
  const configuredLimit = Number(env.R2_IMAGE_STORAGE_LIMIT_BYTES);
  return Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : R2_IMAGE_STORAGE_LIMIT_BYTES;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${bytes} B`;
}

async function getR2StoredImageBytes(env: Env) {
  const prefix = getR2ImagePrefix(env);
  const listPrefix = prefix ? `${prefix}/` : undefined;
  let cursor: string | undefined;
  let totalBytes = 0;

  do {
    const listed = await env.IMAGE_BUCKET.list({
      prefix: listPrefix,
      limit: R2_LIST_PAGE_LIMIT,
      cursor,
    });

    totalBytes += listed.objects.reduce((sum, object) => sum + object.size, 0);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return totalBytes;
}

function r2StorageLimitResponse(request: Request, env: Env, currentBytes: number, uploadBytes: number, limitBytes: number) {
  return json(
    {
      error: `图片存储空间不足：当前已使用 ${formatBytes(currentBytes)}，本次上传 ${formatBytes(uploadBytes)}，上限 ${formatBytes(
        limitBytes,
      )}。请先清理图片后再上传。`,
      currentBytes,
      uploadBytes,
      limitBytes,
    },
    { status: 507 },
    request,
    env,
  );
}

function sanitizeFileName(name: string) {
  const fallback = "image";
  const withoutPath = name.split(/[\\/]/).filter(Boolean).pop() ?? fallback;
  const dotIndex = withoutPath.lastIndexOf(".");
  const rawBase = dotIndex > 0 ? withoutPath.slice(0, dotIndex) : withoutPath;
  const rawExt = dotIndex > 0 ? withoutPath.slice(dotIndex).toLowerCase() : "";
  const base = rawBase
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const ext = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : "";
  return `${base || fallback}${ext}`;
}

function encodeR2Key(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function getR2PublicUrl(request: Request, env: Env, key: string) {
  const configuredBase = env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/g, "");
  if (configuredBase) {
    return `${configuredBase}/${encodeR2Key(key)}`;
  }

  const origin = new URL(request.url).origin;
  return `${origin}${R2_IMAGE_ROUTE_PREFIX}${encodeR2Key(key)}`;
}

function buildR2ImageKey(request: Request, env: Env, fileNameOverride?: string) {
  const url = new URL(request.url);
  const fileName = sanitizeFileName(fileNameOverride ?? url.searchParams.get("filename") ?? "image");
  const now = new Date();
  const datePath = now.toISOString().slice(0, 10).replace(/-/g, "/");
  const prefix = getR2ImagePrefix(env);
  const id = crypto.randomUUID();
  return `${prefix}/${datePath}/${id}-${fileName}`;
}

function getRequestContentLength(request: Request) {
  const value = request.headers.get("content-length");
  if (!value) {
    return null;
  }

  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

async function putR2Image(
  request: Request,
  env: Env,
  body: ArrayBuffer,
  contentType: string,
  fileName: string,
  customMetadata: Record<string, string> = {},
) {
  const storageLimitBytes = getR2ImageStorageLimitBytes(env);
  const currentStorageBytes = await getR2StoredImageBytes(env);
  if (currentStorageBytes + body.byteLength > storageLimitBytes) {
    return {
      ok: false as const,
      response: r2StorageLimitResponse(request, env, currentStorageBytes, body.byteLength, storageLimitBytes),
    };
  }

  const key = buildR2ImageKey(request, env, fileName);
  const checksum = await crypto.subtle.digest("SHA-256", body);
  const object = await env.IMAGE_BUCKET.put(key, body, {
    httpMetadata: {
      contentType,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      uploadedAt: new Date().toISOString(),
      ...customMetadata,
    },
    sha256: checksum,
  });

  if (!object) {
    throw new Error("图片写入 R2 失败，请稍后重试。");
  }

  const storageBytesAfterUpload = await getR2StoredImageBytes(env);
  if (storageBytesAfterUpload > storageLimitBytes) {
    await env.IMAGE_BUCKET.delete(key);
    return {
      ok: false as const,
      response: r2StorageLimitResponse(request, env, Math.max(0, storageBytesAfterUpload - object.size), object.size, storageLimitBytes),
    };
  }

  return {
    ok: true as const,
    key,
    url: getR2PublicUrl(request, env, key),
    publicId: key,
    size: object.size,
    etag: object.httpEtag,
    storageBytes: storageBytesAfterUpload,
    storageLimitBytes,
  };
}

type CreateQuestionSetFromUrlTextParams = {
  roomId?: string;
  presenterPlayerId?: string;
  title?: string;
  description?: string;
  imageUrlsText?: string;
  retryQuestions?: unknown;
  preparedQuestions?: unknown;
  fallbackToOriginalUrls?: boolean;
};

type RemoteFetchResult = {
  body: ArrayBuffer;
  contentType: string;
};

function asCreateQuestionSetFromUrlTextParams(value: unknown): CreateQuestionSetFromUrlTextParams {
  if (!isRecord(value)) {
    throw new Error("创建题库参数无效。");
  }
  return value as CreateQuestionSetFromUrlTextParams;
}

function normalizeImportInput(value: unknown, fallbackOrderIndex: number): QuestionUrlImportInput | null {
  if (!isRecord(value) || typeof value.imageUrl !== "string") {
    return null;
  }

  const imageUrl = value.imageUrl.trim();
  if (!isHttpImageUrl(imageUrl)) {
    return null;
  }

  const orderIndex = typeof value.orderIndex === "number" && Number.isInteger(value.orderIndex) && value.orderIndex >= 0 ? value.orderIndex : fallbackOrderIndex;
  return {
    imageUrl,
    labelText: typeof value.labelText === "string" ? value.labelText.trim() || null : null,
    orderIndex,
  };
}

function normalizePreparedQuestion(value: unknown, fallbackOrderIndex: number): PreparedQuestionUrlImport | null {
  const input = normalizeImportInput(value, fallbackOrderIndex);
  if (!input || !isRecord(value)) {
    return null;
  }

  const originalImageUrl = typeof value.originalImageUrl === "string" && value.originalImageUrl.trim() ? value.originalImageUrl.trim() : input.imageUrl;
  return {
    ...input,
    originalImageUrl,
    r2Key: typeof value.r2Key === "string" ? value.r2Key : null,
    importToken: typeof value.importToken === "string" ? value.importToken : undefined,
    rawBytes: typeof value.rawBytes === "number" ? value.rawBytes : null,
    uploadBytes: typeof value.uploadBytes === "number" ? value.uploadBytes : null,
    usedOriginal: Boolean(value.usedOriginal),
  };
}

function parseRetryQuestions(params: CreateQuestionSetFromUrlTextParams) {
  if (Array.isArray(params.retryQuestions)) {
    return params.retryQuestions
      .map((item, index) => normalizeImportInput(item, index))
      .filter((item): item is QuestionUrlImportInput => Boolean(item));
  }

  return gameService.parseQuestionImportText(params.imageUrlsText ?? "").map((item, index) => ({
    imageUrl: item.imageUrl,
    labelText: item.labelText ?? null,
    orderIndex: index,
  }));
}

async function parsePreparedQuestions(params: CreateQuestionSetFromUrlTextParams, env: Env) {
  if (!Array.isArray(params.preparedQuestions)) {
    return [];
  }

  const preparedQuestions = params.preparedQuestions
    .map((item, index) => normalizePreparedQuestion(item, index))
    .filter((item): item is PreparedQuestionUrlImport => Boolean(item));

  for (const item of preparedQuestions) {
    if (!(await verifyPreparedQuestionToken(params, item, env))) {
      throw new Error("远端图片导入状态已失效，请重新导入题单。");
    }
  }

  return preparedQuestions;
}

function isHttpImageUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getRemoteUploadMaxSize(env: Env) {
  const value = Number(env.REMOTE_UPLOAD_IMAGE_MAX_SIZE);
  return Number.isFinite(value) && value >= 100 ? value : REMOTE_UPLOAD_IMAGE_MAX_SIZE;
}

function getRemoteUploadQuality(env: Env) {
  const value = Number(env.REMOTE_UPLOAD_IMAGE_QUALITY);
  if (Number.isFinite(value) && value > 0) {
    return value <= 1 ? Math.round(value * 100) : Math.min(100, Math.round(value));
  }
  return REMOTE_UPLOAD_IMAGE_QUALITY;
}

function getRemoteUploadFormat(env: Env) {
  const value = (env.REMOTE_UPLOAD_IMAGE_FORMAT ?? REMOTE_UPLOAD_IMAGE_FORMAT).trim().toLowerCase();
  return ["image/webp", "image/jpeg", "image/png", "image/avif"].includes(value) ? (value as ImageOutputOptions["format"]) : REMOTE_UPLOAD_IMAGE_FORMAT;
}

function bytesToHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function getImportStateHmacKey(env: Env) {
  const secret = env.REMOTE_IMPORT_STATE_SECRET?.trim();
  if (!secret) {
    throw new Error("缺少 REMOTE_IMPORT_STATE_SECRET：请用 wrangler secret put 配置远端导入状态签名密钥。");
  }

  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function getPreparedQuestionTokenPayload(params: CreateQuestionSetFromUrlTextParams, item: PreparedQuestionUrlImport) {
  return JSON.stringify({
    roomId: params.roomId ?? "",
    presenterPlayerId: params.presenterPlayerId ?? "",
    orderIndex: item.orderIndex,
    imageUrl: item.imageUrl,
    originalImageUrl: item.originalImageUrl,
    labelText: item.labelText ?? null,
    r2Key: item.r2Key ?? null,
  });
}

async function signPreparedQuestion(params: CreateQuestionSetFromUrlTextParams, item: PreparedQuestionUrlImport, env: Env) {
  const key = await getImportStateHmacKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(getPreparedQuestionTokenPayload(params, item)));
  return {
    ...item,
    importToken: bytesToHex(signature),
  };
}

async function verifyPreparedQuestionToken(params: CreateQuestionSetFromUrlTextParams, item: PreparedQuestionUrlImport, env: Env) {
  if (!item.importToken) {
    return false;
  }

  const key = await getImportStateHmacKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(getPreparedQuestionTokenPayload(params, item)));
  return bytesToHex(signature) === item.importToken;
}

async function signPreparedQuestions(params: CreateQuestionSetFromUrlTextParams, items: PreparedQuestionUrlImport[], env: Env) {
  const signedItems: PreparedQuestionUrlImport[] = [];
  for (const item of items) {
    signedItems.push(await signPreparedQuestion(params, item, env));
  }
  return signedItems;
}

function getRemoteProxyCandidates(env: Env) {
  const configured = (env.REMOTE_IMAGE_PROXY_CANDIDATES ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set([...configured, ...DEFAULT_REMOTE_IMAGE_PROXY_CANDIDATES]));
}

function isBlockedRemoteHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0") {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }

  return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

function getSourceFetchHeaders(url: URL) {
  const headers = new Headers({
    "User-Agent": "Mozilla/5.0 (compatible; AnimeMasterGame/1.0)",
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
  });

  if (url.hostname === "cdni.fancaps.net" || url.hostname === "fancaps.net") {
    headers.set("Referer", "https://fancaps.net/");
  } else if (url.hostname === "lain.bgm.tv") {
    headers.set("Referer", "https://bgm.tv/");
  }

  return headers;
}

function fileNameFromRemoteUrl(rawUrl: string, contentType: string, fallbackFormat: string) {
  const url = new URL(rawUrl);
  const pathName = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "image");
  const ext = pathName.match(/\.[a-z0-9]{1,8}$/i)?.[0];
  if (ext) {
    return pathName;
  }

  if (contentType === "image/webp" || fallbackFormat === "image/webp") return `${pathName}.webp`;
  if (contentType === "image/png" || fallbackFormat === "image/png") return `${pathName}.png`;
  if (contentType === "image/avif" || fallbackFormat === "image/avif") return `${pathName}.avif`;
  if (contentType === "image/gif") return `${pathName}.gif`;
  return `${pathName}.jpg`;
}

function replaceFileExtension(fileName: string, contentType: string) {
  const ext =
    contentType === "image/webp"
      ? ".webp"
      : contentType === "image/png"
        ? ".png"
        : contentType === "image/avif"
          ? ".avif"
          : contentType === "image/gif"
            ? ".gif"
            : ".jpg";
  return fileName.replace(/\.[^.]+$/, "") + ext;
}

async function fetchRemoteImage(rawUrl: string, env: Env): Promise<RemoteFetchResult> {
  const targetUrl = new URL(rawUrl);
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    throw new Error("只支持 http/https 图片链接。");
  }
  if (isBlockedRemoteHost(targetUrl.hostname)) {
    throw new Error("不允许导入本地或私有网络图片。");
  }

  const attempts = [
    { url: targetUrl.toString(), headers: getSourceFetchHeaders(targetUrl) },
    ...getRemoteProxyCandidates(env).map((prefix) => ({
      url: `${prefix}${encodeURIComponent(targetUrl.toString())}`,
      headers: new Headers({ Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" }),
    })),
  ];
  let lastError = "远端图片请求失败。";

  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, { method: "GET", headers: attempt.headers });
      if (!response.ok) {
        lastError = `远端返回 HTTP ${response.status}`;
        continue;
      }

      const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!contentType.startsWith("image/")) {
        lastError = "远端返回的不是图片。";
        continue;
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > IMAGE_UPLOAD_MAX_BYTES) {
        throw new Error("单张图片不能超过 20 MB。");
      }

      const body = await readResponseBodyWithLimit(response, IMAGE_UPLOAD_MAX_BYTES);
      if (body.byteLength === 0) {
        lastError = "远端图片内容为空。";
        continue;
      }

      return { body, contentType };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastError);
}

async function readResponseBodyWithLimit(response: Response, maxBytes: number) {
  if (!response.body) {
    throw new Error("远端图片响应为空。");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("单张图片不能超过 20 MB。");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body.buffer;
}

async function compressRemoteImage(rawImage: RemoteFetchResult, env: Env) {
  if (rawImage.contentType === "image/gif") {
    return {
      body: rawImage.body,
      contentType: rawImage.contentType,
      usedOriginal: true,
    };
  }

  if (!env.IMAGES) {
    throw new Error("缺少 Cloudflare Images binding：请在 wrangler.toml 配置 IMAGES 后再导入远端图片。");
  }

  const targetFormat = getRemoteUploadFormat(env);
  const result = await env.IMAGES.input(new Response(rawImage.body).body!).transform({
    width: getRemoteUploadMaxSize(env),
    height: getRemoteUploadMaxSize(env),
    fit: "scale-down",
  }).output({
    format: targetFormat,
    quality: getRemoteUploadQuality(env),
    anim: true,
  });

  const transformed = await new Response(result.image()).arrayBuffer();
  const contentType = result.contentType();
  if (transformed.byteLength > 0 && transformed.byteLength < rawImage.body.byteLength) {
    return {
      body: transformed,
      contentType,
      usedOriginal: false,
    };
  }

  return {
    body: rawImage.body,
    contentType: rawImage.contentType,
    usedOriginal: true,
  };
}

async function importRemoteQuestionImage(input: QuestionUrlImportInput, request: Request, env: Env): Promise<PreparedQuestionUrlImport | FailedQuestionUrlImport> {
  try {
    const rawImage = await fetchRemoteImage(input.imageUrl, env);
    const compressed = await compressRemoteImage(rawImage, env);
    const uploadName = replaceFileExtension(fileNameFromRemoteUrl(input.imageUrl, rawImage.contentType, compressed.contentType), compressed.contentType);
    const uploaded = await putR2Image(request, env, compressed.body, compressed.contentType, uploadName, {
      originalUrl: input.imageUrl,
      importSource: "url-text",
    });
    if (!uploaded.ok) {
      throw new Error("图片存储空间不足。");
    }

    return {
      imageUrl: uploaded.url,
      originalImageUrl: input.imageUrl,
      labelText: input.labelText ?? null,
      orderIndex: input.orderIndex,
      r2Key: uploaded.key,
      rawBytes: rawImage.body.byteLength,
      uploadBytes: compressed.body.byteLength,
      usedOriginal: compressed.usedOriginal,
    };
  } catch (error) {
    return {
      imageUrl: input.imageUrl,
      labelText: input.labelText ?? null,
      orderIndex: input.orderIndex,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runRemoteImportPool(inputs: QuestionUrlImportInput[], request: Request, env: Env) {
  const results: Array<PreparedQuestionUrlImport | FailedQuestionUrlImport> = [];
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(REMOTE_IMPORT_CONCURRENCY, inputs.length)) }, async () => {
    while (index < inputs.length) {
      const current = index;
      index += 1;
      results[current] = await importRemoteQuestionImage(inputs[current], request, env);
    }
  });

  await Promise.all(workers);
  return results;
}

function sortPreparedQuestions(items: PreparedQuestionUrlImport[]) {
  return items.slice().sort((a, b) => a.orderIndex - b.orderIndex);
}

async function createQuestionSetFromPreparedUrlImport(
  params: CreateQuestionSetFromUrlTextParams,
  preparedQuestions: PreparedQuestionUrlImport[],
  fallbackCount: number,
): Promise<QuestionSetUrlImportResult> {
  const questionSet = await gameService.createUploadedQuestionSet({
    roomId: params.roomId ?? "",
    presenterPlayerId: params.presenterPlayerId ?? "",
    title: params.title ?? "",
    description: params.description,
    questions: sortPreparedQuestions(preparedQuestions).map((item) => ({
      imageUrl: item.imageUrl,
      labelText: item.labelText ?? null,
    })),
  });

  return {
    status: "created",
    questionSet,
    importedCount: Math.max(0, preparedQuestions.length - fallbackCount),
    fallbackCount,
  };
}

async function createQuestionSetFromUrlTextWithRemoteImages(value: unknown, request: Request, env: Env): Promise<QuestionSetUrlImportResult> {
  if (!env.IMAGE_BUCKET) {
    throw new Error("缺少 R2 存储绑定：请在 wrangler.toml 配置 IMAGE_BUCKET。");
  }

  const params = asCreateQuestionSetFromUrlTextParams(value);
  const preparedQuestions = await parsePreparedQuestions(params, env);
  const retryQuestions = parseRetryQuestions(params);

  if (!params.roomId || !params.presenterPlayerId) {
    throw new Error("创建题库参数缺少房间或出题人。");
  }

  if (preparedQuestions.length + retryQuestions.length === 0) {
    throw new Error("没有检测到有效图片链接。请使用 http/https 图片链接，或每行一个包含 image_url 的 JSON 对象。");
  }

  if (preparedQuestions.length + retryQuestions.length > QUESTION_URL_IMPORT_MAX_COUNT) {
    throw new Error(`一次最多导入 ${QUESTION_URL_IMPORT_MAX_COUNT} 张图片。`);
  }

  await gameService.assertCanCreateUploadedQuestionSet({
    roomId: params.roomId,
    presenterPlayerId: params.presenterPlayerId,
  });

  if (params.fallbackToOriginalUrls) {
    const fallbackQuestions = retryQuestions.map((item) => ({
      ...item,
      originalImageUrl: item.imageUrl,
      usedOriginal: true,
    }));
    return createQuestionSetFromPreparedUrlImport(params, [...preparedQuestions, ...fallbackQuestions], fallbackQuestions.length);
  }

  const imported = await runRemoteImportPool(retryQuestions, request, env);
  const nextPrepared = [
    ...preparedQuestions,
    ...imported.filter((item): item is PreparedQuestionUrlImport => "originalImageUrl" in item),
  ];
  const failedQuestions = imported.filter((item): item is FailedQuestionUrlImport => "error" in item);

  if (failedQuestions.length > 0) {
    return {
      status: "needs_decision",
      preparedQuestions: await signPreparedQuestions(params, sortPreparedQuestions(nextPrepared), env),
      failedQuestions: failedQuestions.slice().sort((a, b) => a.orderIndex - b.orderIndex),
      totalCount: nextPrepared.length + failedQuestions.length,
    };
  }

  return createQuestionSetFromPreparedUrlImport(params, nextPrepared, 0);
}

async function handleR2Upload(request: Request, env: Env) {
  if (!env.IMAGE_BUCKET) {
    return json({ error: "缺少 R2 存储绑定：请在 wrangler.toml 配置 IMAGE_BUCKET。" }, { status: 500 }, request, env);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return json({ error: "只能上传图片文件。" }, { status: 415 }, request, env);
  }

  const contentLength = getRequestContentLength(request);
  if (contentLength != null && contentLength > IMAGE_UPLOAD_MAX_BYTES) {
    return json({ error: "单张图片不能超过 20 MB。" }, { status: 413 }, request, env);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) {
    return json({ error: "上传内容为空。" }, { status: 400 }, request, env);
  }

  if (body.byteLength > IMAGE_UPLOAD_MAX_BYTES) {
    return json({ error: "单张图片不能超过 20 MB。" }, { status: 413 }, request, env);
  }

  const uploaded = await putR2Image(request, env, body, contentType, new URL(request.url).searchParams.get("filename") ?? "image");
  if (!uploaded.ok) {
    return uploaded.response;
  }

  return json(
    {
      key: uploaded.key,
      url: uploaded.url,
      publicId: uploaded.publicId,
      size: uploaded.size,
      etag: uploaded.etag,
      storageBytes: uploaded.storageBytes,
      storageLimitBytes: uploaded.storageLimitBytes,
    },
    {},
    request,
    env,
  );
}

function getR2ObjectKeyFromPath(pathname: string) {
  if (!pathname.startsWith(R2_IMAGE_ROUTE_PREFIX)) {
    return null;
  }

  const encodedKey = pathname.slice(R2_IMAGE_ROUTE_PREFIX.length);
  if (!encodedKey) {
    return null;
  }

  const key = encodedKey
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");

  if (!key || key.includes("..") || key.startsWith("/")) {
    return null;
  }

  return key;
}

async function handleR2Image(request: Request, env: Env, key: string) {
  if (!env.IMAGE_BUCKET) {
    return json({ error: "缺少 R2 存储绑定。" }, { status: 500 }, request, env);
  }

  const object = request.method === "HEAD" ? await env.IMAGE_BUCKET.head(key) : await env.IMAGE_BUCKET.get(key);
  if (!object) {
    return new Response("Not found", { status: 404, headers: corsHeaders(request, env) });
  }

  const headers = new Headers(corsHeaders(request, env));
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }

  if (request.method === "HEAD") {
    headers.set("content-length", String(object.size));
    return new Response(null, { headers });
  }

  return new Response(object.body, { headers });
}

async function handleR2ImagesList(request: Request, env: Env) {
  if (!env.IMAGE_BUCKET) {
    return json({ error: "缺少 R2 存储绑定。" }, { status: 500 }, request, env);
  }

  const prefix = getR2ImagePrefix(env);
  const limit = Math.max(1, Math.min(100, Number(env.R2_EXISTING_IMAGE_LIMIT ?? 50)));
  const listed = await env.IMAGE_BUCKET.list({
    prefix: prefix ? `${prefix}/` : undefined,
    limit,
    include: ["httpMetadata"],
  });

  const images = listed.objects
    .slice()
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
    .map((object) => ({
      publicId: object.key,
      url: getR2PublicUrl(request, env, object.key),
      originalUrl: getR2PublicUrl(request, env, object.key),
      width: null,
      height: null,
      createdAt: object.uploaded.toISOString(),
      size: object.size,
    }));

  return json(
    {
      images,
      folder: prefix,
      limit,
      truncated: listed.truncated,
      cursor: listed.cursor ?? null,
      storageBytes: await getR2StoredImageBytes(env),
      storageLimitBytes: getR2ImageStorageLimitBytes(env),
    },
    {},
    request,
    env,
  );
}

export class RoomDurableObject {
  private readonly recentActions = new Map<string, { expiresAt: number; result: unknown }>();
  private actionQueue: Promise<void> = Promise.resolve();
  private r2UploadQueue: Promise<void> = Promise.resolve();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/r2-upload" && request.method === "POST") {
      return await this.enqueueR2Upload(request);
    }

    if (url.pathname === "/api/rpc" && request.method === "POST") {
      return await this.enqueueR2BoundRpc(request);
    }

    if (request.headers.get("upgrade") === "websocket") {
      const topic = url.searchParams.get("topic") ?? "";
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ topic });
      server.send(JSON.stringify({ type: "connected", topic }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const message = await request.text();
      this.broadcast(message);
      return new Response(null, { status: 204 });
    }

    return new Response("未找到对应的实时接口。", { status: 404 });
  }

  private enqueueR2Upload(request: Request) {
    const task = this.r2UploadQueue.then(
      () => this.handleQueuedR2Upload(request),
      () => this.handleQueuedR2Upload(request),
    );
    this.r2UploadQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async handleQueuedR2Upload(request: Request) {
    try {
      return await handleR2Upload(request, this.env);
    } catch (error) {
      return errorResponse(error, request, this.env);
    }
  }

  private enqueueR2BoundRpc(request: Request) {
    const task = this.r2UploadQueue.then(
      () => this.handleQueuedR2BoundRpc(request),
      () => this.handleQueuedR2BoundRpc(request),
    );
    this.r2UploadQueue = task.then(
      () => undefined,
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async handleQueuedR2BoundRpc(request: Request) {
    try {
      return await handleRpc(request, this.env);
    } catch (error) {
      return errorResponse(error, request, this.env);
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const task = this.actionQueue.then(
      () => this.handleWebSocketAction(socket, message),
      () => this.handleWebSocketAction(socket, message),
    );
    this.actionQueue = task.catch(() => undefined);
    await task;
  }

  private async handleWebSocketAction(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let clientActionId: string | undefined;
    try {
      const payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as {
        type?: string;
        name?: string;
        args?: unknown[];
        clientActionId?: string;
      };
      clientActionId = payload.clientActionId;

      if (payload.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (payload.type !== "action" || !payload.name) {
        socket.send(JSON.stringify({ type: "error", error: "无效的实时操作请求。" }));
        return;
      }

      const actionKey = payload.clientActionId ? `${payload.name}:${payload.clientActionId}` : "";
      const cached = actionKey ? this.recentActions.get(actionKey) : null;
      if (cached && cached.expiresAt > Date.now()) {
        socket.send(JSON.stringify({ type: "action_result", clientActionId: payload.clientActionId, data: cached.result }));
        return;
      }

      const { deltas, roundSnapshot, responseResult, topic } = await runWithGameDatabase(this.env, async () => {
        const result = await callGameFunction(payload.name ?? "", payload.args ?? []);
        const nextRoundSnapshot = await getRoundSnapshotForMutation(payload.name ?? "", result);
        const nextResponseResult = attachRoundSnapshot(result, nextRoundSnapshot);
        const nextTopic = MUTATION_NAMES.has(payload.name ?? "")
          ? await getRoomTopicForBroadcast(payload.name ?? "", payload.args ?? [], nextResponseResult)
          : null;
        const nextDeltas =
          MUTATION_NAMES.has(payload.name ?? "") && nextTopic
            ? buildRealtimeDeltas(payload.name ?? "", payload.args ?? [], nextResponseResult, nextRoundSnapshot)
            : [];

        return {
          deltas: nextDeltas,
          roundSnapshot: nextRoundSnapshot,
          responseResult: nextResponseResult,
          topic: nextTopic,
        };
      });
      if (actionKey) {
        this.recentActions.set(actionKey, { expiresAt: Date.now() + ACTION_RESULT_TTL_MS, result: responseResult });
        await this.scheduleActionCacheCleanup();
      }

      if (MUTATION_NAMES.has(payload.name)) {
        if (topic && deltas.length > 0) {
          const changeMessage = {
            type: "change",
            name: payload.name,
            result: stripRoundSnapshotFromBroadcastResult(responseResult),
            args: payload.args ?? [],
            topic,
            clientActionId: payload.clientActionId,
            delta: deltas[0],
            deltas,
          } satisfies BroadcastMessage;
          const attachment = socket.deserializeAttachment() as { topic?: string } | undefined;

          if (attachment?.topic === topic) {
            this.broadcast(JSON.stringify(changeMessage));
          } else {
            await broadcast(this.env, changeMessage);
          }
        }
      }

      socket.send(JSON.stringify({ type: "action_result", clientActionId: payload.clientActionId, data: responseResult }));
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: "action_result",
          clientActionId,
          error: toUserErrorMessage(error),
        }),
      );
    }
  }

  async alarm(): Promise<void> {
    await this.scheduleActionCacheCleanup();
  }

  private cleanupRecentActions(now = Date.now()) {
    let nextExpiresAt: number | null = null;

    for (const [key, entry] of this.recentActions.entries()) {
      if (entry.expiresAt <= now) {
        this.recentActions.delete(key);
      } else {
        nextExpiresAt = nextExpiresAt == null ? entry.expiresAt : Math.min(nextExpiresAt, entry.expiresAt);
      }
    }

    return nextExpiresAt;
  }

  private async scheduleActionCacheCleanup() {
    const nextExpiresAt = this.cleanupRecentActions();

    if (nextExpiresAt == null) {
      await this.state.storage.deleteAlarm();
      return;
    }

    await this.state.storage.setAlarm(Math.max(nextExpiresAt, Date.now() + ACTION_CACHE_MIN_ALARM_DELAY_MS));
  }

  private broadcast(message: string) {
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "广播失败。");
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (url.pathname === "/api/rpc" && request.method === "POST") {
        const body = (await request.clone().json().catch(() => null)) as RpcBody | null;
        if (body?.name === "createQuestionSetFromUrlText") {
          return await getR2UploadGateObject(env).fetch(request);
        }

        return await handleRpc(request, env);
      }

      if (url.pathname === "/api/r2-upload" && request.method === "POST") {
        return await getR2UploadGateObject(env).fetch(request);
      }

      if (url.pathname === "/api/r2-images" && request.method === "GET") {
        return await handleR2ImagesList(request, env);
      }

      const r2ImageKey = getR2ObjectKeyFromPath(url.pathname);
      if (r2ImageKey && (request.method === "GET" || request.method === "HEAD")) {
        return await handleR2Image(request, env, r2ImageKey);
      }

      const realtimeMatch = url.pathname.match(/^\/api\/realtime\/(.+)\/ws$/);
      if (realtimeMatch && request.headers.get("upgrade") === "websocket") {
        const topic = decodeURIComponent(realtimeMatch[1]);
        return getRoomObject(env, topic).fetch(new Request(`https://room-object/ws?topic=${encodeURIComponent(topic)}`, request));
      }

      return json({ error: "未找到对应的服务接口。" }, { status: 404 }, request, env);
    } catch (error) {
      return errorResponse(error, request, env);
    }
  },
};

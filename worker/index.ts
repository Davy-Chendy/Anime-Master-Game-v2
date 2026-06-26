import * as gameService from "./gameService";

import type { Answer, BuzzerAnswer, GameSession, Question, QuestionSet, RealtimeDelta, Room, RoundSnapshot } from "../src/types/game";

export interface Env {
  DB: D1Database;
  ROOM_OBJECTS: DurableObjectNamespace;
  IMAGE_BUCKET: R2Bucket;
  ALLOWED_ORIGIN?: string;
  R2_IMAGE_PREFIX?: string;
  R2_PUBLIC_BASE_URL?: string;
  R2_EXISTING_IMAGE_LIMIT?: string;
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
const R2_IMAGE_ROUTE_PREFIX = "/api/r2-images/";

const MUTATION_NAMES = new Set([
  "createRoom",
  "joinRoom",
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

async function runWithGameDatabase<T>(env: Env, callback: () => Promise<T>) {
  return await gameService.runWithGameDatabase(env.DB, callback);
}

async function callGameFunction(name: string, args: unknown[]) {
  return await getExportedFunction(name)(...(args ?? []));
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
  if (!gameSessionId) {
    return null;
  }

  return await gameService.getRoundSnapshot(gameSessionId);
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
    const result = await callGameFunction(name, args);
    const roundSnapshot = await getRoundSnapshotForMutation(name, result);
    const responseResult = attachRoundSnapshot(result, roundSnapshot);

    if (MUTATION_NAMES.has(name)) {
      const topic = await getRoomTopicForBroadcast(name, args, responseResult);
      if (topic) {
        const deltas = buildRealtimeDeltas(name, args, responseResult, roundSnapshot);
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

function buildR2ImageKey(request: Request, env: Env) {
  const url = new URL(request.url);
  const fileName = sanitizeFileName(url.searchParams.get("filename") ?? "image");
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

  const key = buildR2ImageKey(request, env);
  const checksum = await crypto.subtle.digest("SHA-256", body);
  const object = await env.IMAGE_BUCKET.put(key, body, {
    httpMetadata: {
      contentType,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      uploadedAt: new Date().toISOString(),
    },
    sha256: checksum,
  });

  if (!object) {
    return json({ error: "图片写入 R2 失败，请稍后重试。" }, { status: 500 }, request, env);
  }

  return json(
    {
      key,
      url: getR2PublicUrl(request, env, key),
      publicId: key,
      size: object.size,
      etag: object.httpEtag,
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

  return json({ images, folder: prefix, limit, truncated: listed.truncated, cursor: listed.cursor ?? null }, {}, request, env);
}

export class RoomDurableObject {
  private readonly recentActions = new Map<string, { expiresAt: number; result: unknown }>();
  private actionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "connected", topic: url.searchParams.get("topic") ?? "" }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const message = await request.text();
      this.broadcast(message);
      return new Response(null, { status: 204 });
    }

    return new Response("未找到对应的实时接口。", { status: 404 });
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

      const { roundSnapshot, responseResult } = await runWithGameDatabase(this.env, async () => {
        const result = await callGameFunction(payload.name ?? "", payload.args ?? []);
        const nextRoundSnapshot = await getRoundSnapshotForMutation(payload.name ?? "", result);
        const nextResponseResult = attachRoundSnapshot(result, nextRoundSnapshot);

        return {
          roundSnapshot: nextRoundSnapshot,
          responseResult: nextResponseResult,
        };
      });
      if (actionKey) {
        this.recentActions.set(actionKey, { expiresAt: Date.now() + ACTION_RESULT_TTL_MS, result: responseResult });
        await this.scheduleActionCacheCleanup();
      }

      if (MUTATION_NAMES.has(payload.name)) {
        const deltas = buildRealtimeDeltas(payload.name, payload.args ?? [], responseResult, roundSnapshot);
        this.broadcast(
          JSON.stringify({
            type: "change",
            name: payload.name,
            result: stripRoundSnapshotFromBroadcastResult(responseResult),
            args: payload.args ?? [],
            topic: "",
            clientActionId: payload.clientActionId,
            delta: deltas[0],
            deltas,
          } satisfies BroadcastMessage),
        );
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
        return await handleRpc(request, env);
      }

      if (url.pathname === "/api/r2-upload" && request.method === "POST") {
        return await handleR2Upload(request, env);
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

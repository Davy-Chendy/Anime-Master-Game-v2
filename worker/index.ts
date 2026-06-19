import * as gameService from "./gameService";

import type { Answer, BuzzerAnswer, GameSession, Question, QuestionSet, RealtimeDelta, Room, RoundSnapshot } from "../src/types/game";

export interface Env {
  DB: D1Database;
  ROOM_OBJECTS: DurableObjectNamespace;
  ALLOWED_ORIGIN?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  CLOUDINARY_FOLDER?: string;
  NEXT_PUBLIC_CLOUDINARY_FOLDER?: string;
  CLOUDINARY_EXISTING_IMAGE_LIMIT?: string;
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

type CloudinaryResource = {
  public_id: string;
  secure_url: string;
  width?: number;
  height?: number;
  created_at?: string;
};

const ACTION_RESULT_TTL_MS = 10_000;
const ACTION_CACHE_MIN_ALARM_DELAY_MS = 100;

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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

async function handleCloudinaryImages(request: Request, env: Env) {
  const cloudName = env.CLOUDINARY_CLOUD_NAME ?? env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;
  const folder = env.CLOUDINARY_FOLDER ?? env.NEXT_PUBLIC_CLOUDINARY_FOLDER ?? "";
  const limit = Math.max(1, Math.min(100, Number(env.CLOUDINARY_EXISTING_IMAGE_LIMIT ?? 50)));

  if (!cloudName || !apiKey || !apiSecret) {
    return json(
      {
        error: "缺少图片服务配置：请设置云名称、接口密钥和接口密钥密码。",
      },
      { status: 500 },
      request,
      env,
    );
  }

  const url = new URL(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/resources/image/upload`);
  url.searchParams.set("max_results", String(limit));

  if (folder) {
    url.searchParams.set("prefix", folder.endsWith("/") ? folder : `${folder}/`);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${btoa(`${apiKey}:${apiSecret}`)}`,
    },
  });

  const data = (await response.json().catch(() => ({}))) as {
    resources?: CloudinaryResource[];
    error?: { message?: string };
  };

  if (!response.ok) {
    return json({ error: `图片服务请求失败，请检查配置和网络。状态码 ${response.status}。` }, { status: response.status }, request, env);
  }

  const images = (data.resources ?? []).map((resource) => ({
    publicId: resource.public_id,
    url: resource.secure_url,
    originalUrl: resource.secure_url,
    width: resource.width ?? null,
    height: resource.height ?? null,
    createdAt: resource.created_at ?? null,
  }));

  return json({ images, folder, limit }, {}, request, env);
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

      if (url.pathname === "/api/cloudinary-images" && request.method === "GET") {
        return await handleCloudinaryImages(request, env);
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

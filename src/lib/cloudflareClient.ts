"use client";

import type { GameResultSnapshot, RoundSnapshot } from "@/types/game";
import type { RealtimeDelta } from "@/types/game";
import { commitAuthorityOutbox, discardSupersededAuthorityOutbox, enqueueAuthorityMutation, listAuthorityOutbox, syncAuthoritySequence, type AuthorityOutboxItem } from "@/lib/authorityOutbox";

type ChangeMessage = {
  type: "change";
  name: string;
  result?: unknown;
  args?: unknown[];
  topic: string;
  version?: number;
  clientActionId?: string;
  delta?: RealtimeDelta;
  deltas?: RealtimeDelta[];
  roundSnapshot?: RoundSnapshot;
  gameResultSnapshot?: GameResultSnapshot;
  authorityVersion?: 1 | 2;
  gameId?: string;
  committedSeqByActor?: Record<string, number>;
};

type ActionResultMessage = {
  type: "action_result";
  clientActionId?: string;
  data?: unknown;
  error?: string;
};

type ActionAcceptedMessage = { type: "action_accepted"; clientActionId?: string };
type ActionReceivedMessage = { type: "action_received"; clientActionId?: string; actionId?: string };
type CheckpointCommittedMessage = { type: "checkpoint_committed"; gameId?: string; committedSeqByActor?: Record<string, number> };
type AuthoritySequenceHint = { gameId: string; actorId: string; committedSeq: number };

type TopicState = {
  socket: WebSocket | null;
  listeners: Set<(message: ChangeMessage) => void>;
  connectListeners: Set<() => void>;
  pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number; actionId?: string }>;
  reconnectTimer: number | null;
  reconnectAttempts: number;
  playerId?: string;
  drainPromise: Promise<void> | null;
  drainSocket: WebSocket | null;
  drainRequested: boolean;
  sentOutboxActionIds: Set<string>;
  authorityVersion: 1 | 2 | null;
  currentGameId: string | null;
  sequenceSync: Promise<void>;
  readyPromise: Promise<void>;
  resolveReady?: () => void;
};

class WsActionError extends Error {
  constructor(
    public readonly kind: "server" | "transport",
    message: string,
  ) {
    super(message);
    this.name = "WsActionError";
  }
}

const ACTION_TIMEOUT_MS = 4000;
const LONG_ACTION_TIMEOUT_MS = 30000;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5000;
const ROOM_TOPIC_PREFIX = "room:";
const POSITIONAL_ROOM_MUTATION_NAMES = new Set(["leaveRoom", "updatePlayerRole", "kickPlayerFromRoom", "dissolveRoom", "cancelCurrentRound", "returnRoomToLobby"]);

const MUTATION_NAMES = new Set([
  "leaveRoom",
  "updatePlayerRole",
  "kickPlayerFromRoom",
  "dissolveRoom",
  "selectPresenterForRound",
  "cancelCurrentRound",
  "cancelPresenterSetup",
  "createUploadedQuestionSet",
  "createQuestionSetFromUrlText",
  "prepareQuestionSetForStart",
  "updateRoomGameSettings",
  "startGameWithQuestionSet",
  "confirmRevealBlocks",
  "submitAnswer",
  "submitForfeitAnswer",
  "autoForfeitExpiredRound",
  "cancelForfeitAnswer",
  "submitBuzzerAnswer",
  "judgeBuzzerAnswer",
  "setAnswerJudgements",
  "markPendingRoundAnswersWrong",
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

const LONG_ACTION_NAMES = new Set(["createUploadedQuestionSet", "createQuestionSetFromUrlText"]);
const HTTP_ONLY_ACTION_NAMES = new Set(["createQuestionSetFromUrlText"]);
const WS_QUERY_NAMES = new Set([
  "getAnswerForPlayerRound",
  "getAnswersForQuestion",
  "getAnswersForQuestionRound",
  "getBuzzerAnswerForPlayerRound",
  "getBuzzerAnswersForQuestion",
  "getBuzzerAnswersForQuestionRound",
  "getGameBootstrapSnapshot",
  "getGameResultSnapshot",
  "getGameSessionById",
  "getLeaderboardForGameSession",
  "getPlayerScores",
  "getPlayersByRoomId",
  "getQuestionResultsForGameSession",
  "getQuestionResultsForQuestion",
  "getRoundSnapshot",
]);
const ROOM_ID_STRING_ARG_NAMES = new Set(["getPlayersByRoomId"]);
const GAME_SESSION_ID_STRING_ARG_NAMES = new Set([
  "getGameBootstrapSnapshot",
  "getGameResultSnapshot",
  "getGameSessionById",
  "getLeaderboardForGameSession",
  "getPlayerScores",
  "getQuestionResultsForGameSession",
  "getRoundSnapshot",
]);
const topicStates = new Map<string, TopicState>();
const gameSessionTopics = new Map<string, string>();
const gameSessionQuestionIndexes = new Map<string, number>();
const provisionalActionIds = new Set<string>();
let recoveryListenersInstalled = false;

function apiBase() {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
}

function apiUrl(path: string) {
  return `${apiBase()}${path}`;
}

function wsUrl(path: string) {
  const base = apiBase();
  const url = new URL(path, base || window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inferActionTopic(name: string, args: unknown[]) {
  const first = args[0];

  if (
    typeof first === "string" &&
    (name.includes("Room") || name.includes("Presenter") || name.includes("Round") || ROOM_ID_STRING_ARG_NAMES.has(name) || POSITIONAL_ROOM_MUTATION_NAMES.has(name))
  ) {
    const roomTopic = `${ROOM_TOPIC_PREFIX}${first}`;
    if (topicStates.has(roomTopic)) {
      return roomTopic;
    }
  }

  if (typeof first === "string" && GAME_SESSION_ID_STRING_ARG_NAMES.has(name)) {
    const roomTopic = gameSessionTopics.get(first);
    if (roomTopic && topicStates.has(roomTopic)) {
      return roomTopic;
    }
  }

  if (isRecord(first)) {
    if (typeof first.roomId === "string" && first.roomId.trim()) {
      const roomTopic = `${ROOM_TOPIC_PREFIX}${first.roomId}`;
      if (topicStates.has(roomTopic)) {
        return roomTopic;
      }
    }

    if (typeof first.gameSessionId === "string" && first.gameSessionId.trim()) {
      const roomTopic = gameSessionTopics.get(first.gameSessionId);
      if (roomTopic && topicStates.has(roomTopic)) {
        return roomTopic;
      }
    }
  }

  return null;
}

function getActionTimeoutMs(name: string) {
  return LONG_ACTION_NAMES.has(name) ? LONG_ACTION_TIMEOUT_MS : ACTION_TIMEOUT_MS;
}

function getTopicState(topic: string) {
  let state = topicStates.get(topic);
  if (!state) {
    state = {
      socket: null,
      listeners: new Set(),
      connectListeners: new Set(),
      pending: new Map(),
      reconnectTimer: null,
      reconnectAttempts: 0,
      drainPromise: null,
      drainSocket: null,
      drainRequested: false,
      sentOutboxActionIds: new Set(),
      authorityVersion: null,
      currentGameId: null,
      sequenceSync: Promise.resolve(),
      readyPromise: Promise.resolve(),
    };
    topicStates.set(topic, state);
  }
  return state;
}

function getReconnectDelayMs(state: TopicState) {
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, state.reconnectAttempts - 1));
}

function cleanupTopicStateIfIdle(topic: string, state: TopicState) {
  if (state.listeners.size > 0 || state.pending.size > 0 || state.connectListeners.size > 0) {
    return;
  }

  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.socket?.close(1000, "No listeners.");
  state.socket = null;
  topicStates.delete(topic);

  for (const [gameSessionId, mappedTopic] of gameSessionTopics.entries()) {
    if (mappedTopic === topic) {
      gameSessionTopics.delete(gameSessionId);
    }
  }
}

function notifyConnectListeners(state: TopicState) {
  for (const listener of Array.from(state.connectListeners)) {
    try {
      listener();
    } catch (error) {
      console.error("Realtime connect listener failed.", error);
    }
  }
}

function notifyChangeListeners(state: TopicState, message: ChangeMessage) {
  for (const listener of Array.from(state.listeners)) {
    try {
      listener(message);
    } catch (error) {
      console.error("Realtime change listener failed.", error);
    }
  }
}

function setTopicPlayerId(topic: string, playerId: string | null | undefined) {
  if (!playerId) return;
  const state = getTopicState(topic);
  if (state.playerId === playerId) return;
  const previous = state.playerId;
  state.playerId = playerId;
  if (state.socket && previous !== playerId && (state.socket.readyState === WebSocket.CONNECTING || state.socket.readyState === WebSocket.OPEN)) {
    state.socket.close(1000, "Reconnect with player identity.");
    state.socket = null;
  }
}

function getPositionalRoomMutation(name: string, args: unknown[]) {
  switch (name) {
    case "leaveRoom": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], playerId: args[1] } } : null;
    case "updatePlayerRole": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], actorPlayerId: args[1], targetPlayerId: args[2], role: args[3] } } : null;
    case "kickPlayerFromRoom": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], hostPlayerId: args[1], targetPlayerId: args[2] } } : null;
    case "dissolveRoom": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], hostPlayerId: args[1] } } : null;
    case "cancelCurrentRound": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], hostPlayerId: args[1] } } : null;
    case "returnRoomToLobby": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], hostPlayerId: args[1] } } : null;
    default: return null;
  }
}

function mutationMessage(item: AuthorityOutboxItem) {
  return JSON.stringify({
    type: "action",
    name: item.name,
    args: item.args,
    clientActionId: item.actionId,
    mutation: {
      actionId: item.actionId,
      actorId: item.actorId,
      clientSeq: item.clientSeq,
      gameId: item.gameId,
      questionIndex: item.questionIndex,
      name: item.name,
      payload: item.payload,
    },
  });
}

function drainAuthorityOutbox(topic: string, state: TopicState, socket: WebSocket) {
  state.drainRequested = true;
  if (state.drainPromise && state.drainSocket === socket) return state.drainPromise;
  const drain = (async () => {
    try {
      while (state.drainRequested && state.socket === socket && socket.readyState === WebSocket.OPEN) {
        state.drainRequested = false;
        for (const item of await listAuthorityOutbox(topic)) {
          if (state.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
          if (state.sentOutboxActionIds.has(item.actionId)) continue;
          socket.send(mutationMessage(item));
          state.sentOutboxActionIds.add(item.actionId);
        }
      }
    } catch (error) {
      console.error("Realtime Outbox drain failed.", error);
    }
  })();
  let wrapped: Promise<void>;
  wrapped = drain.finally(() => {
    if (state.drainPromise !== wrapped) return;
    state.drainPromise = null;
    state.drainSocket = null;
    if (state.drainRequested && state.socket === socket && socket.readyState === WebSocket.OPEN) void drainAuthorityOutbox(topic, state, socket);
  });
  state.drainPromise = wrapped;
  state.drainSocket = socket;
  return wrapped;
}

function installRecoveryListeners() {
  if (recoveryListenersInstalled || typeof window === "undefined") return;
  recoveryListenersInstalled = true;
  const recover = () => {
    for (const [topic, state] of topicStates) {
      if (state.listeners.size === 0 && state.pending.size === 0) continue;
      const socket = ensureSocket(topic);
      if (socket.readyState === WebSocket.OPEN) void state.readyPromise.then(() => drainAuthorityOutbox(topic, state, socket));
    }
  };
  window.addEventListener("online", recover);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") recover(); });
}

function scheduleReconnect(topic: string, state: TopicState) {
  if (state.listeners.size === 0 || state.reconnectTimer !== null) {
    return;
  }

  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    if (state.listeners.size > 0) {
      ensureSocket(topic);
    }
  }, getReconnectDelayMs(state));
}

function ensureSocket(topic: string) {
  const state = getTopicState(topic);

  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
    return state.socket;
  }

  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  installRecoveryListeners();
  state.readyPromise = new Promise<void>((resolve) => { state.resolveReady = resolve; });
  const playerQuery = state.playerId ? `?playerId=${encodeURIComponent(state.playerId)}` : "";
  const socket = new WebSocket(wsUrl(`/api/realtime/${encodeURIComponent(topic)}/ws${playerQuery}`));
  state.socket = socket;
  state.sentOutboxActionIds.clear();

  socket.onopen = () => {
    if (state.socket !== socket) {
      return;
    }

    state.reconnectAttempts = 0;
  };

  socket.onmessage = (event) => {
    let message: ChangeMessage | ActionResultMessage | ActionAcceptedMessage | ActionReceivedMessage | CheckpointCommittedMessage | { type?: string; authorityVersion?: 1 | 2; gameId?: string; committedSeqByActor?: Record<string, number> };

    try {
      message = JSON.parse(String(event.data)) as ChangeMessage | ActionResultMessage | { type?: string };
    } catch (error) {
      console.error("Realtime message parse failed.", error);
      return;
    }

    if (message.type === "connected") {
      state.authorityVersion = message.authorityVersion ?? null;
      state.currentGameId = message.gameId ?? null;
      const syncTasks: Promise<void>[] = [];
      if (message.gameId) syncTasks.push(discardSupersededAuthorityOutbox(topic, message.gameId));
      if (message.gameId && state.playerId && message.committedSeqByActor) syncTasks.push(syncAuthoritySequence(message.gameId, state.playerId, message.committedSeqByActor[state.playerId] ?? 0));
      state.sequenceSync = Promise.all(syncTasks).then(() => undefined).catch((error) => { console.error("Realtime sequence sync failed.", error); });
      void state.sequenceSync
        .then(() => drainAuthorityOutbox(topic, state, socket))
        .finally(() => {
          if (state.socket !== socket) return;
          state.resolveReady?.();
          state.resolveReady = undefined;
          notifyConnectListeners(state);
        });
      return;
    }

    if (message.type === "action_received") {
      const received = message as ActionReceivedMessage;
      if (received.actionId) provisionalActionIds.add(received.actionId);
      return;
    }

    if (message.type === "checkpoint_committed") {
      const committed = message as CheckpointCommittedMessage;
      if (committed.committedSeqByActor) {
        state.sequenceSync = state.sequenceSync
          .then(() => commitAuthorityOutbox(topic, committed.gameId, committed.committedSeqByActor ?? {}, state.playerId ? [state.playerId] : []))
          .catch((error) => { console.error("Realtime durable sequence sync failed.", error); });
      }
      return;
    }

    if (message.type === "action_result") {
      const result = message as ActionResultMessage;
      const pending = result.clientActionId ? state.pending.get(result.clientActionId) : null;
      if (!pending && result.clientActionId) provisionalActionIds.delete(result.clientActionId);
      if (pending) {
        window.clearTimeout(pending.timer);
        state.pending.delete(result.clientActionId ?? "");
        if (pending.actionId) provisionalActionIds.delete(pending.actionId);
        cleanupTopicStateIfIdle(topic, state);
        if (result.error) {
          pending.reject(new WsActionError("server", result.error));
        } else {
          pending.resolve(result.data);
        }
      }
      return;
    }

    if (message.type === "action_accepted") {
      const accepted = message as ActionAcceptedMessage;
      const pending = accepted.clientActionId ? state.pending.get(accepted.clientActionId) : null;
      if (pending) {
        window.clearTimeout(pending.timer);
        pending.timer = window.setTimeout(() => {
          state.pending.delete(accepted.clientActionId ?? "");
          cleanupTopicStateIfIdle(topic, state);
          pending.reject(new WsActionError("transport", "操作已被服务器接收，但处理时间异常。请刷新状态确认结果。"));
        }, LONG_ACTION_TIMEOUT_MS);
      }
      return;
    }

    if (message.type === "change") {
      const change = message as ChangeMessage;
      if (change.authorityVersion === 2) state.authorityVersion = 2;
      if (change.name === "authorityCutover" && change.gameId) {
        state.currentGameId = change.gameId;
        const tasks: Promise<void>[] = [discardSupersededAuthorityOutbox(topic, change.gameId)];
        if (state.playerId) tasks.push(syncAuthoritySequence(change.gameId, state.playerId, change.committedSeqByActor?.[state.playerId] ?? 0));
        state.sequenceSync = Promise.all(tasks).then(() => undefined).catch((error) => { console.error("Realtime cutover sequence sync failed.", error); });
      }
      notifyChangeListeners(state, change);
    }
  };

  socket.onclose = () => {
    if (state.socket !== socket) {
      return;
    }

    state.resolveReady?.();
    state.resolveReady = undefined;

    for (const pending of state.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new WsActionError("transport", "实时连接已断开，本次操作没有完成。请重试。"));
    }
    state.pending.clear();
    state.socket = null;
    state.reconnectAttempts += 1;
    cleanupTopicStateIfIdle(topic, state);
    scheduleReconnect(topic, state);
  };

  return socket;
}

function waitForSocketOpen(topic: string, socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve(socket);
  }

  if (socket.readyState !== WebSocket.CONNECTING) {
    return Promise.reject(new WsActionError("transport", "实时连接不可用，请稍后重试。"));
  }

  return new Promise<WebSocket>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("close", handleClose);
      reject(new WsActionError("transport", "实时连接未就绪，请稍后重试。"));
    }, ACTION_TIMEOUT_MS);

    function handleOpen() {
      window.clearTimeout(timer);
      socket.removeEventListener("close", handleClose);
      resolve(socket);
    }

    function handleClose() {
      window.clearTimeout(timer);
      socket.removeEventListener("open", handleOpen);
      reject(new WsActionError("transport", "实时连接已断开，请重试。"));
    }

    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("close", handleClose, { once: true });
    ensureSocket(topic);
  });
}

async function httpRpc<T>(name: string, args: unknown[]) {
  const response = await fetch(apiUrl("/api/rpc"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const payload = (await response.json()) as { data?: T; error?: string; authoritySequence?: AuthoritySequenceHint };
  const hint = payload.authoritySequence;
  if (hint && hint.gameId && hint.actorId && Number.isInteger(hint.committedSeq) && hint.committedSeq >= 0) {
    await syncAuthoritySequence(hint.gameId, hint.actorId, hint.committedSeq);
  }
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "请求游戏服务失败，请稍后重试。");
  }
  return payload.data as T;
}

async function wsAction<T>(topic: string, name: string, args: unknown[]) {
  const state = getTopicState(topic);
  const timeoutMs = getActionTimeoutMs(name);
  const socket = await waitForSocketOpen(topic, ensureSocket(topic));
  await state.readyPromise;
  await state.sequenceSync;
  const first = isRecord(args[0]) ? args[0] : null;
  const positional = getPositionalRoomMutation(name, args);
  const boundGameId = [...gameSessionTopics].find(([, boundTopic]) => boundTopic === topic)?.[0] ?? null;
  const gameId = typeof first?.gameSessionId === "string" ? first.gameSessionId : POSITIONAL_ROOM_MUTATION_NAMES.has(name) ? boundGameId : null;
  const actorId = positional?.actorId ?? (typeof first?.playerId === "string" ? first.playerId
    : typeof first?.presenterPlayerId === "string" ? first.presenterPlayerId
      : typeof first?.hostPlayerId === "string" ? first.hostPlayerId : null);
  const mutationPayload = first ?? positional?.payload ?? null;
  if (state.authorityVersion === 2 && gameId && state.currentGameId && gameId !== state.currentGameId) {
    throw new WsActionError("server", "该操作属于已结束的游戏，请刷新后重试。");
  }
  const outboxItem = state.authorityVersion !== 1 && MUTATION_NAMES.has(name) && gameId && actorId
    && mutationPayload ? await enqueueAuthorityMutation({ topic, actorId, gameId, questionIndex: gameSessionQuestionIndexes.get(gameId) ?? 0, name, payload: mutationPayload, args })
    : null;
  const clientActionId = outboxItem?.actionId ?? crypto.randomUUID();
  const promise = new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      state.pending.delete(clientActionId);
      cleanupTopicStateIfIdle(topic, state);
      reject(new WsActionError("transport", "实时操作响应超时，请检查网络后重试。"));
    }, timeoutMs);

    state.pending.set(clientActionId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
      actionId: outboxItem?.actionId,
    });
  });

  try {
    if (outboxItem) {
      await drainAuthorityOutbox(topic, state, socket);
    } else {
      socket.send(JSON.stringify({ type: "action", name, args, clientActionId }));
    }
  } catch {
    const pending = state.pending.get(clientActionId);
    if (pending) {
      window.clearTimeout(pending.timer);
      state.pending.delete(clientActionId);
      cleanupTopicStateIfIdle(topic, state);
    }
    throw new WsActionError("transport", "实时操作发送失败，请检查网络后重试。");
  }

  return promise;
}

export async function callGameRpc<T>(name: string, args: unknown[] = []) {
  if ((MUTATION_NAMES.has(name) || WS_QUERY_NAMES.has(name)) && !HTTP_ONLY_ACTION_NAMES.has(name)) {
    const topic = inferActionTopic(name, args);
    if (topic) {
      try {
        return await wsAction<T>(topic, name, args);
      } catch (error) {
        if (MUTATION_NAMES.has(name) || !(error instanceof WsActionError) || error.kind === "server") {
          throw error;
        }
      }
    }
  }

  return httpRpc<T>(name, args);
}

export function subscribeRealtimeTopic(
  topic: string,
  listener: (message: ChangeMessage) => void,
  options: { onOpen?: () => void; playerId?: string } = {},
) {
  const state = getTopicState(topic);
  setTopicPlayerId(topic, options.playerId);
  const onOpen = options.onOpen;
  state.listeners.add(listener);
  if (onOpen) {
    state.connectListeners.add(onOpen);
  }
  ensureSocket(topic);
  if (onOpen && state.socket?.readyState === WebSocket.OPEN) {
    void state.readyPromise.then(() => {
      if (state.connectListeners.has(onOpen)) {
        onOpen();
      }
    });
  }

  return () => {
    state.listeners.delete(listener);
    if (onOpen) {
      state.connectListeners.delete(onOpen);
    }
    cleanupTopicStateIfIdle(topic, state);
  };
}

export function bindGameSessionRealtimeTopic(gameSessionId: string | null | undefined, topic: string | null | undefined, questionIndex = 0) {
  if (!gameSessionId || !topic) {
    return () => undefined;
  }

  gameSessionTopics.set(gameSessionId, topic);
  gameSessionQuestionIndexes.set(gameSessionId, questionIndex);

  return () => {
    if (gameSessionTopics.get(gameSessionId) === topic) {
      gameSessionTopics.delete(gameSessionId);
      gameSessionQuestionIndexes.delete(gameSessionId);
    }
  };
}

export function updateGameSessionRealtimeQuestion(gameSessionId: string, questionIndex: number) {
  gameSessionQuestionIndexes.set(gameSessionId, questionIndex);
}

export function ensureRealtimeTopic(topic: string | null | undefined, playerId?: string) {
  if (!topic) {
    return;
  }

  setTopicPlayerId(topic, playerId);
  ensureSocket(topic);
}

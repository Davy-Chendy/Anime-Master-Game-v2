"use client";

import type { RoundSnapshot } from "@/types/game";
import type { RealtimeDelta } from "@/types/game";

type ChangeMessage = {
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

type ActionResultMessage = {
  type: "action_result";
  clientActionId?: string;
  data?: unknown;
  error?: string;
};

type TopicState = {
  socket: WebSocket | null;
  listeners: Set<(message: ChangeMessage) => void>;
  connectListeners: Set<() => void>;
  pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }>;
  reconnectTimer: number | null;
  heartbeatTimer: number | null;
  reconnectAttempts: number;
  lastPongAt: number;
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
const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 70000;
const ROOM_TOPIC_PREFIX = "room:";

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
  "getGameSessionById",
  "getLeaderboardForGameSession",
  "getPlayerScores",
  "getQuestionResultsForGameSession",
  "getRoundSnapshot",
]);
const topicStates = new Map<string, TopicState>();
const gameSessionTopics = new Map<string, string>();

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
    (name.includes("Room") || name.includes("Presenter") || name.includes("Round") || ROOM_ID_STRING_ARG_NAMES.has(name))
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
      heartbeatTimer: null,
      reconnectAttempts: 0,
      lastPongAt: Date.now(),
    };
    topicStates.set(topic, state);
  }
  return state;
}

function getReconnectDelayMs(state: TopicState) {
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, state.reconnectAttempts - 1));
}

function clearHeartbeat(state: TopicState) {
  if (state.heartbeatTimer !== null) {
    window.clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

function cleanupTopicStateIfIdle(topic: string, state: TopicState) {
  if (state.listeners.size > 0 || state.pending.size > 0 || state.connectListeners.size > 0) {
    return;
  }

  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  clearHeartbeat(state);
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

function startHeartbeat(topic: string, state: TopicState, socket: WebSocket) {
  clearHeartbeat(state);
  state.lastPongAt = Date.now();
  state.heartbeatTimer = window.setInterval(() => {
    if (state.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      clearHeartbeat(state);
      return;
    }

    if (Date.now() - state.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
      socket.close(4000, "Heartbeat timeout.");
      return;
    }

    try {
      socket.send(JSON.stringify({ type: "ping", topic }));
    } catch {
      socket.close(1011, "Heartbeat send failed.");
    }
  }, HEARTBEAT_INTERVAL_MS);
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

  const socket = new WebSocket(wsUrl(`/api/realtime/${encodeURIComponent(topic)}/ws`));
  state.socket = socket;

  socket.onopen = () => {
    if (state.socket !== socket) {
      return;
    }

    state.reconnectAttempts = 0;
    startHeartbeat(topic, state, socket);
    notifyConnectListeners(state);
  };

  socket.onmessage = (event) => {
    let message: ChangeMessage | ActionResultMessage | { type?: string };

    try {
      message = JSON.parse(String(event.data)) as ChangeMessage | ActionResultMessage | { type?: string };
    } catch (error) {
      console.error("Realtime message parse failed.", error);
      return;
    }

    if (message.type === "pong" || message.type === "connected") {
      state.lastPongAt = Date.now();
      return;
    }

    if (message.type === "action_result") {
      const result = message as ActionResultMessage;
      const pending = result.clientActionId ? state.pending.get(result.clientActionId) : null;
      if (pending) {
        window.clearTimeout(pending.timer);
        state.pending.delete(result.clientActionId ?? "");
        cleanupTopicStateIfIdle(topic, state);
        if (result.error) {
          pending.reject(new WsActionError("server", result.error));
        } else {
          pending.resolve(result.data);
        }
      }
      return;
    }

    if (message.type === "change") {
      state.lastPongAt = Date.now();
      notifyChangeListeners(state, message as ChangeMessage);
    }
  };

  socket.onclose = () => {
    if (state.socket !== socket) {
      return;
    }

    clearHeartbeat(state);
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
  const payload = (await response.json()) as { data?: T; error?: string };
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "请求游戏服务失败，请稍后重试。");
  }
  return payload.data as T;
}

async function wsAction<T>(topic: string, name: string, args: unknown[]) {
  const state = getTopicState(topic);
  const socket = await waitForSocketOpen(topic, ensureSocket(topic));
  const timeoutMs = getActionTimeoutMs(name);

  const clientActionId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
    });
  });

  try {
    socket.send(JSON.stringify({ type: "action", name, args, clientActionId }));
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
  options: { onOpen?: () => void } = {},
) {
  const state = getTopicState(topic);
  const onOpen = options.onOpen;
  state.listeners.add(listener);
  if (onOpen) {
    state.connectListeners.add(onOpen);
  }
  ensureSocket(topic);
  if (onOpen && state.socket?.readyState === WebSocket.OPEN) {
    window.setTimeout(() => {
      if (state.connectListeners.has(onOpen)) {
        onOpen();
      }
    }, 0);
  }

  return () => {
    state.listeners.delete(listener);
    if (onOpen) {
      state.connectListeners.delete(onOpen);
    }
    cleanupTopicStateIfIdle(topic, state);
  };
}

export function bindGameSessionRealtimeTopic(gameSessionId: string | null | undefined, topic: string | null | undefined) {
  if (!gameSessionId || !topic) {
    return () => undefined;
  }

  gameSessionTopics.set(gameSessionId, topic);

  return () => {
    if (gameSessionTopics.get(gameSessionId) === topic) {
      gameSessionTopics.delete(gameSessionId);
    }
  };
}
